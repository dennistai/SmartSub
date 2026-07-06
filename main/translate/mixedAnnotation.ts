/**
 * 「混合语言标注」流程的纯逻辑（无 electron / 无网络依赖，便于单元测试）：
 * 逐条脚本分类、按原始顺序重组、繁体归一与原始语言注解注入。
 *
 * 编排部分（分组后调用 translateWithProvider、泰文两段式、进度、写盘）在 mixedLanguage.ts。
 */
import { Subtitle, TranslationResult } from './types';
import {
  convertChineseText,
  removeChineseSubtitlePunctuation,
} from '../helpers/chineseConvert';
import {
  classifySegmentScript,
  SegmentScript,
} from '../helpers/segmentLanguage';

/** 原始语言注解文案（另起一行写在译文下方）。 */
export const ANNOTATION: Partial<Record<SegmentScript, string>> = {
  en: '（原始語言：英文）',
  th: '（原始語言：泰文）',
};

/** 翻译失败占位前缀（与 ai.ts / api.ts 保持一致），用于泰文两段式跳过第二段。 */
export const FAILURE_PREFIX = '[翻译失败:';

/**
 * 统一繁体归一（+ 可选中文标点去除）。只作用于「本文」，注解行随后另行追加，
 * 避免注解的全角括号/冒号被标点去除清掉。
 */
export function createTraditionalNormalizer(
  removePunctuation: boolean,
): (body: string) => string {
  return (body: string): string => {
    if (!body) return body;
    let out = convertChineseText(body, 'traditional').text;
    if (removePunctuation) out = removeChineseSubtitlePunctuation(out);
    return out;
  };
}

/** whisper 偵測语言码 → SegmentScript（zh/yue/zh-* → zh；th；en；其余 → other）。 */
export function whisperLangToScript(lang: string): SegmentScript {
  const l = (lang || '').toLowerCase();
  if (l === 'th') return 'th';
  if (l === 'en') return 'en';
  if (l === 'yue' || l.startsWith('zh')) return 'zh';
  return 'other';
}

/**
 * 逐条按语言分类，并挑出需要翻译的英文 / 泰文条目（保序、保留 id）。
 * 若提供 langMap（转录期真实偵測语言，id→whisper码），优先使用；缺失才回退文字腳本猜测。
 */
export function classifyCues(
  subtitles: Subtitle[],
  langMap?: Map<string, string>,
): {
  scriptById: Map<string, SegmentScript>;
  enCues: Subtitle[];
  thCues: Subtitle[];
} {
  const scriptById = new Map<string, SegmentScript>();
  const enCues: Subtitle[] = [];
  const thCues: Subtitle[] = [];
  for (const cue of subtitles) {
    const detected = langMap?.get(cue.id);
    const script = detected
      ? whisperLangToScript(detected)
      : classifySegmentScript(cue.content.join('\n'));
    scriptById.set(cue.id, script);
    if (script === 'en') enCues.push(cue);
    else if (script === 'th') thCues.push(cue);
  }
  return { scriptById, enCues, thCues };
}

/**
 * 按原始字幕顺序重组为 TranslationResult[]，并注入注解。
 * - 中文/其他：本文即原文（繁体归一，中文以外无害）。
 * - 英文/泰文：本文为译文（失败时用占位/原文兜底、不加注解）。
 * - 注解行在繁体归一「之后」追加，保证全角标点不被清除。
 */
export function assembleMixedResults(args: {
  subtitles: Subtitle[];
  scriptById: Map<string, SegmentScript>;
  translatedBody: Map<string, string>;
  annotationById: Map<string, string>;
  normalizeTraditional: (body: string) => string;
}): TranslationResult[] {
  const {
    subtitles,
    scriptById,
    translatedBody,
    annotationById,
    normalizeTraditional,
  } = args;

  return subtitles.map((cue) => {
    const script = scriptById.get(cue.id);
    const originalText = cue.content.join('\n');
    const body =
      script === 'en' || script === 'th'
        ? (translatedBody.get(cue.id) ?? originalText)
        : originalText;

    let finalTarget = normalizeTraditional(body);
    const annotation = annotationById.get(cue.id);
    if (annotation) finalTarget += `\n${annotation}`;

    return {
      id: cue.id,
      startEndTime: cue.startEndTime,
      sourceContent: originalText,
      targetContent: finalTarget,
    };
  });
}
