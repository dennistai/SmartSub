# 語音轉寫：原生繁體保留 + 一律繁體歸一

**日期**: 2026-07-03
**狀態**: 設計待審

## 背景與問題

Whisper 對中文一律以 `zh` 送模型（[transcribeShared.ts:22](../../../main/helpers/engines/transcribeShared.ts#L22)），輸出繁體或簡體由模型本身特性決定，與說話者地區無關：

- **Whisper Medium** 原生輸出**繁體**中文。
- **Whisper Large-v3-Turbo** 原生輸出**簡體**中文。

目前轉寫後的字形歸一在 [fileProcessor.ts:420-448](../../../main/helpers/fileProcessor.ts#L420-L448)，用 `getDesiredChineseScript(sourceLanguage)` 決定目標字形，再交給 `convertChineseText`（OpenCC）：

- 選來源語言 `中文 (zh)` → 目標判成**簡體** → Medium 的原生繁體被 OpenCC **t2s 壓回簡體** ❌
- 選來源語言 `繁体中文 (zh-Hant)` → 目標繁體 → 行為正確

**核心需求**：不論模型原生吐簡或繁，語音轉寫產出的中文源字幕**最終一律繁體**；若模型原生已是繁體，就**保留原生用字、不經 OpenCC 轉手**（避免非必要改寫與 OpenCC 對繁體輸入的一對多誤轉風險）。

## 目標

1. 新增全局設定開關「中文轉寫一律輸出繁體」，**預設開啟**。
2. 開啟時：任何中文來源（`zh` / `zh-Hant` 等）的轉寫源字幕，目標字形一律 = 繁體。
3. 以**偵測轉寫結果字形**決定是否跑 OpenCC：
   - 偵測到**繁體**（或中性/無可辨識字）→ **跳過 OpenCC**，保留原生輸出。
   - 偵測到**簡體** → OpenCC `s2t` 轉繁體。
4. **永不**把中文轉寫產物 t2s 成簡體。

## 非目標（範圍外）

- **翻譯**輸出字形（[translate/index.ts](../../../main/translate/index.ts) 依 `targetLanguage` 處理）不在本次改動範圍。
- 大陸用詞 → 台灣用詞的**詞彙**級轉換（需 LLM/校對，另議）。
- 使用者**匯入**的字幕檔（.srt/.vtt…）維持不動，只作用於 ASR/內封提取生成的源字幕。
- 關閉開關時維持現狀（`zh`=簡、`zh-Hant`=繁），不改變既有簡體使用者行為。

## 設計

### 1. 設定項

`ISettings`（[store/types.ts](../../../main/helpers/store/types.ts)）新增：

```ts
/** 中文語音轉寫一律輸出繁體：開啟後，任何中文來源的轉寫源字幕最終歸一為繁體
 *  （原生繁體保留、原生簡體 s2t 轉繁；永不 t2s）。預設開啟。 */
alwaysTraditionalChinese?: boolean;
```

預設值（[store/index.ts](../../../main/helpers/store/index.ts) settings 區塊）：`alwaysTraditionalChinese: true`。

### 2. 字形偵測（新函式）

於 [chineseConvert.ts](../../../main/helpers/chineseConvert.ts) 新增：

```ts
/**
 * 偵測文本主體中文字形。用既有 s2t/t2s 兩向轉換各自「改動的字數」比較：
 * - simplifiedSignal：s2t 會改動的字數（= 簡體專用字數量）
 * - traditionalSignal：t2s 會改動的字數（= 繁體專用字數量）
 * 取較大者為主體字形；兩者接近 0（純中性/ASCII/標點）→ 'unknown'。
 */
export function detectChineseScript(text: string): ChineseScript | 'unknown';
```

實作要點：
- 逐字比較 `text` 與 `s2t(text)`、`text` 與 `t2s(text)`，累計差異字數。
- opencc-js 詞組轉換極少改變長度；若長度不一致，退回以「整體是否改變」為訊號（signal 記為 1）。
- `simplifiedSignal === 0 && traditionalSignal === 0` → `'unknown'`（無中文可辨識字，如純數字/英文）。
- `simplifiedSignal > traditionalSignal` → `'simplified'`；否則 → `'traditional'`（繁體優先，避免把中性/繁體誤判為簡而多轉一次）。

### 3. 目標字形解析（新輔助）

於 [chineseConvert.ts](../../../main/helpers/chineseConvert.ts) 新增（或在 fileProcessor 內聯）：

```ts
/** 結合全局設定解析目標字形：開關開 + 來源為中文 → 一律 'traditional'；
 *  否則沿用 getDesiredChineseScript(sourceLanguage)。 */
export function resolveDesiredChineseScript(
  sourceLanguage: string | undefined,
  alwaysTraditional: boolean,
): ChineseScript | null;
```

邏輯：
```
base = getDesiredChineseScript(sourceLanguage)   // null | 'simplified' | 'traditional'
if (base !== null && alwaysTraditional) return 'traditional'
return base
```

### 4. fileProcessor 歸一流程改寫

[fileProcessor.ts:420-448](../../../main/helpers/fileProcessor.ts#L420-L448) 由「讀取設定 → 解析目標 → 偵測 → 條件轉換」取代原本的無條件 `convertChineseText`：

```ts
if (!isSubtitleFile && shouldGenerateSubtitle && file.srtFile) {
  const settings = store.get('settings');
  const alwaysTraditional = settings?.alwaysTraditionalChinese !== false; // 預設開
  const desiredScript = resolveDesiredChineseScript(sourceLanguage, alwaysTraditional);
  if (desiredScript) {
    try {
      throwIfTaskCancelled();
      const original = await fs.promises.readFile(file.srtFile, 'utf-8');
      const detected = detectChineseScript(original);
      // 偵測已是目標字形（或中性 unknown）→ 保留原生，跳過 OpenCC
      if (detected !== 'unknown' && detected !== desiredScript) {
        const { text, converted } = convertChineseText(original, desiredScript);
        if (converted) {
          await fs.promises.writeFile(file.srtFile, text, 'utf-8');
          logMessage(`normalized source subtitle to ${desiredScript} (from ${detected}): ${fileName}`, 'info');
        }
      } else {
        logMessage(`source subtitle already ${desiredScript} (native), skip OpenCC: ${fileName}`, 'info');
      }
    } catch (error) {
      if (isTaskCancelledError(error) || isTaskCancelled()) throw error;
      logMessage(`chinese script normalization failed: ${error}`, 'warning');
    }
  }
}
```

需在 fileProcessor 匯入 `store`（`from './storeManager'`，已 re-export）與新函式。

`removeChinesePunctuation` 兩處閘門（[fileProcessor.ts:457](../../../main/helpers/fileProcessor.ts#L457)、[:485](../../../main/helpers/fileProcessor.ts#L485)）維持用 `getDesiredChineseScript(sourceLanguage)` 判「是否中文」即可，不受影響。

### 5. UI 開關

於 [AdvancedSheet.tsx](../../../renderer/components/tasks/AdvancedSheet.tsx) 辨識區（`section.recognition`）在 `reduceRepetition` 卡片後，仿其模式新增：
- `useState` + 進場 `getSettings` 讀取（`s?.alwaysTraditionalChinese !== false`）。
- `Switch` 的 `onCheckedChange` → `setSettings({ alwaysTraditionalChinese: checked })`。
- 文案走 `t('alwaysTraditionalChinese.*')`（tasks 命名空間）。

### 6. i18n

三份 `tasks.json`（[en](../../../renderer/public/locales/en/tasks.json)、[zh](../../../renderer/public/locales/zh/tasks.json)、[zh-Hant](../../../renderer/public/locales/zh-Hant/tasks.json)）新增 `alwaysTraditionalChinese` 區塊：`label` / `on` / `off` / `hint`，語意說明「開啟後中文語音轉寫一律輸出繁體，原生繁體保留、原生簡體轉繁，永不轉簡」。

## 資料流

```
音訊 → Whisper(zh) → 源 SRT
                       │
         alwaysTraditionalChinese 開？來源為中文？
                       │ 是
              detectChineseScript(SRT)
              ├─ traditional / unknown → 保留原生（跳過 OpenCC）
              └─ simplified            → OpenCC s2t → 繁體
                       │
                  最終源字幕（一律繁體）
```

## 測試

`main/helpers/__tests__/`（既有測試目錄）新增：

1. `detectChineseScript`：
   - 純繁體樣本 → `'traditional'`
   - 純簡體樣本 → `'simplified'`
   - 純數字/英文/標點 → `'unknown'`
   - 繁簡混合、以繁為主 → `'traditional'`
2. `resolveDesiredChineseScript`：
   - 開關開 + `zh` → `'traditional'`
   - 開關開 + `zh-Hant` → `'traditional'`
   - 開關關 + `zh` → `'simplified'`；+ `zh-Hant` → `'traditional'`
   - 非中文 → `null`（不論開關）
3. fileProcessor 歸一分支（可用既有測試風格 mock fs）：
   - Medium 原生繁體 + 開關開 + `zh` → 檔案不被改寫（跳過 OpenCC）
   - Turbo 簡體 + 開關開 + `zh` → 轉為繁體

## 決策記錄

- **偵測 vs 模型白名單**：選偵測轉寫結果字形 — 與模型解耦、免維護清單、未來新模型自動適用。
- **觸發範圍**：選全局設定開關（預設開）— 一致給繁體，同時保留少數需簡體時的彈性，不硬改 `zh` 語意。
- **繁體優先的 tie-break**：偵測 `simplified` 嚴格需 `simplifiedSignal > traditionalSignal`，中性/相等一律當繁體處理，貫徹「永不轉簡」。
