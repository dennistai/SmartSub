/**
 * 语言旁路 sidecar：多语言分段转录时，把「每条字幕 → 该段偵測到的真实语言」写成临时 JSON，
 * 供翻译层的「混合语言标注」用真实语言取代文字腳本猜测。
 *
 * 存放于临时目录（非用户视频目录）：它只是「转录 → 翻译」的桥接产物，用完即可弃，
 * 不像校对 sidecar 需要长期留存。以 SRT 1-based 序号 `id` 与字幕条目对齐。
 */
import fs from 'fs';
import path from 'path';
import type { IFiles } from '../../types';
import { ensureTempDir, getMd5 } from './fileUtils';
import { logMessage } from './storeManager';

export interface LangMapCue {
  id: string;
  startMs: number;
  endMs: number;
  /** whisper 偵測语言码：zh / th / en / yue / ja ... */
  lang: string;
}

export interface LangMapFile {
  version: 1;
  meta: { createdAt: string };
  cues: LangMapCue[];
}

/** 临时目录下的语言旁路文件路径（按文件 uuid / md5 命名，避免污染用户目录）。 */
export function getLangMapPath(file: IFiles): string {
  const tempDir = ensureTempDir();
  const id = file.uuid || getMd5(file.filePath || file.fileName || 'langmap');
  return path.join(tempDir, `${id}.langmap.json`);
}

/** 写入语言旁路 sidecar；失败仅告警不阻断主流程。返回写入路径或 null。 */
export async function writeLangMap(
  file: IFiles,
  cues: LangMapCue[],
): Promise<string | null> {
  try {
    const data: LangMapFile = {
      version: 1,
      meta: { createdAt: new Date().toISOString() },
      cues,
    };
    const outPath = getLangMapPath(file);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(
      outPath,
      JSON.stringify(data, null, 2),
      'utf-8',
    );
    logMessage(`lang map written: ${outPath} (${cues.length} cues)`, 'info');
    return outPath;
  } catch (error) {
    logMessage(`write lang map failed: ${error}`, 'warning');
    return null;
  }
}

/** 读取语言旁路 sidecar → Map<id, lang>；缺失/损坏返回空 Map（调用方回退腳本猜测）。 */
export function readLangMap(filePath?: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!filePath || !fs.existsSync(filePath)) return map;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, 'utf-8'),
    ) as LangMapFile;
    if (parsed?.version === 1 && Array.isArray(parsed.cues)) {
      for (const cue of parsed.cues) {
        if (cue?.id && cue?.lang) map.set(String(cue.id), cue.lang);
      }
    }
  } catch (error) {
    logMessage(`read lang map failed: ${error}`, 'warning');
  }
  return map;
}
