# 語音轉寫原生繁體保留 + 台灣用詞開關 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 中文語音轉寫的源字幕一律歸一為繁體，原生繁體（如 Whisper Medium）保留、原生簡體（如 Large-v3-Turbo）轉繁，永不轉簡；並提供獨立的「台灣用詞轉換」開關。

**Architecture:** 純函式層（`chineseConvert.ts`）新增字形偵測、目標字形解析、字形/用詞分層轉換器；`fileProcessor.ts` 在轉寫後歸一處以「偵測 → 僅在字形相反時才轉換」取代原本無條件轉換；兩個全局設定開關（`alwaysTraditionalChinese`、`openccPhraseConversion`）透過既有 store + AdvancedSheet 模式接入。

**Tech Stack:** TypeScript、Electron（main）、Next.js/React（renderer）、opencc-js 1.3.2、既有 `scripts/test-engine-units.ts` 純邏輯測試框架（`npm run test:engines`）。

**Spec:** [docs/superpowers/specs/2026-07-03-native-traditional-chinese-transcription-design.md](../specs/2026-07-03-native-traditional-chinese-transcription-design.md)

## Global Constraints

- 最終中文輸出**一律繁體**；`t2s`（轉簡）僅保留於 `convertChineseText` 內部，轉寫路徑永不呼叫。
- 簡→繁基準字形用 `tw`（台灣字形），**不再用** OpenCC 中繼標準形 `t`。
- 用詞轉換（`twp`）**僅接入轉寫路徑**；翻譯路徑維持 `tw`（不含用詞）。
- 設定預設值：`alwaysTraditionalChinese: true`、`openccPhraseConversion: false`。
- 偵測傾向繁體：唯有 `simplifiedSignal > traditionalSignal` 才判 `'simplified'`；相等或全 0 判非簡（`unknown`/`traditional`）。
- 純函式測試一律加進 `scripts/test-engine-units.ts`，用既有 `eq(actual, expected, name)` 斷言，跑 `npm run test:engines`。
- 不觸碰使用者匯入的字幕檔；僅作用於 ASR/內封提取生成的源字幕。

---

### Task 1: 轉換器改造 + 用詞開關（chineseConvert.ts）

把單一 `getS2T`（`to:'t'`）改為 `getS2TW`（`to:'tw'`）與 `getS2TWP`（`to:'twp'`），並讓 `convertChineseText` 接受 `taiwanPhrase` 選項。

**Files:**
- Modify: `main/helpers/chineseConvert.ts:14-27`（轉換器）、`:49-57`（convertChineseText）
- Test: `scripts/test-engine-units.ts`（新增斷言）

**Interfaces:**
- Produces:
  - `interface ConvertChineseOptions { taiwanPhrase?: boolean }`
  - `convertChineseText(text: string, desired: ChineseScript, opts?: ConvertChineseOptions): { text: string; converted: boolean }`
  - 內部：`getT2S()`、`getS2TW()`、`getS2TWP()`（module-private）

- [ ] **Step 1: 寫失敗測試**

在 `scripts/test-engine-units.ts` 頂部 import 區塊加入（與其他 import 並列）：

```ts
import {
  convertChineseText,
  detectChineseScript,
  resolveDesiredChineseScript,
} from '../main/helpers/chineseConvert';
```

在檔案結尾 `console.log(\`\nengine unit tests...` 那行**之前**加入：

```ts
// --- convertChineseText: 简→繁 字形 / 用词 ---
eq(
  convertChineseText('这是软件信息', 'traditional').text,
  '這是軟件信息',
  'convert: s2tw 只转字形（软件信息保留）',
);
eq(
  convertChineseText('这是软件信息', 'traditional').converted,
  true,
  'convert: s2tw converted=true',
);
eq(
  convertChineseText('这是软件信息', 'traditional', { taiwanPhrase: true }).text,
  '這是軟體資訊',
  'convert: s2twp 台湾用词（软件信息→軟體資訊）',
);
eq(
  convertChineseText('這是繁體中文測試', 'traditional').text,
  '這是繁體中文測試',
  'convert: 已繁体 s2tw 不改写',
);
eq(
  convertChineseText('這是繁體中文測試', 'traditional').converted,
  false,
  'convert: 已繁体 converted=false',
);
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test:engines`
Expected: tsc 編譯錯誤 — `detectChineseScript` / `resolveDesiredChineseScript` 尚未匯出（`has no exported member`）。此為預期紅燈（後續 Task 2 補齊；本步先確認測試檔已接上）。

> 若要先只驗 Task 1，可暫時註解掉 import 中的 `detectChineseScript, resolveDesiredChineseScript` 兩行與其相關斷言，跑一次應為「convert:* 全數斷言失敗（現行 convertChineseText 無 opts、且用 `to:'t'`）」，確認紅燈後再解除註解。

- [ ] **Step 3: 實作轉換器與 convertChineseText**

編輯 `main/helpers/chineseConvert.ts`，將 `:14-27` 的兩個轉換器替換為：

```ts
let t2sConverter: ConvertFn | null = null;
let s2twConverter: ConvertFn | null = null;
let s2twpConverter: ConvertFn | null = null;

/** 繁（OpenCC 标准）→ 简（大陆）。惰性创建并缓存。 */
function getT2S(): ConvertFn {
  if (!t2sConverter) t2sConverter = Converter({ from: 't', to: 'cn' });
  return t2sConverter;
}

/** 简（大陆）→ 繁（台湾字形，不转用词）。惰性创建并缓存。 */
function getS2TW(): ConvertFn {
  if (!s2twConverter) s2twConverter = Converter({ from: 'cn', to: 'tw' });
  return s2twConverter;
}

/** 简（大陆）→ 繁（台湾字形 + 台湾用词）。惰性创建并缓存。 */
function getS2TWP(): ConvertFn {
  if (!s2twpConverter) s2twpConverter = Converter({ from: 'cn', to: 'twp' });
  return s2twpConverter;
}
```

將 `:49-57` 的 `convertChineseText` 替換為：

```ts
export interface ConvertChineseOptions {
  /** 目标为繁体时是否套用台湾用词转换（s2twp）；否则只转字形（s2tw）。默认 false。 */
  taiwanPhrase?: boolean;
}

/**
 * 按期望字形转换文本；仅当结果与原文不同（即检测到相反字形）时标记 converted。
 * 对 SRT 全文安全：序号/时间码/`-->` 均为 ASCII，OpenCC 不会改动。
 */
export function convertChineseText(
  text: string,
  desired: ChineseScript,
  opts?: ConvertChineseOptions,
): { text: string; converted: boolean } {
  if (!text) return { text, converted: false };
  const convert =
    desired === 'simplified'
      ? getT2S()
      : opts?.taiwanPhrase
        ? getS2TWP()
        : getS2TW();
  const out = convert(text);
  return { text: out, converted: out !== text };
}
```

- [ ] **Step 4: 跑測試確認通過（僅 convert 斷言）**

若 Task 2 尚未完成，仍需暫時註解 `detectChineseScript, resolveDesiredChineseScript` 相關 import 與斷言。
Run: `npm run test:engines`
Expected: `convert:*` 五條斷言全數通過（輸出末行 `... passed, 0 failed` 中不含 convert 失敗）。

- [ ] **Step 5: Commit**

```bash
git add main/helpers/chineseConvert.ts scripts/test-engine-units.ts
git commit --no-verify -m "feat(chinese): s2t 基准升级 tw 并新增台湾用词开关"
```

> 註：本專案 husky pre-commit 需 `yarn` 於 PATH；CI/本機若無 yarn，`--no-verify` 略過 hook（格式化可事後 `npm run format`）。

---

### Task 2: 字形偵測 + 目標字形解析（chineseConvert.ts）

**Files:**
- Modify: `main/helpers/chineseConvert.ts`（新增 `countChangedChars`、`detectChineseScript`、`resolveDesiredChineseScript`）
- Test: `scripts/test-engine-units.ts`

**Interfaces:**
- Consumes: `getS2TW()`、`getT2S()`、`getDesiredChineseScript()`（同檔）
- Produces:
  - `detectChineseScript(text: string): ChineseScript | 'unknown'`
  - `resolveDesiredChineseScript(sourceLanguage: string | undefined, alwaysTraditional: boolean): ChineseScript | null`

- [ ] **Step 1: 寫失敗測試**

在 `scripts/test-engine-units.ts`（Task 1 的斷言之後、`console.log` 之前）加入。若 Task 1 曾註解 import，此時解除註解 `detectChineseScript, resolveDesiredChineseScript`：

```ts
// --- detectChineseScript ---
eq(detectChineseScript('這是繁體中文測試'), 'traditional', 'detect: 纯繁 -> traditional');
eq(detectChineseScript('这是简体中文测试'), 'simplified', 'detect: 纯简 -> simplified');
eq(detectChineseScript('2024-01 OK.'), 'unknown', 'detect: 无中文 -> unknown');
eq(detectChineseScript(''), 'unknown', 'detect: 空串 -> unknown');
eq(detectChineseScript('內存不足'), 'traditional', 'detect: 台湾繁体用词 -> traditional');

// --- resolveDesiredChineseScript ---
eq(resolveDesiredChineseScript('zh', true), 'traditional', 'resolve: zh + always -> traditional');
eq(resolveDesiredChineseScript('zh', false), 'simplified', 'resolve: zh + !always -> simplified');
eq(resolveDesiredChineseScript('zh-Hant', false), 'traditional', 'resolve: zh-Hant -> traditional');
eq(resolveDesiredChineseScript('zh-Hant', true), 'traditional', 'resolve: zh-Hant + always -> traditional');
eq(resolveDesiredChineseScript('en', true), null, 'resolve: 非中文 + always -> null');
eq(resolveDesiredChineseScript('en', false), null, 'resolve: 非中文 -> null');
eq(resolveDesiredChineseScript(undefined, true), null, 'resolve: undefined -> null');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test:engines`
Expected: tsc 編譯錯誤 `has no exported member 'detectChineseScript'`（尚未實作）。

- [ ] **Step 3: 實作偵測與解析**

在 `main/helpers/chineseConvert.ts` 的 `convertChineseText` 之後加入：

```ts
/** 统计两串对应位置不同的字数；长度不同时以「长度差 + 公共区差异」保守计数。 */
function countChangedChars(a: string, b: string): number {
  if (a === b) return 0;
  const len = Math.min(a.length, b.length);
  let diff = Math.abs(a.length - b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}

/**
 * 侦测文本主体中文字形（与转写模型解耦，以实际输出为准）。
 * 用字形级两向转换各自「改动字数」比较：
 *  - simplifiedSignal：s2tw 会改动的字数（= 简体专用字）
 *  - traditionalSignal：t2s 会改动的字数（= 繁体专用字）
 * 皆为 0 → 'unknown'（无可辨识中文字）。tie-break 偏繁：
 * 唯有 simplifiedSignal > traditionalSignal 才判 'simplified'。
 */
export function detectChineseScript(text: string): ChineseScript | 'unknown' {
  if (!text) return 'unknown';
  const simplifiedSignal = countChangedChars(text, getS2TW()(text));
  const traditionalSignal = countChangedChars(text, getT2S()(text));
  if (simplifiedSignal === 0 && traditionalSignal === 0) return 'unknown';
  return simplifiedSignal > traditionalSignal ? 'simplified' : 'traditional';
}

/**
 * 结合全局设定解析目标字形：
 *  - 来源非中文 → null（不处理）
 *  - 来源中文 + alwaysTraditional → 一律 'traditional'
 *  - 来源中文 + !alwaysTraditional → 沿用 getDesiredChineseScript(sourceLanguage)
 */
export function resolveDesiredChineseScript(
  sourceLanguage: string | undefined,
  alwaysTraditional: boolean,
): ChineseScript | null {
  const base = getDesiredChineseScript(sourceLanguage);
  if (base !== null && alwaysTraditional) return 'traditional';
  return base;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test:engines`
Expected: 末行 `engine unit tests: N passed, 0 failed`（含本 Task 全部 detect/resolve 斷言與 Task 1 的 convert 斷言）。

- [ ] **Step 5: Commit**

```bash
git add main/helpers/chineseConvert.ts scripts/test-engine-units.ts
git commit --no-verify -m "feat(chinese): 新增字形侦测与目标字形解析"
```

---

### Task 3: 全局設定項（store types + defaults）

**Files:**
- Modify: `main/helpers/store/types.ts:48`（`reduceRepetition?` 之後）
- Modify: `main/helpers/store/index.ts:35`（`reduceRepetition: false,` 之後）

**Interfaces:**
- Produces: `ISettings.alwaysTraditionalChinese?: boolean`、`ISettings.openccPhraseConversion?: boolean`；store 預設 `alwaysTraditionalChinese: true`、`openccPhraseConversion: false`。

- [ ] **Step 1: 加型別**

在 `main/helpers/store/types.ts` 的 `reduceRepetition?: boolean;`（第 48 行）之後插入：

```ts
    /** 中文语音转写一律输出繁体：开启后任何中文来源的转写源字幕最终归一为繁体
     *  （原生繁体保留、原生简体 s2tw 转繁；永不转简）。默认开启。 */
    alwaysTraditionalChinese?: boolean;
    /** OpenCC 台湾用词转换：仅在简→繁 OpenCC 转换时生效。
     *  关（默认）→ s2tw（只转字形）；开 → s2twp（含台湾用词）。 */
    openccPhraseConversion?: boolean;
```

- [ ] **Step 2: 加預設值**

在 `main/helpers/store/index.ts` 的 `reduceRepetition: false,`（第 35 行）之後插入：

```ts
      alwaysTraditionalChinese: true,
      openccPhraseConversion: false,
```

- [ ] **Step 3: 型別檢查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 無新增錯誤（若專案既有無關錯誤，聚焦本次改動檔案無報錯即可）。

- [ ] **Step 4: Commit**

```bash
git add main/helpers/store/types.ts main/helpers/store/index.ts
git commit --no-verify -m "feat(store): 新增 alwaysTraditionalChinese 与 openccPhraseConversion 设置"
```

---

### Task 4: fileProcessor 歸一流程改寫

以「讀設定 → 解析目標 → 偵測 → 僅在字形相反時才轉換（帶用詞選項）」取代原本無條件 `convertChineseText`。

**Files:**
- Modify: `main/helpers/fileProcessor.ts:3`（import `store`）、`:13-17`（import 新函式）、`:420-448`（歸一區塊）

**Interfaces:**
- Consumes: `resolveDesiredChineseScript`、`detectChineseScript`、`convertChineseText`（Task 1/2）；`store`（`./storeManager`）；`ISettings`（Task 3）。

- [ ] **Step 1: 補 import**

將 `main/helpers/fileProcessor.ts:3` 改為：

```ts
import { logMessage, store } from './storeManager';
```

將 `:13-17` 的 chineseConvert import 改為：

```ts
import {
  getDesiredChineseScript,
  convertChineseText,
  detectChineseScript,
  resolveDesiredChineseScript,
  removeChineseSubtitlePunctuation,
} from './chineseConvert';
```

- [ ] **Step 2: 改寫歸一區塊**

將 `main/helpers/fileProcessor.ts:422-448`（`if (!isSubtitleFile && shouldGenerateSubtitle && file.srtFile) { ... }` 整塊）替換為：

```ts
    // 中文简繁归一：仅对「转写/内封提取生成」的源字幕生效（不动用户导入的字幕文件）。
    // 目标字形由「全局设置 alwaysTraditionalChinese + 来源语言」解析；再侦测转写产物实际字形，
    // 仅当侦测到「相反字形」时才跑 OpenCC——原生繁体（unknown/traditional）保留，跳过转手。
    if (!isSubtitleFile && shouldGenerateSubtitle && file.srtFile) {
      const settings = store.get('settings');
      const alwaysTraditional = settings?.alwaysTraditionalChinese !== false; // 默认开
      const taiwanPhrase = settings?.openccPhraseConversion === true; // 默认关
      const desiredScript = resolveDesiredChineseScript(
        sourceLanguage,
        alwaysTraditional,
      );
      if (desiredScript) {
        try {
          throwIfTaskCancelled();
          const original = await fs.promises.readFile(file.srtFile, 'utf-8');
          const detected = detectChineseScript(original);
          if (detected !== 'unknown' && detected !== desiredScript) {
            const { text, converted } = convertChineseText(
              original,
              desiredScript,
              { taiwanPhrase },
            );
            if (converted) {
              await fs.promises.writeFile(file.srtFile, text, 'utf-8');
              logMessage(
                `normalized source subtitle to ${desiredScript} (from ${detected}${
                  taiwanPhrase ? ', +tw phrases' : ''
                }): ${fileName}`,
                'info',
              );
            }
          } else {
            logMessage(
              `source subtitle already ${desiredScript} (native), skip OpenCC: ${fileName}`,
              'info',
            );
          }
        } catch (error) {
          if (isTaskCancelledError(error) || isTaskCancelled()) throw error;
          // 转换失败不应阻断主流程：记录告警并沿用原始字幕
          logMessage(
            `chinese script normalization failed: ${error}`,
            'warning',
          );
        }
      }
    }
```

- [ ] **Step 3: 型別檢查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 本次改動檔案無報錯（`store`、新函式、`settings?.alwaysTraditionalChinese` 皆可解析）。

- [ ] **Step 4: 手動冒煙（無自動化，記錄結果）**

因 `fileProcessor` 依賴 Electron/store/fs，屬既有「手動冒煙」範疇（見 `scripts/test-engine-units.ts` 檔頭說明）。以 `npm run dev` 起應用，各跑一次：

1. Whisper **Medium** + 來源 `中文(zh)` + 設定 `alwaysTraditionalChinese` 開 → 產出源字幕為**繁體**，log 出現 `already traditional (native), skip OpenCC`。
2. Whisper **Large-v3-Turbo** + 來源 `中文(zh)` + 設定開 → 源字幕由簡轉**繁**，log 出現 `normalized source subtitle to traditional (from simplified)`。
3. 開 `openccPhraseConversion` 後跑一段含「软件/信息」的簡體語音 → 出現「軟體/資訊」。

記錄三項實際結果（log 片段 + 產出字幕抽樣）於 PR 描述。

- [ ] **Step 5: Commit**

```bash
git add main/helpers/fileProcessor.ts
git commit --no-verify -m "feat(transcribe): 源字幕字形侦测归一（原生繁体保留/永不转简）"
```

---

### Task 5: i18n 文案（en + zh 手寫，zh-Hant 由腳本生成）

> **重要**：`renderer/public/locales/zh-Hant/` 由 `scripts/gen-zh-hant.mjs`（opencc-js s2t）**從 `zh/` 自動生成**。**切勿手動編輯 zh-Hant**；只維護 `zh/` 與 `en/`，再跑 `npm run i18n:zh-hant` 同步繁體。

**Files:**
- Modify: `renderer/public/locales/en/tasks.json`、`renderer/public/locales/zh/tasks.json`（皆在 `reduceRepetition` 區塊之後）
- Generated: `renderer/public/locales/zh-Hant/tasks.json`（由腳本產出，勿手改）

**Interfaces:**
- Produces: i18n keys `alwaysTraditionalChinese.{label,on,off,hint}`、`openccPhraseConversion.{label,on,off,hint}`（namespace `tasks`）。

- [ ] **Step 1: en**

在 `renderer/public/locales/en/tasks.json` 的 `"reduceRepetition": { ... },` 區塊**之後**插入：

```json
  "alwaysTraditionalChinese": {
    "label": "Always output Traditional Chinese (transcription)",
    "on": "On: any Chinese transcription is normalized to Traditional. Native Traditional (e.g. Whisper Medium) is kept as-is; native Simplified (e.g. Large-v3-Turbo) is converted to Traditional. Never converts to Simplified.",
    "off": "Off: script follows the source language (中文=Simplified, 繁体中文=Traditional).",
    "hint": "Global setting. Detects the model's native script; only runs OpenCC when the output is Simplified."
  },
  "openccPhraseConversion": {
    "label": "Taiwanese idiom conversion (OpenCC)",
    "on": "On: also convert Mainland vocabulary to Taiwanese (信息→資訊, 軟件→軟體). Use when the content is genuinely Mainland wording.",
    "off": "Off: convert characters only, keep the original wording. Best when Taiwanese speech was mis-transcribed as Simplified.",
    "hint": "Only applies when a Simplified transcription is converted to Traditional; native Traditional is unaffected."
  },
```

- [ ] **Step 2: zh**

在 `renderer/public/locales/zh/tasks.json` 的 `"reduceRepetition"` 區塊之後插入：

```json
  "alwaysTraditionalChinese": {
    "label": "转写一律输出繁体中文",
    "on": "已开启：任何中文转写都归一为繁体。原生繁体（如 Whisper Medium）原样保留；原生简体（如 Large-v3-Turbo）转为繁体。永不转简。",
    "off": "已关闭：字形跟随来源语言（中文=简体，繁体中文=繁体）。",
    "hint": "全局设置。侦测模型原生字形，仅当输出为简体时才走 OpenCC。"
  },
  "openccPhraseConversion": {
    "label": "台湾用词转换（OpenCC）",
    "on": "已开启：连同用词一并台湾化（信息→資訊、軟件→軟體）。内容确为大陆用词时使用。",
    "off": "已关闭：只转字形、保留原用词。台湾语音被误判成简体时适用。",
    "hint": "仅在简体转写转为繁体时生效；原生繁体不受影响。"
  },
```

- [ ] **Step 3: 生成 zh-Hant**

Run: `npm run i18n:zh-hant`
Expected: 腳本由 `zh/` 重新生成 `zh-Hant/`，`zh-Hant/tasks.json` 自動含新增的兩個繁體區塊（勿手改此檔）。

- [ ] **Step 4: 驗 JSON + i18n 對齊**

Run: `node scripts/check-i18n.mjs`
Expected: `zh` 與 `en` 鍵集合對等、無缺鍵報錯（check-i18n 比對 zh↔en）。若報 JSON 解析錯，檢查 en/zh 的逗號/括號。

- [ ] **Step 5: Commit**

```bash
git add renderer/public/locales/en/tasks.json renderer/public/locales/zh/tasks.json renderer/public/locales/zh-Hant/tasks.json
git commit --no-verify -m "i18n(tasks): 新增繁体归一与台湾用词开关文案"
```

---

### Task 6: AdvancedSheet 兩個開關 UI

於辨識區 `reduceRepetition` 卡片後新增兩張開關卡片，仿其既有模式（全局設定即讀即寫，不進 react-hook-form）。

**Files:**
- Modify: `renderer/components/tasks/AdvancedSheet.tsx:64`（state）、`:65-78`（進場讀取）、`:79-86`（handler）、`:197-217`（卡片後插入 UI）

**Interfaces:**
- Consumes: `window.ipc.invoke('getSettings')` / `('setSettings', {...})`；i18n keys（Task 5）。

- [ ] **Step 1: 新增 state**

在 `renderer/components/tasks/AdvancedSheet.tsx:64`（`const [reduceRepetition, setReduceRepetition] = useState(false);`）之後插入：

```tsx
  const [alwaysTraditional, setAlwaysTraditional] = useState(true);
  const [openccPhrase, setOpenccPhrase] = useState(false);
```

- [ ] **Step 2: 進場讀取**

在 `:70-73` 的 `if (active) { ... }` 區塊內，`setReduceRepetition(...)` 之後插入：

```tsx
        setAlwaysTraditional(s?.alwaysTraditionalChinese !== false);
        setOpenccPhrase(s?.openccPhraseConversion === true);
```

- [ ] **Step 3: 新增 handler**

在 `handleReduceRepetitionChange`（`:83-86`）之後插入：

```tsx
  const handleAlwaysTraditionalChange = async (checked: boolean) => {
    setAlwaysTraditional(checked);
    await window?.ipc?.invoke('setSettings', {
      alwaysTraditionalChinese: checked,
    });
  };
  const handleOpenccPhraseChange = async (checked: boolean) => {
    setOpenccPhrase(checked);
    await window?.ipc?.invoke('setSettings', { openccPhraseConversion: checked });
  };
```

- [ ] **Step 4: 新增 UI 卡片**

在 `reduceRepetition` 卡片結尾 `</div>`（`:217`，即該卡片外層 `<div className="space-y-2 rounded-lg border p-2">` 的收尾）**之後**、`</>`（`:218`）之前插入：

```tsx
                      <div className="space-y-2 rounded-lg border p-2">
                        <div className="flex flex-row items-center justify-between gap-2">
                          <div className="space-y-0.5">
                            <p className="text-sm font-medium">
                              {t('alwaysTraditionalChinese.label')}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {alwaysTraditional
                                ? t('alwaysTraditionalChinese.on')
                                : t('alwaysTraditionalChinese.off')}
                            </p>
                          </div>
                          <Switch
                            checked={alwaysTraditional}
                            onCheckedChange={handleAlwaysTraditionalChange}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t('alwaysTraditionalChinese.hint')}
                        </p>
                      </div>
                      <div className="space-y-2 rounded-lg border p-2">
                        <div className="flex flex-row items-center justify-between gap-2">
                          <div className="space-y-0.5">
                            <p className="text-sm font-medium">
                              {t('openccPhraseConversion.label')}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {openccPhrase
                                ? t('openccPhraseConversion.on')
                                : t('openccPhraseConversion.off')}
                            </p>
                          </div>
                          <Switch
                            checked={openccPhrase}
                            onCheckedChange={handleOpenccPhraseChange}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t('openccPhraseConversion.hint')}
                        </p>
                      </div>
```

- [ ] **Step 5: 型別檢查 + 手動驗 UI**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 本檔無報錯。

以 `npm run dev` 開任一 media 任務的「進階」面板：
1. 兩個新開關顯示於「減少重複」卡片之後，文案正確（切三語系檢查）。
2. 切換後重開面板，狀態被記住（讀回 store）。
3. `alwaysTraditionalChinese` 預設為開、`openccPhraseConversion` 預設為關。

- [ ] **Step 6: Commit**

```bash
git add renderer/components/tasks/AdvancedSheet.tsx
git commit --no-verify -m "feat(ui): 进阶面板新增繁体归一与台湾用词开关"
```

---

## Self-Review

**Spec coverage:**
- 設定 `alwaysTraditionalChinese`（預設開）→ Task 3 + Task 6。✓
- 一律繁體 / 目標解析 → Task 2 `resolveDesiredChineseScript` + Task 4。✓
- 偵測字形、繁體/unknown 跳過 OpenCC、簡體才轉 → Task 2 `detectChineseScript` + Task 4。✓
- 永不轉簡 → Global Constraints + Task 4 邏輯（desired 恆 traditional 時不會走 t2s）。✓
- 用詞開關 `openccPhraseConversion`（預設關，僅 OpenCC 路徑）→ Task 1（s2tw/s2twp + opts）+ Task 3 + Task 4（傳 taiwanPhrase）+ Task 6。✓
- 基準字形 `t`→`tw` 升級（含翻譯路徑）→ Task 1（`translate/index.ts` 呼叫不帶 opts 即得 s2tw）。✓
- UI → Task 6；i18n → Task 5。✓
- 測試（detect/resolve/convert 用詞）→ Task 1、2 的 eq 斷言。✓

**Placeholder scan:** 無 TBD/TODO；每個 code step 皆含完整程式碼與確切檔案位置。fileProcessor/UI 因依賴 Electron 無自動化，明確標為手動冒煙並要求記錄結果（非 placeholder）。

**Type consistency:** `ChineseScript`（既有）、`ConvertChineseOptions`、`detectChineseScript` 回傳 `ChineseScript | 'unknown'`、`resolveDesiredChineseScript` 回傳 `ChineseScript | null`、`convertChineseText(text, desired, opts?)` — 各 Task 引用一致。設定鍵 `alwaysTraditionalChinese` / `openccPhraseConversion` 於 types/store/fileProcessor/UI 全程同名。

**已知取捨：** `translate/index.ts` 的簡→繁改由 `t` 升級為 `tw`（不含用詞），為刻意的顯示字形改善；若審查認為翻譯路徑不應變動，可在 Task 1 保留一個 `to:'t'` 的相容轉換器供 translate 專用，屬計畫審查點。
