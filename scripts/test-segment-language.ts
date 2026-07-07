/// <reference path="./test-globals.d.ts" />
import { classifySegmentScript } from '../main/helpers/segmentLanguage';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(
      `✗ ${name}\n    expected: ${String(expected)}\n    actual:   ${String(actual)}`,
    );
  }
}

// 纯脚本
eq(classifySegmentScript('สวัสดีครับ'), 'th', 'pure thai');
eq(
  classifySegmentScript('Hello, welcome to this tutorial.'),
  'en',
  'pure english',
);
eq(classifySegmentScript('你好，欢迎观看'), 'zh', 'simplified chinese');
eq(classifySegmentScript('你好，歡迎觀看本教學'), 'zh', 'traditional chinese');

// 混排以主要脚本为准（忽略数字/标点/空白）
eq(classifySegmentScript('1,000 บาท'), 'th', 'thai dominant with digits');
eq(
  classifySegmentScript('OK 你好世界朋友们'),
  'zh',
  'cjk dominant over few latin',
);
eq(classifySegmentScript('Hello 你'), 'en', 'latin dominant over one han');

// 无语言信息 → other
eq(classifySegmentScript('12345'), 'other', 'digits only');
eq(classifySegmentScript('   '), 'other', 'whitespace only');
eq(classifySegmentScript('!?。，…'), 'other', 'punctuation only');
eq(classifySegmentScript(''), 'other', 'empty string');

if (failed > 0) {
  console.error(`segment language tests failed: ${failed}/${passed + failed}`);
  process.exit(1);
}

console.log(`segment language tests passed: ${passed}`);
