# 待處理分支任務（分支清理後的 backlog）

> 背景：清理遠端分支時，以下分支**無法自動併入 `main`**（與現行架構分岔、需 rebase／手動解衝突），
> 但**內含有價值的未完成工作**，故先刪除分支、把工作記錄於此。每個分支的 tip 都已打成
> **`archive/*` 標籤推到遠端**（永久可達，不會被 GC），復原很簡單：
>
> ```bash
> git fetch origin --tags
> git switch -c <name> archive/<name>   # 從標籤重建分支
> git rebase main                        # rebase 到最新 main，解衝突後發 PR
> ```
>
> 每則任務同時附原始 SHA。純過時／無內容分支（batch1/batch2）未打標籤、不列任務。

## 高優先

### 1. 繁化／台灣用詞／多語會議提示詞　`feat/traditional-chinese-and-multilingual`　✅ 已重整入 main（核心）

- **狀態**：核心 net-new 功能已 surgical 移植入 main（commit `feat(chinese): 繁化歸一…`）——
  字形偵測歸一（原生繁體保留／永不轉簡）、`alwaysTraditionalChinese`(預設開)／`openccPhraseConversion`(預設關)
  設定、fileProcessor/translate 台灣字形+用詞、`MULTILINGUAL_TO_TRADITIONAL_PROMPT` + 系統提示詞一鍵預設、
  i18n、15 條單元測試。採 surgical 移植（非整檔），以免回退 main 的 mixed-annotation／cloud-asr／Breeze。
- **仍待辦（低優先）**：兩個設定開關的 **AdvancedSheet UI** 未移植——分支版 AdvancedSheet 已與 main 大幅分歧
  （整檔套用會回退 `multiLanguageTranscription` 等），需在現行 AdvancedSheet「新增」兩個 Switch
  （讀 getSettings／寫 setSettings）。預設值已合理、設定仍經後端生效，故暫緩。
- **SHA**：`e23908d55cf3c7c4f2794031a937a2163f43b8fe`（+21，另含 Phase 2 設計 spec 等文件）

### 2. 內建 whisper.cpp 原生時間軸 + VAD 管線　`feat/builtin-native-token-timeline`

- **SHA**：`d2949be2797be865cd21ef2c2af52bba959e5126`（+8 commits）
- **內容**：切換內建引擎到 native whisper.cpp 時間軸（segment-aware token + 內建 VAD 段）、
  Silero VAD 主/能量兜底的 0-fork 細粒度時間軸、字幕效果意圖檔位、longgap 測試台（D8–D15）、
  addon 隨需下載/不追蹤原生二進位。
- **需重構原因**：改動內建引擎核心時間軸，與 main 現行 `builtinEngine`/`multilingualTranscribe` 衝突。
- **備註**：已**涵蓋** `feature/builtin-subtitle-timeline-0fork`（SHA `c0ed979`，其 5 個 commit 為本分支子集），
  該分支不另立任務。

## 中優先

### 3. faster-whisper CPU/GPU runtime 選擇　`feat/runtime-cpu-gpu-select`

- **SHA**：`ccc64b4fefa597863ced10c72a66df580ea7c551`（+4，其中 2 個僅版本號 chore）
- **內容**：讓使用者選 CPU 或 GPU faster-whisper runtime、variant-aware 下載（CPU / GPU CUDA）。

### 4. 免費翻譯源　`feature/freeTranslate`

- **SHA**：`da421cfddb214d12add6a69ba42273c0ea68276f`（+1）
- **內容**：接入免費翻譯源，多源回退 + 限速。

### 5. 新增翻譯供應商　`feat/translation-providers`

- **SHA**：`1bd402839c47303013242f53f0d6053c52864186`（+1）
- **內容**：新增小牛（NiuTrans）、騰訊雲、訊飛翻譯供應商。

## 低優先（小修，重新套用即可）

| 修復                                  | SHA       | 內容                                           |
| ------------------------------------- | --------- | ---------------------------------------------- |
| `fix/ai-translation-count-validation` | `0667dc6` | 校驗 AI 翻譯回傳條數，防字幕錯位               |
| `fix/cuda-detect-new-driver`          | `ba1c2e8` | 相容新版 `nvidia-smi` 輸出，修顯卡偵測         |
| `fix/ffmpeg-progress-percent`         | `7323f35` | percent 不可用時改由 timemark 推導 ffmpeg 進度 |
| `fix/translation-request-timeout`     | `ff0778b` | 翻譯供應商加請求逾時，避免進度卡住             |

> 已捨棄（無實質內容、不列任務）：`fix/fasterWhisperDevice`（僅 version bump）。
