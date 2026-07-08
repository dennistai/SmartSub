# 分支清理：待重構任務結案記錄

> 背景：清理遠端分支時，部分分支**無法自動併入 `main`**（modify/delete 衝突），一度被當成
> 「有價值但待重構」列為任務。**逐一核對後發現：絕大多數其實早已在 `main`**——它們是以
> squash-merge 進 main 的舊開發線，squash 切斷了 git ancestry，才會顯示為「未合併」、且對
> main 已刪除的舊架構檔（`subtitleGenerator.ts`、`TaskConfigForm.tsx` 等）產生 modify/delete 衝突。
>
> 逐項核對已完成，結論如下。除任務 #1 的一個低優先 UI 殘項外，backlog 全部結案。

## 唯一有 net-new 工作者

### 1. 繁化／台灣用詞／多語會議提示詞　`feat/traditional-chinese-and-multilingual`　✅ 核心已重整入 main

- **已完成**：字形偵測歸一（原生繁體保留／永不轉簡）、`alwaysTraditionalChinese`(預設開)／
  `openccPhraseConversion`(預設關) 設定、fileProcessor/translate 台灣字形+用詞、
  `MULTILINGUAL_TO_TRADITIONAL_PROMPT` + 系統提示詞一鍵預設、i18n、15 條單元測試。
  （commit `feat(chinese): 繁化歸一…`；surgical 移植，未回退 main 的 mixed-annotation／cloud-asr／Breeze。）
- **仍待辦（低優先）**：兩個設定開關的 **AdvancedSheet UI**。分支版 AdvancedSheet 已與 main 大幅分歧
  （整檔套用會回退 `multiLanguageTranscription` 等），需在現行 AdvancedSheet「新增」兩個 Switch
  （讀 getSettings／寫 setSettings）。預設值已合理、後端照常生效，故暫緩。
- **保留** `archive/traditional-chinese-and-multilingual`（`e23908d`）供該 UI 殘項與 Phase 2 spec 參考。

## 逐一核對：其餘皆已在 main（squash 合併，無需重整）

| 分支                                      | 核對依據（main 現況）                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat/builtin-native-token-timeline` (#2) | 核心檔匯出符號/檔案 main 全含：`tokensToTriples`/`energySpeechSegments`/`outcomePresets`/`vadSegmentsToSpeech`、`scripts/longgap/`、`test:longgap:outcomes` |
| `feature/builtin-subtitle-timeline-0fork` | 為 #2 子集，同上                                                                                                                                            |
| `feat/runtime-cpu-gpu-select` (#3)        | 0 缺檔、0 缺符號；`fasterWhisperDevice`/CT2 runtime 已在 main                                                                                               |
| `feature/freeTranslate` (#4)              | 0 缺檔、0 缺符號                                                                                                                                            |
| `feat/translation-providers` (#5)         | `translationProvider.ts`/`provider.ts` 已含 niutrans/tencent/iflytek                                                                                        |
| `fix/ai-translation-count-validation`     | main `ai.ts:154` 已有 `parsedKeys.length !== batch.length` 校驗                                                                                             |
| `fix/cuda-detect-new-driver`              | main `cudaUtils.ts:132` 已有 `nvidia-smi --query-gpu=name,driver_version` 新格式偵測                                                                        |
| `fix/ffmpeg-progress-percent`             | main `audioProcessor.ts` 已 import `timemarkToSeconds` + percent 兜底                                                                                       |
| `fix/translation-request-timeout`         | main `constants` 已有 `TRANSLATION_REQUEST_TIMEOUT`/`OLLAMA_REQUEST_TIMEOUT`                                                                                |
| `fix/fasterWhisperDevice`                 | 僅 version bump，無實質內容                                                                                                                                 |

> 上述分支的 `archive/*` 標籤已移除（內容已在 main，無保留必要）；`archive/traditional-chinese-and-multilingual`
> 保留供任務 #1 的 UI 殘項。三批刪除的原始 SHA 仍記於 `scratchpad/deleted-branches-batch{1,2,3}.txt`。
