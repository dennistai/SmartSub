/**
 * 逐句（cue 层级）文字脚本判定：用于「混合语言 → 统一繁体中文并标注原始语言」流程。
 *
 * 泰文（U+0E00–U+0E7F）、CJK 汉字、拉丁字母三种脚本的 Unicode 区块互斥，
 * 因此以「主要脚本」判定原始语言是确定性的、免费的、且不需要 AI。
 * 简繁不在此判断——中文路由一律交给 chineseConvert.convertChineseText(text,'traditional')，
 * 该函式仅在检测到相反字形时才改写（已是繁体则不动）。
 */

export type SegmentScript = 'zh' | 'en' | 'th' | 'other';

/**
 * 判定一段文字的主要脚本。
 *
 * 逐 code point 计数三个互斥桶，刻意忽略数字、空白、标点（ASCII 与全角），
 * 让「1,000 บาท」「Hello!」这类混排以真正的表意/字母脚本为准。
 * 平手或三桶皆空 → 'other'（数字/符号/空白视为无语言信息，原样保留、不翻译、不标注）。
 */
export function classifySegmentScript(text: string): SegmentScript {
  if (!text) return 'other';

  let thai = 0;
  let cjk = 0;
  let latin = 0;

  for (const ch of text) {
    const code = ch.codePointAt(0)!;

    // 泰文：U+0E00–U+0E7F
    if (code >= 0x0e00 && code <= 0x0e7f) {
      thai++;
      continue;
    }

    // CJK 汉字：基本区 + 扩展 A + 兼容汉字
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++;
      continue;
    }

    // 拉丁字母 A–Z / a–z（不含数字，数字不带语言信息）
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin++;
      continue;
    }

    // 其余（数字、空白、各类标点、其他脚本）忽略
  }

  const max = Math.max(thai, cjk, latin);
  if (max === 0) return 'other';

  // 取主要脚本；并列时按 泰 > 中 > 英 的优先序（实务上三脚本互斥，极少并列）
  if (thai === max) return 'th';
  if (cjk === max) return 'zh';
  return 'en';
}
