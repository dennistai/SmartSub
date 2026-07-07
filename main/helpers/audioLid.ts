/**
 * 音訊語言辨識（audio LID）：用 onnxruntime-node 跑 MMS-LID（facebook/mms-lid-256 導出的 int8 ONNX）
 * 判定一段音訊的語言，限定在 {th, zh, en}。取代 whisper `auto` 逐段偵測，根治 crosstalk 段
 * 被誤判成英文亂碼的問題（PoC 實測：crosstalk 段正確判為 zh）。
 *
 * 模型與標籤放在 userData/lid-models/（隨需下載，非內建）。缺模型/載入失敗時 detectLanguage
 * 回傳 null，呼叫方回退 whisper `auto`（功能不中斷）。
 */
import fs from 'fs';
import path from 'path';
import { getPath } from './whisper';
import { logMessage } from './storeManager';

export type LidLang = 'th' | 'zh' | 'en';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ort: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let session: any = null;
let labels: Record<LidLang, number[]> | null = null;
let initTried = false;
let ready = false;

/** LID 模型/標籤目錄：whisper 模型目錄下的 lid/ 子資料夾（保證與 ASR 模型同處）。 */
function lidDir(): string {
  return path.join(getPath('modelsPath'), 'lid');
}
export function getLidModelPath(): string {
  return path.join(lidDir(), 'mms-lid-256-int8.onnx');
}
function getLidLabelsPath(): string {
  return path.join(lidDir(), 'mms-lid-labels.json');
}

/** 模型與標籤是否都已就緒（供 UI/流程判定是否走 LID）。 */
export function isLidAvailable(): boolean {
  return fs.existsSync(getLidModelPath()) && fs.existsSync(getLidLabelsPath());
}

/** 惰性載入 onnx session 與標籤；只嘗試一次，失敗即標記不可用。 */
async function ensureSession(): Promise<boolean> {
  if (initTried) return ready;
  initTried = true;
  try {
    if (!isLidAvailable()) {
      logMessage('audio LID model not found, fallback to whisper auto', 'info');
      return false;
    }
    // 惰性 require：未用到 LID 時不載入原生庫
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ort = require('onnxruntime-node');
    session = await ort.InferenceSession.create(getLidModelPath());
    labels = JSON.parse(fs.readFileSync(getLidLabelsPath(), 'utf-8'));
    ready = true;
    logMessage('audio LID (mms-lid-256) loaded', 'info');
  } catch (error) {
    logMessage(`audio LID init failed (fallback to auto): ${error}`, 'warning');
    ready = false;
  }
  return ready;
}

/** 掃描 WAV 找 data chunk（穩健，不硬編 44 位元組 header）。 */
function readWavData(filePath: string): Buffer {
  const buf = fs.readFileSync(filePath);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  return buf.subarray(44);
}

/** int16 LE PCM → Float32（[-1,1]）。 */
function pcmToFloat(pcm: Buffer): Float32Array {
  const n = Math.floor(pcm.length / 2);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = pcm.readInt16LE(i * 2) / 32768;
  return a;
}

/** Wav2Vec2 特徵歸一：零均值、單位變異（已驗證與 transformers FeatureExtractor 一致）。 */
function normalize(a: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < a.length; i++) mean += a[i];
  mean /= a.length || 1;
  let variance = 0;
  for (let i = 0; i < a.length; i++) variance += (a[i] - mean) ** 2;
  variance /= a.length || 1;
  const std = Math.sqrt(variance + 1e-7);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] - mean) / std;
  return out;
}

/** softmax 後在 {th,zh,en} 內加總各語言 index、取最高。 */
function decide(logits: Float32Array | number[]): {
  lang: LidLang;
  prob: number;
} {
  let mx = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > mx) mx = logits[i];
  let sum = 0;
  const e = new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    e[i] = Math.exp(logits[i] - mx);
    sum += e[i];
  }
  const scores: Record<LidLang, number> = { th: 0, zh: 0, en: 0 };
  (['th', 'zh', 'en'] as LidLang[]).forEach((lang) => {
    for (const idx of labels![lang]) scores[lang] += e[idx] / sum;
  });
  let best: LidLang = 'zh';
  let bestVal = -1;
  (Object.keys(scores) as LidLang[]).forEach((k) => {
    if (scores[k] > bestVal) {
      bestVal = scores[k];
      best = k;
    }
  });
  return { lang: best, prob: bestVal };
}

/**
 * 偵測一段 16kHz 單聲道 WAV 的語言，限定 {th,zh,en}。
 * 回傳 'th'|'zh'|'en'，或 null（LID 不可用 → 呼叫方回退 whisper auto）。
 */
export async function detectLanguage(wavPath: string): Promise<LidLang | null> {
  if (!(await ensureSession())) return null;
  try {
    const samples = normalize(pcmToFloat(readWavData(wavPath)));
    const tensor = new ort.Tensor('float32', samples, [1, samples.length]);
    const out = await session.run({ input_values: tensor });
    const { lang } = decide(out.logits.data);
    return lang;
  } catch (error) {
    logMessage(`audio LID inference failed (fallback): ${error}`, 'warning');
    return null;
  }
}
