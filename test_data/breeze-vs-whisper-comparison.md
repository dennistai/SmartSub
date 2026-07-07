# Breeze-ASR-25 vs Whisper 三語實測比較（中／英／泰）

> 測試音檔：`test_data/audio1862475381.mp4`（泰國廠會議，中英泰三語混合）
> 方法：離線 harness `scripts/breeze-compare/run.ts`（直接 dlopen whisper.cpp Vulkan addon，不經 Electron）。
> 依既有 LID 字幕 `*.multilingual-poc-v4-LID.srt` 各語言取 2 個代表窗口，切成 16kHz 單聲道 wav，
> 每個 (模型 × 窗口) 各跑 `language=該語言`（強制，測純轉錄品質）與 `language=auto`（測語言判定）。
> 原始輸出：`test_data/.breeze-compare/results.json`。重跑：`npm run test:breeze`。

## 受測模型

| 模型             | 說明                                                            | 檔案    |
| ---------------- | --------------------------------------------------------------- | ------- |
| `breeze-asr-25`  | 聯發科 Breeze（Whisper-large-v2 微調，台灣腔中文/中英夾雜）q5_k | 1.08 GB |
| `large-v2-q5_0`  | Breeze 的**母模型**，用來隔離「微調帶來的差異」                 | 1.08 GB |
| `large-v3-turbo` | 使用者目前實際使用的基準                                        | 1.55 GB |

---

## 結論速覽

| 語言                         | 最佳模型                  | Breeze 表現       | 重點                                                                                       |
| ---------------------------- | ------------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| **中文（台灣腔／中英夾雜）** | **Breeze**                | ✅ 最佳           | 內容最完整、貼近台灣口語；且 `auto` 下**不會跳成英文**（turbo/large-v2 會）                |
| **英文**                     | large-v3-turbo            | 🟡 可用、偶爾幻覺 | 長句幾乎與 turbo 同級；極短英文片段會**多補一句幻覺**                                      |
| **泰語**                     | large-v3-turbo / large-v2 | ❌ 明顯退步       | 強制泰語仍較破碎、混入拉丁/漢字；`auto` 下**把泰語誤判成中文並產生幻覺翻譯，泰語整段消失** |

**一句話**：對台灣使用者的中文（尤其中英夾雜）Breeze 是明顯升級；但**泰語不能用 Breeze**，
微調造成對泰語的遺忘 + 極強的中文先驗，會在自動偵測時把泰語吞掉。建議依語言路由模型（見文末）。

---

## 中文：Breeze 明顯較佳 ✅

**窗口 90–110s（中英夾雜口語）**　參考(LID poc)：`…可以嗎 我幫你弄 我怎麼辦 你有沒有網路 我用 我需要 對啊 你用 可以啊 我幫你量 你不是這樣量啦 你不要用微 用微信嗎…`

- **breeze `forced/auto`（兩者一致）**：`…可以嗎我幫你弄 我怎麼辦 你有沒有網路 我用 wc 啊 對啊 你用 可以啊…你不是這樣連啦你不要用微 用微信嗎 不是你微信你要先把複製連…` — 內容最完整、句序貼近參考。
- large-v2 `forced(zh)`：亦佳但略短；**`auto` → 誤判英文**：`- With a gym, yeah. (speaking in foreign language)` — 中文整段丟失。
- large-v3-turbo `forced(zh)`：明顯**截斷**，掉了多句；**`auto` → 誤判英文**並整段翻成英文幻覺。

**窗口 109–130s**：Breeze `forced(zh)` 抓到最多細節（`偷看你的秘密`、`小三小四小五小六` 等），large-v2 把「那個 G」誤聽成「T-shirt」。三者此窗口 `auto` 都停在中文。

> **關鍵優勢**：中英夾雜時，Breeze 在 `auto` 下仍穩定停在中文，turbo/large-v2 常在夾雜英文詞時整段翻車成英文。這正是 MediaTek 宣稱的 code-switching 強項，實測成立。

---

## 英文：可用，但極短句易幻覺 🟡

**窗口 510–530s（連續英文）**　三模型幾乎同級且正確：

- breeze：`You just start from the summary and memo of the last week, the record … Yes, I will focus just for the key point.`
- large-v3-turbo：同義、標點最乾淨。　large-v2：出現 `discrease` 之類小錯。

**窗口 278s（極短「they fall.」）**：

- large-v3-turbo：`they fall` ✅　　large-v2：`[BLANK_AUDIO]`（漏掉）
- **breeze**：`They fall. This is the only way to make sense of the instrument.` — **多補了一句幻覺**。

> 英文長句 Breeze 與 turbo 相當；但在資訊量極低的短片段上 Breeze 傾向補字幻覺。此會議英文佔比很低（LID 全檔僅 ~10 條英文），英文非重點語言。

---

## 泰語：Breeze 明顯退步，且會被中文吞掉 ❌

**窗口 7.8–14.7s**：

- large-v2 `forced(th)`：`โอเค ได้ครับ พี่โปรด ด้วยพออันนี้ เกลียดไม่เห็นเนาะ` — 相對完整的泰文。`auto` 也**正確停在泰文**。
- **breeze `forced(th)`**：`OK ได้ครับ พี่โพดริโภ ริโภ อันนี้ แกไม่เห็น喔` — 泰文較破碎、還混入漢字「喔」。
- **breeze `auto` → 誤判中文**：`OK 啦咁 如果 do it for 阿哩 咁咪現囉` — **泰文完全消失**，變成粵語/中文亂碼。

**窗口 43.8–53.7s**：

- large-v2 `forced(th)`：`ตอนนี้เห็นรีบพอดีไหมครับ … ตอนนี้เห็นหน้าเจ้าผมไหมครับ เนี่ยเห็นอยู่แล้ว …` — 最完整，貼近參考。`auto` 也停在泰文。
- large-v3-turbo `forced(th)`：`ตอนนี้เห็นรีพอร์ดนั้นครับ ตอนนี้เห็นหน้าเช้าผม ตอนนี้เห็นอยู่แล้ว` — 亦可用，`auto` 停在泰文。
- **breeze `forced(th)`**：`ตอนนี้ หิน request เองครับ ตอนนี้ หินหน้าเจอผมไม่แค่` — **大量掉字**、混入英文 `request`。
- **breeze `auto` → 誤判中文**：`那你已經 report 了 現在看不見了 … 然後你還以為喔` — 又是**中文幻覺翻譯，泰文全失**。

> **診斷**：Breeze 只在 zh/en 合成語料上微調，對泰語發生**災難性遺忘**，同時獲得極強的中文先驗。
> 因此 (1) 即使強制泰語，泰文品質也劣於母模型 large-v2；(2) 在 `auto` 下會把泰語判成中文並輸出幻覺翻譯。
> **對照組（母模型 large-v2）`auto` 能正確停在泰文**——證明這是微調造成的退步，而非 whisper.cpp 或量化的問題。

---

## 建議

1. **中文為主的台灣使用者**：Breeze 值得作為預設，尤其中英夾雜場景。
2. **泰語段絕不可用 Breeze**：品質退步且會被中文吞掉。純泰語內容用 `large-v3-turbo`（或 large-v2）。
3. **依語言路由模型（已實作）**：多語分段管線（`multilingualTranscribe.ts` + `audioLid.ts` MMS-LID
   逐段判語言後**強制**該語言）現會依語言逐段選模型——`zh` chunk → Breeze，`th`/`en` chunk →
   large-v3-turbo（見 `main/helpers/engines/languageModelRouting.ts`）。同一 addon 可用不同 `model`
   路徑轉錄不同 ggml 模型，故零額外成本。**僅當路由目標已安裝時才切換**，否則回退使用者所選的基礎
   模型（只裝一個模型時行為不變）。可用設定 `multilingualModelRouting:false` 關閉、
   `multilingualLanguageModelRoutes` 覆寫路由表。因管線以強制語言（非 `auto`）呼叫 whisper，
   天然避開 Breeze 的自動偵測翻車。
4. **量化說明**：本次 Breeze 用社群預轉的 q5_k（與 large-v2-q5_0 同量級以求公平）。若要再確認上限，
   可另抓 `ggml-model.bin`(fp16, 3.09GB) 複測中文，但趨勢預期不變。

---

### 附：如何重現

```bash
# 需先備妥模型於 %APPDATA%/SmartSub/whisper-models：
#   ggml-breeze-asr-25.bin、ggml-large-v2-q5_0.bin、ggml-large-v3-turbo.bin
npm run test:breeze
# 可調：BREEZE_MODELS、BREEZE_WINS_PER_LANG、BREEZE_MAX_WIN_SEC、BREEZE_ADDON
```
