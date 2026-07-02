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
   - 偵測到**簡體** → OpenCC 轉繁體。
4. **永不**把中文轉寫產物轉成簡體。
5. 新增全局設定開關「OpenCC 台灣用詞轉換」，**預設關閉**，僅在走 OpenCC（簡→繁）時生效：
   - **關**（預設）：`{ from: 'cn', to: 'tw' }` — 只轉字形成台灣繁體，**保留原用詞**。
   - **開**：`{ from: 'cn', to: 'twp' }` — 字形 + 台灣用詞轉換（信息→資訊、軟件→軟體、自行車→腳踏車）。

### 字形 vs 用詞：為何拆兩層

Whisper 無法辨識說話者地區口音，台灣人講話被轉成簡體時，**用詞其實是台灣用詞、只是字形被寫成簡體**。此時只需字形轉換（`tw`）；若強跑用詞轉換（`twp`）反而會把已正確的台灣用詞當大陸用詞誤「校正」。只有內容確實是大陸用詞（與大陸同事開會）時才需要 `twp`。故用詞轉換獨立成一個預設關閉的開關。

現行程式碼用 `to: 't'`（OpenCC 標準中繼形，官方文件明示「通常不是最佳終端顯示字形」）。本設計將簡→繁的基準字形由 `t` **升級為 `tw`**（台灣字形），對台灣使用者為嚴格改善；此升級同時作用於翻譯輸出至 `zh-Hant` 的路徑（[translate/index.ts](../../../main/translate/index.ts)），但**用詞轉換開關僅接入轉寫路徑**，翻譯路徑維持不含用詞轉換的 `tw`。

## 非目標（範圍外）

- **翻譯**輸出字形（[translate/index.ts](../../../main/translate/index.ts) 依 `targetLanguage` 處理）不在本次改動範圍。
- **LLM/校對級**的語意改寫（超出 OpenCC 詞典能力的用詞潤飾）另議；本次的用詞轉換僅限 OpenCC `twp` 詞典級。
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

```ts
/** OpenCC 台灣用詞轉換：僅在簡→繁 OpenCC 轉換時生效。
 *  關（預設）→ s2tw（只轉字形，保留原用詞）；開 → s2twp（含台灣用詞轉換）。 */
openccPhraseConversion?: boolean;
```

預設值（[store/index.ts](../../../main/helpers/store/index.ts) settings 區塊）：`alwaysTraditionalChinese: true`、`openccPhraseConversion: false`。

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

### 2b. 轉換器改造（字形基準 + 用詞開關）

[chineseConvert.ts](../../../main/helpers/chineseConvert.ts) 的簡→繁轉換器由單一 `to: 't'` 改為兩個惰性快取轉換器：

```ts
let s2twConverter: ConvertFn | null = null;   // { from: 'cn', to: 'tw'  } 只轉字形
let s2twpConverter: ConvertFn | null = null;  // { from: 'cn', to: 'twp' } 含台灣用詞
```

`convertChineseText` 簽章擴充一個可選項：

```ts
export function convertChineseText(
  text: string,
  desired: ChineseScript,
  opts?: { taiwanPhrase?: boolean },
): { text: string; converted: boolean };
```

- `desired === 'traditional'`：`opts?.taiwanPhrase` 為 true 用 `s2twp`，否則 `s2tw`。
- `desired === 'simplified'`：維持 `t2s`（`{from:'t', to:'cn'}`），轉寫路徑不再使用（永不轉簡）。
- 翻譯路徑（[translate/index.ts](../../../main/translate/index.ts)）呼叫時不傳 `opts` → 得 `s2tw`（字形升級、不含用詞）。

`detectChineseScript` 的偵測仍以 `s2tw` / `t2s` 兩向差異字數比較即可（字形訊號足夠，用詞不影響字形判斷）。

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
  const taiwanPhrase = settings?.openccPhraseConversion === true;        // 預設關
  const desiredScript = resolveDesiredChineseScript(sourceLanguage, alwaysTraditional);
  if (desiredScript) {
    try {
      throwIfTaskCancelled();
      const original = await fs.promises.readFile(file.srtFile, 'utf-8');
      const detected = detectChineseScript(original);
      // 偵測已是目標字形（或中性 unknown）→ 保留原生，跳過 OpenCC
      if (detected !== 'unknown' && detected !== desiredScript) {
        const { text, converted } = convertChineseText(original, desiredScript, {
          taiwanPhrase,
        });
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

於 [AdvancedSheet.tsx](../../../renderer/components/tasks/AdvancedSheet.tsx) 辨識區（`section.recognition`）在 `reduceRepetition` 卡片後，仿其模式新增**兩個開關卡片**：
- `alwaysTraditionalChinese`：`useState` + 進場讀取（`s?.alwaysTraditionalChinese !== false`），`onCheckedChange` → `setSettings({ alwaysTraditionalChinese: checked })`。
- `openccPhraseConversion`：`useState` + 進場讀取（`s?.openccPhraseConversion === true`），`onCheckedChange` → `setSettings({ openccPhraseConversion: checked })`。此開關的 hint 註明「僅在簡→繁轉換時生效；原生繁體不受影響」，並可在 `alwaysTraditionalChinese` 關閉時仍顯示（它獨立作用於任何走 OpenCC 的簡→繁）。

### 6. i18n

三份 `tasks.json`（[en](../../../renderer/public/locales/en/tasks.json)、[zh](../../../renderer/public/locales/zh/tasks.json)、[zh-Hant](../../../renderer/public/locales/zh-Hant/tasks.json)）新增兩個區塊，各含 `label` / `on` / `off` / `hint`：
- `alwaysTraditionalChinese`：「開啟後中文語音轉寫一律輸出繁體，原生繁體保留、原生簡體轉繁，永不轉簡」。
- `openccPhraseConversion`：「簡→繁時是否套用台灣用詞轉換（信息→資訊、軟件→軟體）。關：只轉字形保留原用詞（適合台灣講者被誤判成簡體時）；開：連用詞一併台灣化（適合內容為大陸用詞時）」。

## 資料流

```
音訊 → Whisper(zh) → 源 SRT
                       │
         alwaysTraditionalChinese 開？來源為中文？
                       │ 是
              detectChineseScript(SRT)
              ├─ traditional / unknown → 保留原生（跳過 OpenCC）
              └─ simplified → OpenCC
                              ├─ openccPhraseConversion 關 → s2tw （只轉字形）
                              └─ openccPhraseConversion 開 → s2twp（字形＋台灣用詞）
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
3. `convertChineseText` 用詞開關：
   - 簡體含大陸用詞（如「信息/軟件」）+ `taiwanPhrase: false` → 字形轉繁但**保留**「信息/軟件」
   - 同輸入 + `taiwanPhrase: true` → 轉成「資訊/軟體」
4. fileProcessor 歸一分支（可用既有測試風格 mock fs）：
   - Medium 原生繁體 + 開關開 + `zh` → 檔案不被改寫（跳過 OpenCC）
   - Turbo 簡體 + 開關開 + `zh` → 轉為繁體

## 決策記錄

- **偵測 vs 模型白名單**：選偵測轉寫結果字形 — 與模型解耦、免維護清單、未來新模型自動適用。
- **觸發範圍**：選全局設定開關（預設開）— 一致給繁體，同時保留少數需簡體時的彈性，不硬改 `zh` 語意。
- **繁體優先的 tie-break**：偵測 `simplified` 嚴格需 `simplifiedSignal > traditionalSignal`，中性/相等一律當繁體處理，貫徹「永不轉簡」。
- **字形 vs 用詞拆兩個開關**：因 Whisper 分不出地區口音，台灣講者被轉簡體時用詞仍是台灣用詞 → 用詞轉換獨立、預設關，避免誤校正；僅在確為大陸用詞時手動開。
- **基準字形 `t` → `tw`**：官方建議 `tw` 優於 `t` 作終端顯示；升級同惠及翻譯至 `zh-Hant`。用詞轉換（`twp`）僅接入轉寫路徑，翻譯路徑維持 `tw`（不含用詞），本次不擴大到翻譯以控範圍。
