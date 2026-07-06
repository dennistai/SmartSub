import fs from 'fs';
import path from 'path';
import { getPath, loadWhisperAddon } from '../whisper';
import { logMessage, store } from '../storeManager';
import { ensureTempDir, formatSrtContent, getMd5 } from '../fileUtils';
import { extractAudioSegment } from '../audioProcessor';
import { getExtraResourcesPath } from '../utils';
import { writeLangMap, type LangMapCue } from '../langMapData';
import {
  getTaskContext,
  isWhisperCancelledResult,
  TaskCancelledError,
  throwIfTaskCancelled,
} from '../taskContext';
import { getVadSettings, secondsToSrtTime } from './transcribeShared';
import { resolveEffectiveSettings } from './outcomePresets';
import type { TranscribeContext } from './types';

/** 分段视窗长度（秒）。短到让每段单一语言、auto 偵測稳定；长到摊薄 encoder 固定开销。 */
const CHUNK_SECONDS = 30;

/** "HH:MM:SS.mmm"（或逗号）→ 秒。 */
function parseTsToSeconds(ts: string): number {
  const m = ts.match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +`0.${m[4]}`;
}

/** 从 16kHz 单声道 pcm_s16le WAV 估算时长（秒）：(bytes-44)/(16000*2)。 */
function readWavDurationSec(wavPath: string): number {
  try {
    const size = fs.statSync(wavPath).size;
    return Math.max(0, (size - 44) / (16000 * 2));
  } catch {
    return 0;
  }
}

/**
 * 多语言分段转录：把整檔音频切成 ~30s chunk，逐 chunk 以 language='auto' 转录，
 * 取 whisper 偵測到的真实语言标注每 cue；产出乾淨 SRT + 语言旁路 sidecar（file.langMapFile）。
 *
 * 走独立路径（builtinEngine 依旗标分派），旗标关闭时完全不进此函数。
 */
export async function transcribeMultilingual(
  ctx: TranscribeContext,
): Promise<string> {
  const { event, file, formData } = ctx;
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  const { tempAudioFile, srtFile } = file;
  const { model } = formData as { model?: string };
  const whisperModel = model?.toLowerCase();
  const signal = ctx.signal ?? getTaskContext()?.signal;

  if (!tempAudioFile || !fs.existsSync(tempAudioFile)) {
    throw new Error('multilingual transcription: audio file missing');
  }

  const settings = resolveEffectiveSettings(
    formData,
    store.get('settings') as Record<string, unknown>,
  );
  const vad = getVadSettings(settings as Record<string, unknown>);

  const { whisperAsync, backend } = await loadWhisperAddon(whisperModel);
  const useGpu = backend !== 'cpu';
  const modelPath = `${getPath('modelsPath')}/ggml-${whisperModel}.bin`;
  const vadModelPath = path.join(
    getExtraResourcesPath(),
    'ggml-silero-v6.2.0.bin',
  );

  const totalDuration = file.duration || readWavDurationSec(tempAudioFile);
  const nChunks = Math.max(1, Math.ceil(totalDuration / CHUNK_SECONDS));
  const chunkWav = path.join(
    ensureTempDir(),
    `${getMd5(file.filePath || file.fileName || 'ml')}.chunk.wav`,
  );

  logMessage(
    `multilingual transcribe: ${totalDuration.toFixed(0)}s → ${nChunks} chunks`,
    'info',
  );
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);

  const subtitles: [string, string, string][] = [];
  const langCues: LangMapCue[] = [];

  for (let i = 0; i < nChunks; i++) {
    throwIfTaskCancelled();
    const start = i * CHUNK_SECONDS;
    const dur = Math.min(CHUNK_SECONDS, totalDuration - start);
    if (dur <= 0) break;

    await extractAudioSegment(tempAudioFile, start, dur, chunkWav);
    throwIfTaskCancelled();

    const result = await whisperAsync({
      language: 'auto',
      model: modelPath,
      fname_inp: chunkWav,
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
      // 抗幻觉/抗重复（分段场景下切断上文最有效）
      max_context: 0,
      condition_on_previous_text: false,
      no_repeat_ngram_size: 3,
      repetition_penalty: 1.1,
      vad: vad.useVAD,
      vad_model: vadModelPath,
      vad_threshold: vad.vadThreshold,
      vad_min_speech_duration_ms: vad.vadMinSpeechDuration,
      vad_min_silence_duration_ms: vad.vadMinSilenceDuration,
      vad_max_speech_duration_s: vad.vadMaxSpeechDuration,
      vad_speech_pad_ms: vad.vadSpeechPad,
      vad_samples_overlap: vad.vadSamplesOverlap,
      signal,
    });

    if (isWhisperCancelledResult(result) || signal?.aborted) {
      throw new TaskCancelledError();
    }

    const lang: string = result?.language || 'auto';
    const triples = (result?.transcription ?? []) as [string, string, string][];
    for (const seg of triples) {
      const text = (seg[2] || '').trim();
      if (!text) continue;
      const absStart = start + parseTsToSeconds(seg[0]);
      const absEnd = start + parseTsToSeconds(seg[1]);
      const id = String(subtitles.length + 1); // 与 formatSrtContent 的 index+1 对齐
      subtitles.push([
        secondsToSrtTime(absStart),
        secondsToSrtTime(absEnd),
        text,
      ]);
      langCues.push({
        id,
        startMs: Math.round(absStart * 1000),
        endMs: Math.round(absEnd * 1000),
        lang,
      });
    }

    event.sender.send(
      'taskProgressChange',
      file,
      'extractSubtitle',
      Math.min(((i + 1) / nChunks) * 100, 100),
    );
    logMessage(
      `multilingual chunk ${i + 1}/${nChunks} @${start}s lang=${lang} (+${triples.length} cues)`,
      'info',
    );
  }

  await fs.promises.writeFile(srtFile, formatSrtContent(subtitles));

  // 语言旁路 sidecar（供翻译层混合标注用真实语言取代腳本猜测）
  const langMapFile = await writeLangMap(file, langCues);
  if (langMapFile) file.langMapFile = langMapFile;

  // 清理 chunk 暂存
  try {
    if (fs.existsSync(chunkWav)) fs.unlinkSync(chunkWav);
  } catch {
    /* ignore */
  }

  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
  logMessage(`multilingual transcribe done: ${subtitles.length} cues`, 'info');
  return srtFile;
}
