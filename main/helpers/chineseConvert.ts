/**
 * 中文简繁自动归一：当源语言为中文时，把「转写生成」的字幕统一成期望字形。
 *
 * 背景：Whisper 的 `zh` 不区分简/繁，简繁由模型解码倾向决定（tiny/base 强烈倾向繁体），
 * initial_prompt 又压不住。此处用纯 JS 的 opencc-js（词组级，无原生依赖）做确定性后处理。
 * 仅当检测到「相反字形」时才实际转换（转换前后不同即命中），避免无谓改写。
 */
import { Converter } from 'opencc-js';

export type ChineseScript = 'simplified' | 'traditional';

type ConvertFn = (text: string) => string;

let t2sConverter: ConvertFn | null = null;
let s2twConverter: ConvertFn | null = null;
let s2twpConverter: ConvertFn | null = null;

/** 繁（OpenCC 标准）→ 简（大陆）。惰性创建并缓存。 */
function getT2S(): ConvertFn {
  if (!t2sConverter) t2sConverter = Converter({ from: 't', to: 'cn' });
  return t2sConverter;
}

/** 简（大陆）→ 繁（台湾字形，不转用词）。惰性创建并缓存。 */
function getS2TW(): ConvertFn {
  if (!s2twConverter) s2twConverter = Converter({ from: 'cn', to: 'tw' });
  return s2twConverter;
}

/** 简（大陆）→ 繁（台湾字形 + 台湾用词）。惰性创建并缓存。 */
function getS2TWP(): ConvertFn {
  if (!s2twpConverter) s2twpConverter = Converter({ from: 'cn', to: 'twp' });
  return s2twpConverter;
}

/**
 * 由源语言代码推断期望中文字形：
 * - `zh` / `zh-CN` / `zh-Hans` → 'simplified'
 * - `zh-Hant` / `zh-TW` / `zh-HK` → 'traditional'
 * - 其它（含 `auto`、`yue` 粤语、非中文）→ null（不自动转换）
 */
export function getDesiredChineseScript(lang?: string): ChineseScript | null {
  if (!lang) return null;
  const c = lang.toLowerCase();
  if (!c.startsWith('zh')) return null;
  if (c.includes('hant') || c.includes('tw') || c.includes('hk')) {
    return 'traditional';
  }
  return 'simplified';
}

export interface ConvertChineseOptions {
  /** 目标为繁体时是否套用台湾用词转换（s2twp）；否则只转字形（s2tw）。默认 false。 */
  taiwanPhrase?: boolean;
}

/**
 * 按期望字形转换文本；仅当结果与原文不同（即检测到相反字形）时标记 converted。
 * 对 SRT 全文安全：序号/时间码/`-->` 均为 ASCII，OpenCC 不会改动。
 */
export function convertChineseText(
  text: string,
  desired: ChineseScript,
  opts?: ConvertChineseOptions,
): { text: string; converted: boolean } {
  if (!text) return { text, converted: false };
  const convert =
    desired === 'simplified'
      ? getT2S()
      : opts?.taiwanPhrase
        ? getS2TWP()
        : getS2TW();
  const out = convert(text);
  return { text: out, converted: out !== text };
}

/** 统计两串对应位置不同的字数；长度不同时以「长度差 + 公共区差异」保守计数。 */
function countChangedChars(a: string, b: string): number {
  if (a === b) return 0;
  const len = Math.min(a.length, b.length);
  let diff = Math.abs(a.length - b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}

/**
 * 侦测文本主体中文字形（与转写模型解耦，以实际输出为准）。
 * 用字形级两向转换各自「改动字数」比较：
 *  - simplifiedSignal：s2tw 会改动的字数（= 简体专用字）
 *  - traditionalSignal：t2s 会改动的字数（= 繁体专用字）
 * 皆为 0 → 'unknown'（无可辨识中文字）。tie-break 偏繁：
 * 唯有 simplifiedSignal > traditionalSignal 才判 'simplified'。
 */
export function detectChineseScript(text: string): ChineseScript | 'unknown' {
  if (!text) return 'unknown';
  const simplifiedSignal = countChangedChars(text, getS2TW()(text));
  const traditionalSignal = countChangedChars(text, getT2S()(text));
  if (simplifiedSignal === 0 && traditionalSignal === 0) return 'unknown';
  return simplifiedSignal > traditionalSignal ? 'simplified' : 'traditional';
}

/**
 * 结合全局设定解析目标字形：
 *  - 来源非中文 → null（不处理）
 *  - 来源中文 + alwaysTraditional → 一律 'traditional'
 *  - 来源中文 + !alwaysTraditional → 沿用 getDesiredChineseScript(sourceLanguage)
 */
export function resolveDesiredChineseScript(
  sourceLanguage: string | undefined,
  alwaysTraditional: boolean,
): ChineseScript | null {
  const base = getDesiredChineseScript(sourceLanguage);
  if (base !== null && alwaysTraditional) return 'traditional';
  return base;
}

/**
 * 需要被替换为空格的中文/全角标点集合（issue #330）。
 *
 * 仅收录 CJK/全角标点，刻意不含 ASCII 逗号/句号，避免误伤数字（1,000 / 3.14）、
 * 缩写、英文混排等。涵盖：逗号、句号、顿号、问号、叹号、分号、冒号、省略号、
 * 间隔号、各类引号/括号/书名号、破折号/波浪号等，尽量把成对标点一并清理。
 */
const CJK_PUNCTUATION_CHARS = [
  '\u3000', // 　 表意空格
  '\u3001', // 、 顿号
  '\u3002', // 。 句号
  '\u3003', // 〃 同上符号
  '\u3008',
  '\u3009', // 〈 〉
  '\u300A',
  '\u300B', // 《 》
  '\u300C',
  '\u300D', // 「 」
  '\u300E',
  '\u300F', // 『 』
  '\u3010',
  '\u3011', // 【 】
  '\u3014',
  '\u3015', // 〔 〕
  '\u3016',
  '\u3017', // 〖 〗
  '\u3018',
  '\u3019', // 〘 〙
  '\u301A',
  '\u301B', // 〚 〛
  '\u301C', // 〜 波浪线
  '\u301D',
  '\u301E',
  '\u301F', // 〝 〞 〟 引号
  '\u3030', // 〰 波浪线
  '\uFF01', // ！
  '\uFF02', // ＂
  '\uFF03', // ＃
  '\uFF05', // ％
  '\uFF06', // ＆
  '\uFF07', // ＇
  '\uFF08',
  '\uFF09', // （ ）
  '\uFF0A', // ＊
  '\uFF0C', // ，
  '\uFF0E', // ．
  '\uFF0F', // ／
  '\uFF1A', // ：
  '\uFF1B', // ；
  '\uFF1F', // ？
  '\uFF20', // ＠
  '\uFF3B',
  '\uFF3C',
  '\uFF3D', // ［ ＼ ］
  '\uFF3E', // ＾
  '\uFF40', // ｀
  '\uFF5B',
  '\uFF5C',
  '\uFF5D',
  '\uFF5E', // ｛ ｜ ｝ ～
  '\uFF5F',
  '\uFF60', // ｟ ｠
  '\uFF62',
  '\uFF63', // ｢ ｣ 半角书名号
  '\uFF64', // ､ 半角顿号
  '\uFF65', // ･ 半角间隔号
  '\u00B7', // · 间隔号
  '\u2010',
  '\u2011',
  '\u2012',
  '\u2013',
  '\u2014',
  '\u2015', // 各类连接/破折号
  '\u2018',
  '\u2019', // ‘ ’
  '\u201C',
  '\u201D', // “ ”
  '\u2026', // … 省略号
  '\u2027', // ‧ 连点
  '\u2022', // • 项目符号
  '\u2236', // ∶ 比号（常被当作冒号）
  '\uFE10',
  '\uFE11',
  '\uFE12',
  '\uFE13',
  '\uFE14',
  '\uFE15',
  '\uFE16',
  '\uFE17',
  '\uFE18',
  '\uFE19', // 竖排标点
  '\uFE30',
  '\uFE31',
  '\uFE32',
  '\uFE33', // 竖排连接号
  '\uFE4F', // ﹏ 波浪下划线
].join('');

const CJK_PUNCTUATION_REGEX = new RegExp(`[${CJK_PUNCTUATION_CHARS}]`, 'g');
// 替换标点后留下的空白（不含换行）压缩与行首尾修剪
const INLINE_SPACE_RUN_REGEX = /[^\S\r\n]{2,}/g;
const LINE_EDGE_SPACE_REGEX = /^[^\S\r\n]+|[^\S\r\n]+$/g;

/**
 * 把中文/全角标点替换为空格，并清理由此产生的多余空白（issue #330）。
 *
 * 逐行处理：标点→空格 → 合并连续空白（保留换行）→ 去行首尾空格。
 * 仅作用于传入的文本（调用方应只传译文内容，勿含序号/时间码）。
 */
export function removeChineseSubtitlePunctuation(text: string): string {
  if (!text) return text;
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(CJK_PUNCTUATION_REGEX, ' ')
        .replace(INLINE_SPACE_RUN_REGEX, ' ')
        .replace(LINE_EDGE_SPACE_REGEX, ''),
    )
    .join('\n');
}
