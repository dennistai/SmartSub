/// <reference path="./test-globals.d.ts" />
import {
  ANNOTATION,
  assembleMixedResults,
  classifyCues,
  createTraditionalNormalizer,
  whisperLangToScript,
} from '../main/translate/mixedAnnotation';
import type { Subtitle } from '../main/translate/types';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${name}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function cue(id: string, text: string): Subtitle {
  return {
    id,
    startEndTime: `00:00:0${id},000 --> 00:00:0${id},500`,
    content: text.split('\n'),
  };
}

// 四条混合字幕：繁中 / 简中 / 英文 / 泰文
const subtitles: Subtitle[] = [
  cue('1', '歡迎觀看'), // 繁中
  cue('2', '欢迎观看'), // 简中 -> 应转繁
  cue('3', 'Hello world'), // 英文
  cue('4', 'สวัสดี'), // 泰文
];

// --- classifyCues ---
const { scriptById, enCues, thCues } = classifyCues(subtitles);
eq(scriptById.get('1'), 'zh', 'classify: traditional -> zh');
eq(scriptById.get('2'), 'zh', 'classify: simplified -> zh');
eq(scriptById.get('3'), 'en', 'classify: english -> en');
eq(scriptById.get('4'), 'th', 'classify: thai -> th');
eq(
  enCues.map((c) => c.id),
  ['3'],
  'classify: en group',
);
eq(
  thCues.map((c) => c.id),
  ['4'],
  'classify: th group',
);

// --- assembleMixedResults ---
// 模拟翻译结果：英文与泰文都翻成（此处用简体以验证繁体归一）
const translatedBody = new Map<string, string>([
  ['3', '你好世界'], // 英文译文
  ['4', '你好'], // 泰文译文（两段式最终结果）
]);
const annotationById = new Map<string, string>([
  ['3', ANNOTATION.en!],
  ['4', ANNOTATION.th!],
]);
const normalize = createTraditionalNormalizer(false);
const results = assembleMixedResults({
  subtitles,
  scriptById,
  translatedBody,
  annotationById,
  normalizeTraditional: normalize,
});

eq(
  results.map((r) => r.id),
  ['1', '2', '3', '4'],
  'assemble: preserves order',
);
eq(
  results[0].targetContent,
  '歡迎觀看',
  'assemble: traditional unchanged, no annotation',
);
eq(
  results[1].targetContent,
  '歡迎觀看',
  'assemble: simplified converted to traditional, no annotation',
);
eq(
  results[2].targetContent,
  '你好世界\n（原始語言：英文）',
  'assemble: english translated + annotation on new line',
);
eq(
  results[3].targetContent,
  '你好\n（原始語言：泰文）',
  'assemble: thai translated + annotation on new line',
);
eq(
  results[2].startEndTime,
  subtitles[2].startEndTime,
  'assemble: timing preserved',
);
eq(results[3].sourceContent, 'สวัสดี', 'assemble: source content preserved');

// --- annotation survives punctuation removal (removePunctuation=true) ---
// 译文含中文标点会被去除，但注解行的全角括号/冒号必须保留。
const translatedBody2 = new Map<string, string>([['3', '你好，世界']]);
const normalize2 = createTraditionalNormalizer(true);
const results2 = assembleMixedResults({
  subtitles: [subtitles[2]],
  scriptById: new Map([['3', 'en']]),
  translatedBody: translatedBody2,
  annotationById: new Map([['3', ANNOTATION.en!]]),
  normalizeTraditional: normalize2,
});
eq(
  results2[0].targetContent,
  '你好 世界\n（原始語言：英文）',
  'assemble: body punctuation stripped but annotation parens/colon kept',
);

// --- all-Chinese file: no annotation, no translation needed ---
const zhOnly: Subtitle[] = [cue('1', '欢迎'), cue('2', '你好')];
const c2 = classifyCues(zhOnly);
eq(
  c2.enCues.length + c2.thCues.length,
  0,
  'classify: all-chinese -> no translation groups',
);
const r3 = assembleMixedResults({
  subtitles: zhOnly,
  scriptById: c2.scriptById,
  translatedBody: new Map(),
  annotationById: new Map(),
  normalizeTraditional: normalize,
});
eq(
  r3.map((r) => r.targetContent),
  ['歡迎', '你好'],
  'assemble: all-chinese normalized, no annotation',
);

// --- whisperLangToScript ---
eq(whisperLangToScript('th'), 'th', 'whisperLang: th');
eq(whisperLangToScript('en'), 'en', 'whisperLang: en');
eq(whisperLangToScript('zh'), 'zh', 'whisperLang: zh');
eq(whisperLangToScript('yue'), 'zh', 'whisperLang: yue → zh');
eq(whisperLangToScript('zh-Hant'), 'zh', 'whisperLang: zh-Hant → zh');
eq(whisperLangToScript('ja'), 'other', 'whisperLang: ja → other');

// --- classifyCues with langMap overrides script guess ---
const lmCues: Subtitle[] = [
  cue('1', 'OK GM'),
  cue('2', 'สวัสดี'),
  cue('3', '你好'),
];
// 无 langMap：'OK GM' 拉丁字母多 → 脚本判 en（正是要被真实语言取代的误判）
eq(
  classifyCues(lmCues).scriptById.get('1'),
  'en',
  'no langMap: OK GM → en by script',
);
// 有 langMap：真实语言 zh 覆盖脚本猜测
const lm = new Map<string, string>([
  ['1', 'zh'],
  ['2', 'th'],
  ['3', 'zh'],
]);
const cl = classifyCues(lmCues, lm);
eq(cl.scriptById.get('1'), 'zh', 'langMap overrides: OK GM → zh');
eq(cl.enCues.length, 0, 'langMap: no en group');
eq(
  cl.thCues.map((c) => c.id),
  ['2'],
  'langMap: th group from map',
);
// langMap 缺该 id → 回退脚本
const partial = new Map<string, string>([['2', 'th']]);
eq(
  classifyCues(lmCues, partial).scriptById.get('1'),
  'en',
  'langMap missing id → fallback to script',
);

if (failed > 0) {
  console.error(`mixed annotation tests failed: ${failed}/${passed + failed}`);
  process.exit(1);
}
console.log(`mixed annotation tests passed: ${passed}`);
