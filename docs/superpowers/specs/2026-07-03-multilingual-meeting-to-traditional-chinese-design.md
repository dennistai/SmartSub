# Phase 2：多語會議（中／泰／英）→ 繁體中文 設計

**日期**: 2026-07-03
**狀態**: 設計待審（Phase 1 已合併）

## 背景與問題

同一場會議音檔常同時出現三種語言：台灣繁體中文、泰文、英文（雙方懂英文者常以英文溝通，或英文充當翻譯橋樑）。使用者要一份**全繁體中文**的字幕／逐字稿。這是接續 [Phase 1](2026-07-03-native-traditional-chinese-transcription-design.md)（中文字形歸繁＋台灣用詞開關）的下一階段。

探索後確認兩個現實，鎖定做法：

- **ASR 硬限制**：所有轉寫引擎單檔只鎖一種語言，無任何引擎回傳逐段語言。SenseVoice 內部有逐段語言 ID 但 worker 丟棄、且**不支援泰文**；faster-whisper 只有檔案級偵測語言（用完即丟）；Whisper 的 translate-task 在 [builtinEngine.ts](../../../main/helpers/engines/builtinEngine.ts) 寫死關閉。
- **翻譯**：目前無樞紐翻譯（單一 source→target），但對 **LLM provider** 而言，混合輸入 → 繁體中文**不需要**樞紐 —— LLM 自己逐行偵測語言、翻譯、泰文必要時內部走英文，最終再由既有 `convertChineseText` 後處理保證繁體。

## 鎖定的決策

1. 翻譯引擎：**LLM 整體處理**（OpenAI 等 `isAi` provider）。不建逐段語言偵測、不建機器翻譯兩段式樞紐。
2. ASR：**Whisper large + 語言 auto**。接受泰文段品質依模型而定，不做逐段轉寫。
3. 提示詞交付：**內建一鍵預設**（provider 系統提示詞 UI 可選套用）。
4. 台灣用詞開關 `openccPhraseConversion` **一併套用到譯文**（不只 ASR 來源）。

## 關鍵洞察

`sourceLanguage=auto` 時 Phase 1 的來源正規化區塊會**跳過** —— `getDesiredChineseScript('auto')` 回 `null`（[chineseConvert.ts:42-50](../../../main/helpers/chineseConvert.ts#L42)），`resolveDesiredChineseScript` 回 `null`，[fileProcessor.ts:433](../../../main/helpers/fileProcessor.ts#L433) 的 `if (desiredScript)` 為假。因此在 auto 配方下，繁體保證完全由「**多語系統提示詞** ＋ 譯文後處理 **postProcessTarget**」（[translate/index.ts:66-79](../../../main/translate/index.ts#L66)）承擔，後者對每一行譯文以 `convertChineseText` 強制繁體。

## 非目標

- 不改 ASR 引擎、不做 diarization/逐段重跑轉寫。
- 不建內容級語言偵測器（LLM 路徑不需要）。
- 不建機器翻譯的 th→en→zh 兩段式樞紐（樞紐由 LLM 內部處理）。
- 不改全局 `defaultSystemPrompt`（避免影響既有使用者）。
- 不做提示詞偏好的持久化/管理系統（僅一鍵套用）。

## 設計

### 1. 內建多語提示詞常數
於 [types/provider.ts](../../../types/provider.ts)（緊接 `defaultSystemPrompt` 之後）新增 `export const MULTILINGUAL_TO_TRADITIONAL_PROMPT`。要點：
- 指示 LLM 逐行判斷中／泰／英：中文保留原意僅確保繁體；泰文準確翻譯、可內部以英文為橋、最終只輸出繁體；英文翻成自然繁體；混語行整行統一繁體。
- **刻意不含 `${sourceLanguage}`**：避開 `getLanguageName('auto')` 渲染成字面 `auto` 的問題（[ai.ts:25-45](../../../main/translate/services/ai.ts#L25)；[utils.ts:153-160](../../../main/helpers/utils.ts#L153) 的 `renderTemplate` 只替換有給的鍵）。硬寫目標為「台灣繁體中文」，不依賴 `${targetLanguage}`。
- 嚴格保留 JSON 鍵與數量，以通過 AI 批次鍵數校驗（[ai.ts:154-158](../../../main/translate/services/ai.ts#L154)）。附一組三語 in/out 範例。

提示詞全文見〈附錄〉。

### 2. 一鍵預設 UI（provider 系統提示詞）
於 [ProviderForm.tsx](../../../renderer/components/ProviderForm.tsx) 的 `renderField` `case 'textarea'`（~:396-405）特例化：當 `field.key === 'systemPrompt'` 時，在 `<Textarea>` 上方加一個「套用範本」`<Select>`，選項來自 `types/provider.ts` 一併匯出的 `SYSTEM_PROMPT_PRESETS: { labelKey: string; value: string }[]`：
- `預設翻譯` → `defaultSystemPrompt`
- `多語會議 → 繁體中文` → `MULTILINGUAL_TO_TRADITIONAL_PROMPT`

選取即 `onChange('systemPrompt', presetValue)` 填入 textarea，使用者仍可手改。

### 3. 台灣用詞一併套用到譯文
於 [translate/index.ts](../../../main/translate/index.ts) 的 `postProcessTarget`（~:66-79）：目前 `convertChineseText(out, desiredTargetScript)` 未帶 `{ taiwanPhrase }`（僅 s2tw 字形）。改為讀全局設定並帶入：
```ts
// store 由 ../helpers/storeManager re-export（該檔已 import logMessage）
const taiwanPhrase = store.get('settings')?.openccPhraseConversion === true;
// ...
out = convertChineseText(out, desiredTargetScript, { taiwanPhrase }).text;
```
使 `openccPhraseConversion` 對「來源＋譯文」行為一致。

### 4. i18n
於 [en/*.json](../../../renderer/public/locales/en) 與 `zh/*.json` 新增預設選單標籤鍵（「套用範本」、「預設翻譯」、「多語會議→繁體中文」）；namespace 依 ProviderForm 實際使用者確認。`zh-Hant/` 由 `npm run i18n:zh-hant` 生成，**勿手改**。

### 5. 推薦設定（純設定，寫入使用文件）
- 任務：generate-translate
- 引擎/模型：Whisper **large**
- 來源語言：**auto**；目標語言：**繁體中文（zh-Hant）**
- 翻譯服務：`isAi` provider（OpenAI/Deepseek/Gemini/qwen…）
- 系統提示詞：一鍵套用「多語會議→繁體中文」
- 輸出內容：**onlyTranslate**（純譯文單語，[constants/index.ts](../../../main/translate/constants/index.ts)）
- 保留 `alwaysTraditionalChinese` 開；batchSize 用預設（10）。

## 與 Phase 1 的互動
- 來源 auto → Phase 1 來源正規化跳過，對泰/英行零風險；繁體保證改由提示詞 ＋ `postProcessTarget` 承擔。
- 若改選來源=繁體中文：Phase 1 區塊會跑，`detectChineseScript` 只從漢字取訊號，泰/英行為 `unknown`、OpenCC 對其 identity，不受影響。
- 變更 3 讓 `postProcessTarget` 對譯文一律強制繁體且尊重用詞開關 —— auto 路徑下的主要安全網。

## 測試／驗證（端對端，手動）
1. 設定 AI provider，一鍵套「多語會議→繁體」。
2. generate-translate、Whisper large、來源 auto、目標繁體、輸出 onlyTranslate。
3. 對含中／泰／英交錯短音檔執行。
4. 看 log AI 批次（[ai.ts:126-136](../../../main/translate/services/ai.ts#L126)）：請求與回應 JSON 鍵數相同（無 `翻译返回条数与请求不一致`）。
5. 輸出 `.srt`：每行純繁體、無泰/拉丁殘留、無簡體。
6. 放一行故意簡體 → `postProcessTarget` 仍轉繁；開 `openccPhraseConversion` → 譯文用詞台灣化（變更 3）。
7. 反例：暫用 `defaultSystemPrompt` + auto → log 出現「精通auto」，佐證需專用提示詞。

## 風險／限制（誠實揭露）
- **泰文 ASR 品質是最大天花板**：Whisper large + auto 對碼切換音檔常誤斷句/誤辨泰文；ASR 亂 → 譯文亂。鎖定決策下的已知上限。
- **中文行改寫漂移**：LLM 可能輕微改寫中文；後處理只保證字形，無法還原措辭。
- **鍵數校驗耦合**：需指令遵循強的模型；弱模型可能漏行觸發重試或 `[翻译失败]`。建議 batchSize 適中。

## 決策記錄
- **LLM 整體 vs 機器翻譯＋樞紐**：選 LLM —— 混語輸入一步到位、樞紐由模型內部處理、免建語言偵測器與兩段式管線。
- **Whisper large + auto vs 逐段轉寫**：選前者 —— 逐段需 diarization 或挖 SenseVoice 丟棄的語言 ID（且不支援泰文），工程極大且泰文無現成方案。
- **一鍵預設 vs 純文件**：選一鍵預設 —— 手貼長提示詞易錯、不好發現。
- **用詞開關套到譯文**：選是 —— 與 Phase 1 的全局用詞開關語意一致。

## 附錄：提示詞（`MULTILINGUAL_TO_TRADITIONAL_PROMPT`，暫定，實作可微調）
```
# Role: 資深多語會議字幕翻譯專家
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
```
