/**
 * Breeze-ASR-25 vs Whisper 三语（中／英／泰）离线对比 harness。
 *
 * 直接 dlopen whisper.cpp addon（不经 Electron），在真实三语会议音档
 * `test_data/audio1862475381.mp4` 上，对每个语言各取若干代表性窗口，逐模型转录并汇总：
 *   - breeze-asr-25   ：联发科 Breeze（Whisper-large-v2 微调，台湾腔中文/中英夹杂）
 *   - large-v2-q5_0   ：Breeze 的母模型（隔离「微调效果」）
 *   - large-v3-turbo  ：使用者现用基准
 *
 * 窗口来源：既有 LID 字幕 `*.multilingual-poc-v4-LID.srt`（每条含 [lang] 标注 + 时间轴），
 * 据此挑出各语言的干净片段，用 ffmpeg 切成 16kHz 单声道 wav。
 *
 * 每个 (模型 × 窗口) 各跑两次：language=该语言（强制，测纯转录品质）与 language=auto
 * （测语言判定行为——尤其 Breeze 会不会把泰语误判成中文）。
 *
 * 运行：npm run test:breeze
 * 可调 env：
 *   BREEZE_MODELS_DIR   ggml-*.bin 所在目录（默认 %APPDATA%/SmartSub/whisper-models）
 *   BREEZE_MODELS       逗号分隔模型名（默认三个；缺档者自动跳过）
 *   BREEZE_ADDON        指定 addon 路径（默认优先 vulkan、失败回退 cpu）
 *   BREEZE_MAX_WIN_SEC  单窗口最长秒数（默认 22）
 *   BREEZE_WINS_PER_LANG 每语言最多窗口数（默认 zh/th=2, en=2）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { execFileSync } from 'child_process';

// 编译输出跑在 node_modules/.cache 下，__dirname 不指向仓库；npm run 的 cwd 即仓库根。
const REPO_ROOT = process.env.BREEZE_REPO_ROOT || process.cwd();
const EXTRA = path.join(REPO_ROOT, 'extraResources');
const GGML_VAD = path.join(EXTRA, 'ggml-silero-v6.2.0.bin');
const INPUT = path.join(REPO_ROOT, 'test_data', 'audio1862475381.mp4');
const REF_SRT = path.join(
  REPO_ROOT,
  'test_data',
  'audio1862475381.multilingual-poc-v4-LID.srt',
);
const OUT_DIR = path.join(REPO_ROOT, 'test_data', '.breeze-compare');

const MODELS_DIR =
  process.env.BREEZE_MODELS_DIR ||
  path.join(os.homedir(), 'AppData', 'Roaming', 'SmartSub', 'whisper-models');

const MODELS = (
  process.env.BREEZE_MODELS || 'breeze-asr-25,large-v2-q5_0,large-v3-turbo'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const LANGS = ['zh', 'en', 'th'] as const;
type Lang = (typeof LANGS)[number];

const MAX_WIN_SEC = Number(process.env.BREEZE_MAX_WIN_SEC || 22);
const MIN_WIN_SEC = 8;
const WINS_PER_LANG = Number(process.env.BREEZE_WINS_PER_LANG || 2);

// ---------- ffmpeg ----------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const FFMPEG: string = require('@ffmpeg-installer/ffmpeg').path;

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function extractWav(
  src: string,
  dest: string,
  startSec?: number,
  durSec?: number,
): void {
  if (fs.existsSync(dest)) return;
  const args: string[] = ['-y', '-loglevel', 'error'];
  if (startSec != null) args.push('-ss', String(startSec));
  args.push('-i', src);
  if (durSec != null) args.push('-t', String(durSec));
  args.push('-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dest);
  execFileSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

// ---------- 解析 LID 字幕 ----------
interface Cue {
  start: number;
  end: number;
  lang: Lang;
  text: string;
}

function tsToSec(ts: string): number {
  const m = ts.match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +`0.${m[4]}`;
}

function parseLidSrt(file: string): Cue[] {
  const raw = fs.readFileSync(file, 'utf-8').replace(/\r/g, '');
  const blocks = raw.split(/\n\n+/);
  const cues: Cue[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [a, z] = timeLine.split('-->').map((s) => s.trim());
    const textLine = lines.slice(lines.indexOf(timeLine) + 1).join(' ');
    const lm = textLine.match(/^\[(th|zh|en)\]\s*(.*)$/);
    if (!lm) continue;
    cues.push({
      start: tsToSec(a),
      end: tsToSec(z),
      lang: lm[1] as Lang,
      text: lm[2].trim(),
    });
  }
  return cues;
}

interface Window {
  lang: Lang;
  start: number;
  end: number;
  refText: string;
}

/** 把同语言的连续 cue 合并成 ~MAX_WIN_SEC 的窗口，各语言取前 WINS_PER_LANG 个。 */
function pickWindows(cues: Cue[]): Window[] {
  const out: Window[] = [];
  for (const lang of LANGS) {
    const own = cues.filter((c) => c.lang === lang);
    const windows: Window[] = [];
    let cur: Window | null = null;
    for (const c of own) {
      if (!cur) {
        cur = { lang, start: c.start, end: c.end, refText: c.text };
        continue;
      }
      const wouldEnd = c.end;
      if (wouldEnd - cur.start <= MAX_WIN_SEC && c.start - cur.end < 6) {
        cur.end = c.end;
        cur.refText += ' ' + c.text;
      } else {
        if (cur.end - cur.start >= MIN_WIN_SEC || windows.length === 0)
          windows.push(cur);
        cur = { lang, start: c.start, end: c.end, refText: c.text };
      }
      if (windows.length >= WINS_PER_LANG) break;
    }
    if (cur && windows.length < WINS_PER_LANG) windows.push(cur);
    out.push(...windows.slice(0, WINS_PER_LANG));
  }
  return out;
}

// ---------- whisper addon ----------
type WhisperFn = (p: Record<string, unknown>) => Promise<any>;

function loadWhisper(): { fn: WhisperFn; addon: string } {
  const candidates = process.env.BREEZE_ADDON
    ? [process.env.BREEZE_ADDON]
    : [
        path.join(EXTRA, 'addons', 'addon.vulkan.node'),
        path.join(EXTRA, 'addons', 'addon.node'),
      ];
  const errors: string[] = [];
  for (const addon of candidates) {
    if (!fs.existsSync(addon)) continue;
    try {
      const mod: any = { exports: {} };
      process.dlopen(mod, addon);
      if (typeof mod.exports.whisper !== 'function') {
        errors.push(`${path.basename(addon)}: no whisper()`);
        continue;
      }
      return { fn: promisify(mod.exports.whisper) as WhisperFn, addon };
    } catch (e) {
      errors.push(`${path.basename(addon)}: ${(e as Error).message}`);
    }
  }
  throw new Error('no loadable whisper addon:\n' + errors.join('\n'));
}

function whisperParams(
  modelPath: string,
  wav: string,
  lang: string,
  useGpu: boolean,
): Record<string, unknown> {
  return {
    language: lang,
    model: modelPath,
    fname_inp: wav,
    use_gpu: useGpu,
    flash_attn: false,
    no_prints: true,
    comma_in_time: false,
    translate: false,
    no_timestamps: false,
    audio_ctx: 0,
    token_timestamps: false,
    max_len: 0,
    print_progress: false,
    // 与多语分段管线一致的抗幻觉/抗重复设定
    max_context: 0,
    condition_on_previous_text: false,
    no_repeat_ngram_size: 3,
    repetition_penalty: 1.1,
    vad: false,
    vad_model: GGML_VAD,
  };
}

function joinText(result: any): string {
  const triples = (result?.transcription ?? []) as [string, string, string][];
  return triples
    .map((t) => (t[2] || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface RunResult {
  model: string;
  window: Window;
  forced: string; // transcription with language forced
  auto: string; // transcription with language=auto
  autoDetected: string | null;
}

async function main() {
  ensureDir(OUT_DIR);

  const availableModels = MODELS.filter((m) =>
    fs.existsSync(path.join(MODELS_DIR, `ggml-${m}.bin`)),
  );
  const missing = MODELS.filter((m) => !availableModels.includes(m));
  console.log(`Models dir : ${MODELS_DIR}`);
  console.log(`Models     : ${availableModels.join(', ') || '(none)'}`);
  if (missing.length) console.log(`Missing    : ${missing.join(', ')}`);
  if (!availableModels.length) {
    console.error('No models available on disk — aborting.');
    process.exit(1);
  }

  const { fn: whisper, addon } = loadWhisper();
  const useGpu = /vulkan/i.test(addon);
  console.log(`Addon      : ${path.basename(addon)} (use_gpu=${useGpu})\n`);

  // 1) 全档 wav（供切窗口）
  const fullWav = path.join(OUT_DIR, 'full.16k.wav');
  console.log('Extracting full audio → 16kHz wav…');
  extractWav(INPUT, fullWav);

  // 2) 选窗口 + 切档
  const cues = parseLidSrt(REF_SRT);
  const windows = pickWindows(cues);
  console.log(`Picked ${windows.length} windows:`);
  const winWavs = new Map<Window, string>();
  for (const w of windows) {
    const name = `${w.lang}_${w.start.toFixed(0)}-${w.end.toFixed(0)}.wav`;
    const wav = path.join(OUT_DIR, name);
    extractWav(fullWav, wav, w.start, Math.max(1, w.end - w.start));
    winWavs.set(w, wav);
    console.log(
      `  [${w.lang}] ${w.start.toFixed(1)}s–${w.end.toFixed(1)}s  ref="${w.refText.slice(0, 40)}…"`,
    );
  }
  console.log('');

  // 3) 逐模型 × 窗口跑
  const results: RunResult[] = [];
  for (const model of availableModels) {
    const modelPath = path.join(MODELS_DIR, `ggml-${model}.bin`);
    for (const w of windows) {
      const wav = winWavs.get(w)!;
      process.stdout.write(
        `run ${model} @ [${w.lang}] ${w.start.toFixed(0)}s … `,
      );
      const forcedRes = await whisper(
        whisperParams(modelPath, wav, w.lang, useGpu),
      );
      const autoRes = await whisper(
        whisperParams(modelPath, wav, 'auto', useGpu),
      );
      results.push({
        model,
        window: w,
        forced: joinText(forcedRes),
        auto: joinText(autoRes),
        autoDetected: (autoRes?.language as string) || null,
      });
      console.log('done');
    }
  }

  // 4) 输出
  const jsonOut = path.join(OUT_DIR, 'results.json');
  fs.writeFileSync(jsonOut, JSON.stringify({ addon, results }, null, 2));

  console.log('\n================ RESULTS ================\n');
  for (const w of windows) {
    console.log(
      `### [${w.lang}] window ${w.start.toFixed(1)}s–${w.end.toFixed(1)}s`,
    );
    console.log(`REF(LID poc): ${w.refText}\n`);
    for (const model of availableModels) {
      const r = results.find((x) => x.model === model && x.window === w);
      if (!r) continue;
      console.log(`- ${model}`);
      console.log(`    forced(${w.lang}): ${r.forced}`);
      console.log(`    auto[${r.autoDetected}]: ${r.auto}`);
    }
    console.log('');
  }
  console.log(`Raw JSON → ${jsonOut}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
