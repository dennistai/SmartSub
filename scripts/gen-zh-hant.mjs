#!/usr/bin/env node
/**
 * 由简体语系 (zh) 自动生成繁体语系 (zh-Hant)。
 *
 * 用纯 JS 的 opencc-js（词组级，简→繁标准）逐个 JSON 转换「值」，key 与
 * `{{插值}}` 占位符均为 ASCII，OpenCC 不会改动。日后只需维护 zh/，再跑
 * `yarn i18n:zh-hant`（或 npm run）即可同步繁体。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Converter } from 'opencc-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = path.join(root, 'renderer/public/locales');
const srcLoc = 'zh';
const dstLoc = 'zh-Hant';

const s2t = Converter({ from: 'cn', to: 't' });

/** 递归转换：仅转换字符串值，保留对象结构与所有 key。 */
const convert = (value) => {
  if (typeof value === 'string') return s2t(value);
  if (Array.isArray(value)) return value.map(convert);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, convert(v)]),
    );
  }
  return value;
};

const srcDir = path.join(localesDir, srcLoc);
const dstDir = path.join(localesDir, dstLoc);
fs.mkdirSync(dstDir, { recursive: true });

const files = fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

for (const file of files) {
  const src = JSON.parse(fs.readFileSync(path.join(srcDir, file), 'utf8'));
  const out = convert(src);
  fs.writeFileSync(
    path.join(dstDir, file),
    JSON.stringify(out, null, 2) + '\n',
    'utf8',
  );
  console.log(`✓ ${srcLoc}/${file} → ${dstLoc}/${file}`);
}

console.log(`\n生成完成：${files.length} 个语系文件 → ${dstLoc}/`);
