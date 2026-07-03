# 多語會議 → 繁體中文 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 讓「Whisper large + 來源 auto + AI provider + 一鍵『多語會議→繁體』提示詞」能把中／泰／英混合會議音檔輸出成純繁體中文字幕；並讓台灣用詞開關一併作用於譯文。

**Architecture:** LLM 整體處理（模型自己逐行偵測語言＋翻譯＋泰文內部走英文），繁體由「多語系統提示詞 ＋ 既有 `postProcessTarget` 的 `convertChineseText`」保證。主體是內建提示詞常數 ＋ provider 系統提示詞的一鍵預設 UI ＋ 一處後處理一致性修正 ＋ i18n。不動 ASR、不建語言偵測器、不建 MT 樞紐。

**Tech Stack:** TypeScript、Electron（main）、Next.js/React（renderer，`next-i18next`）、既有 `convertChineseText`（OpenCC）、store 設定。

**Spec:** [docs/superpowers/specs/2026-07-03-multilingual-meeting-to-traditional-chinese-design.md](../specs/2026-07-03-multilingual-meeting-to-traditional-chinese-design.md)

## Global Constraints

- 提示詞常數**不得含 `${sourceLanguage}`/`${targetLanguage}`**（避開 `getLanguageName('auto')` 渲染成字面 `auto`）；目標硬寫「台灣繁體中文」。
- 提示詞必須保留 JSON 契約（保留原鍵、鍵數不變、只回純 JSON），以通過 [ai.ts:154-158](../../../main/translate/services/ai.ts#L154) 鍵數校驗。
- **不改** `defaultSystemPrompt`（影響所有既有使用者）。
- i18n：`en/` 與 `zh/` 手寫，`zh-Hant/` 由 `npm run i18n:zh-hant` 生成（**勿手改**）；ProviderForm 的 namespace 為 `translateControl`。
- 譯文後處理讀全局設定 `openccPhraseConversion`（預設關）；`store` 由 `../helpers/storeManager` re-export。
- husky pre-commit 需 `yarn`（本機缺），提交用 `git commit --no-verify`。

---

### Task 1: 多語提示詞常數 + 預設陣列（types/provider.ts）

**Files:**
- Modify: `types/provider.ts`（緊接 `defaultSystemPrompt` 結尾 `;`（~:169）之後）

**Interfaces:**
- Produces: `export const MULTILINGUAL_TO_TRADITIONAL_PROMPT: string`；`export const SYSTEM_PROMPT_PRESETS: { labelKey: string; value: string }[]`

- [ ] **Step 1: 新增常數**

在 `types/provider.ts` 的 `defaultSystemPrompt = \`...\`;`（~:169）之後插入：

```ts
export const MULTILINGUAL_TO_TRADITIONAL_PROMPT = `# Role: 資深多語會議字幕翻譯專家
您精通繁體中文（台灣）、泰語與英語。輸入字幕來自一場混合語言的會議，每一行可能是繁體中文、泰語或英語且交錯出現。您的任務是產出「全部為繁體中文（台灣）」的字幕。

# 逐行語言處理規則：
1. 該行已是中文：保持原意，僅確保為繁體中文（台灣用字用詞），不改寫語氣、不增刪內容。
2. 該行是泰語：準確翻譯為繁體中文（台灣）。可在內部以英語作為理解橋樑，但最終只輸出繁體中文，不得輸出英語或泰語。
3. 該行是英語：翻譯為自然流暢的繁體中文（台灣）。
4. 同行混用多語：整行統一為繁體中文，保持語意完整。

# 品質要求：
1. 保持每條字幕獨立完整，不合併、不拆分。
2. 使用符合台灣說法的口語繁體中文。
3. 專有名詞/人名/術語全段一致；不確定者可保留原文。

# 輸出格式（極重要）：
1. 嚴格按輸入 JSON 格式輸出，保留原始鍵（ID），只翻譯值。
2. 鍵數量不得改變，輸出鍵集合須與輸入完全相同。
3. 不加任何額外文字/註解，只回傳純 JSON，且為合法 JSON。

# Examples
Input:
{"0": "各位早安，今天開會", "1": "สวัสดีครับ ยินดีที่ได้พบทุกคน", "2": "Let's start with the budget"}
Output:
{"0": "各位早安，今天開會", "1": "大家好，很高興見到各位", "2": "我們先從預算開始"}
`;

/** provider 系統提示詞的一鍵預設（labelKey 走 translateControl i18n namespace）。 */
export const SYSTEM_PROMPT_PRESETS: { labelKey: string; value: string }[] = [
  { labelKey: 'promptPreset.default', value: defaultSystemPrompt },
  {
    labelKey: 'promptPreset.multilingualToTraditional',
    value: MULTILINGUAL_TO_TRADITIONAL_PROMPT,
  },
];
```

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 本檔無新增錯誤（常數為純字串；專案既有無關錯誤忽略）。若 tsc 順手改到 `tsconfig.tsbuildinfo`，`git checkout -- tsconfig.tsbuildinfo` 還原。

- [ ] **Step 3: Commit**

```bash
git add types/provider.ts
git commit --no-verify -m "feat(provider): 新增多语会议→繁体提示词常量与预设数组"
```

---

### Task 2: 台灣用詞套用到譯文（translate/index.ts）

**Files:**
- Modify: `main/translate/index.ts:16`（import `store`）、`postProcessTarget`（~:66-79）

**Interfaces:**
- Consumes: `store`（`../helpers/storeManager`）、`convertChineseText`（既有，接受 `{ taiwanPhrase }`）

- [ ] **Step 1: 補 store import**

將 `main/translate/index.ts:16` 改為：

```ts
import { logMessage, store } from '../helpers/storeManager';
```

- [ ] **Step 2: postProcessTarget 帶入 taiwanPhrase**

在 `postProcessTarget` 定義前（`const desiredTargetScript = getDesiredChineseScript(targetLanguage);` 所在區塊，~:66）新增讀取設定，並把轉換呼叫帶上 `{ taiwanPhrase }`。將：

```ts
    if (desiredTargetScript) {
      out = convertChineseText(out, desiredTargetScript).text;
    }
```

改為（先在同一函式作用域可見處，例如 `postProcessTarget` 上方，加入設定讀取）：

```ts
  // 译文台湾用词开关：与 ASR 源字幕一致（全局设置 openccPhraseConversion，默认关）
  const taiwanPhrase = store.get('settings')?.openccPhraseConversion === true;
```

並把轉換呼叫改為：

```ts
    if (desiredTargetScript) {
      out = convertChineseText(out, desiredTargetScript, { taiwanPhrase }).text;
    }
```

- [ ] **Step 3: 型別檢查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: `store`、`{ taiwanPhrase }` 皆可解析，本檔無新增錯誤。還原 `tsconfig.tsbuildinfo` 若被動過。

- [ ] **Step 4: Commit**

```bash
git add main/translate/index.ts
git commit --no-verify -m "feat(translate): 译文简繁归一尊重台湾用词开关"
```

---

### Task 3: i18n 文案（translateControl，en+zh，生成 zh-Hant）

> **重要**：`zh-Hant/` 由 `scripts/gen-zh-hant.mjs` 生成，**勿手改**；只維護 `en/` 與 `zh/`。

**Files:**
- Modify: `renderer/public/locales/en/translateControl.json`、`renderer/public/locales/zh/translateControl.json`（`systemPrompt` 鍵附近）
- Generated: `renderer/public/locales/zh-Hant/translateControl.json`

**Interfaces:**
- Produces: keys `applyPromptPreset`、`promptPreset.default`、`promptPreset.multilingualToTraditional`（namespace `translateControl`）。

- [ ] **Step 1: en**

在 `renderer/public/locales/en/translateControl.json` 的 `"systemPromptTips": ...` 這一鍵**之後**插入（注意前一鍵補逗號）：

```json
  "applyPromptPreset": "Apply template",
  "promptPreset": {
    "default": "Default translation",
    "multilingualToTraditional": "Multilingual meeting → Traditional Chinese"
  },
```

- [ ] **Step 2: zh**

在 `renderer/public/locales/zh/translateControl.json` 的 `"systemPromptTips"` 之後插入：

```json
  "applyPromptPreset": "套用模板",
  "promptPreset": {
    "default": "默认翻译",
    "multilingualToTraditional": "多语会议 → 繁体中文"
  },
```

- [ ] **Step 3: 生成 zh-Hant + 校驗**

Run: `npm run i18n:zh-hant && node scripts/check-i18n.mjs`
Expected: `zh-Hant/translateControl.json` 出現三個新鍵（繁體）；check-i18n 回報 zh↔en 鍵對等、無缺鍵。若 JSON 解析錯，檢查 en/zh 逗號。

- [ ] **Step 4: Commit**

```bash
git add renderer/public/locales/en/translateControl.json renderer/public/locales/zh/translateControl.json renderer/public/locales/zh-Hant/translateControl.json
git commit --no-verify -m "i18n(translateControl): 新增系统提示词预设文案"
```

> 若 `npm run i18n:zh-hant` 順帶重生其他 zh-Hant 檔造成無關 diff（如陣列排版），只 `git add` 上述三個 translateControl.json，其餘用 `git checkout --` 還原。

---

### Task 4: 一鍵預設 UI（ProviderForm.tsx）

在系統提示詞 `<Textarea>` 上方加「套用範本」`<Select>`，選取即填入該預設。

**Files:**
- Modify: `renderer/components/ProviderForm.tsx`（import `SYSTEM_PROMPT_PRESETS`；`renderField` 的 `case 'textarea'`，~:396-405）

**Interfaces:**
- Consumes: `SYSTEM_PROMPT_PRESETS`（Task 1）、i18n keys（Task 3）、既有 `Select*`（已 import，:19-25）、`t`（`useTranslation('translateControl')`，:75）、`onChange`。

- [ ] **Step 1: import 常數**

`types/index.ts` 有 `export * from './provider'`，且 ProviderForm 第 16 行已 `import { ProviderField } from '../../types';`。直接擴充該行：

```ts
import { ProviderField, SYSTEM_PROMPT_PRESETS } from '../../types';
```

- [ ] **Step 2: 特例化 systemPrompt 的 textarea**

將 `renderField` 的 `case 'textarea':`（~:396-405）整段替換為：

```ts
      case 'textarea':
        if (field.key === 'systemPrompt') {
          return (
            <div className="space-y-2">
              <Select
                value=""
                onValueChange={(labelKey) => {
                  const preset = SYSTEM_PROMPT_PRESETS.find(
                    (p) => p.labelKey === labelKey,
                  );
                  if (preset) onChange(field.key, preset.value);
                }}
              >
                <SelectTrigger className="h-8 w-auto">
                  <SelectValue placeholder={t('applyPromptPreset')} />
                </SelectTrigger>
                <SelectContent>
                  {SYSTEM_PROMPT_PRESETS.map((p) => (
                    <SelectItem key={p.labelKey} value={p.labelKey}>
                      {t(p.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Textarea
                id={fieldDomId(field.key)}
                value={value}
                onChange={(e) => onChange(field.key, e.target.value)}
                placeholder={fieldPlaceholder(field.placeholder)}
                rows={3}
              />
            </div>
          );
        }
        return (
          <Textarea
            id={fieldDomId(field.key)}
            value={value}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={fieldPlaceholder(field.placeholder)}
            rows={3}
          />
        );
```

- [ ] **Step 3: 型別檢查 + 手動 UI 驗證**

Run: `npx tsc --noEmit -p tsconfig.json`（本檔無新增錯誤）。還原 `tsconfig.tsbuildinfo` 若被動過。

手動（`npm run dev`，因需 Electron 不可 headless，交由 controller 冒煙）：開一個 AI provider 的編輯表單 → 系統提示詞欄上方出現「套用範本」下拉 → 選「多語會議→繁體中文」→ textarea 即填入該提示詞 → 三語系文案正確。

- [ ] **Step 4: Commit**

```bash
git add renderer/components/ProviderForm.tsx
git commit --no-verify -m "feat(ui): 系统提示词支持一键套用预设模板"
```

---

## Self-Review

**Spec coverage:**
- 內建多語提示詞常數 → Task 1。✓
- 一鍵預設 UI → Task 4（＋ Task 1 常數、Task 3 i18n）。✓
- 用詞開關套到譯文 → Task 2。✓
- i18n → Task 3。✓
- 不改 `defaultSystemPrompt`、提示詞不含 `${sourceLanguage}`、保留 JSON 契約 → Global Constraints + Task 1 常數內容。✓
- 推薦設定（純設定）→ 已在 spec 文件記錄，無需程式碼。✓

**Placeholder scan:** 無 TBD；每個 code step 皆含完整程式碼與位置。UI/譯文因依賴 Electron/store 無自動化，明確標為 tsc + 手動冒煙。

**Type consistency:** `MULTILINGUAL_TO_TRADITIONAL_PROMPT: string`、`SYSTEM_PROMPT_PRESETS: {labelKey,value}[]`、`convertChineseText(text, desired, {taiwanPhrase})`（Phase 1 既有）、i18n keys `promptPreset.*` / `applyPromptPreset` 於 Task 3/4 一致。

**已知取捨：** 本階段無純函式可自動化測試（提示詞為字串、其餘依賴 Electron/store/真實 LLM）；驗證以 tsc + check-i18n + 手動端對端冒煙為主，符合此功能性質（config/prompt）。
