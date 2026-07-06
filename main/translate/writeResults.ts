import { TranslationResult } from './types';
import { renderTemplate } from '../helpers/utils';
import { appendToFile } from './utils/file';
import { logMessage } from '../helpers/storeManager';

/**
 * 把一批翻译结果按内容模板组装并追加写入「目标字幕文件」与「暂存纯译文文件」。
 *
 * 由默认翻译路径（index.ts 的 handleTranslationResult）与「混合语言标注」路径共用，
 * 以确保两条路径的写盘格式完全一致。
 *
 * - `postProcessTarget` 可选：默认路径传入（做简繁归一 + 可选中文标点去除）；
 *   混合语言路径已在上游对「本文」套用过后处理并追加了「（原始语言：…）」注解行，
 *   若此处再跑一次标点去除会把注解的全角括号/冒号清掉，故该路径传 undefined。
 */
export async function writeTranslationResults(opts: {
  results: TranslationResult[];
  fileSave: string;
  tempTranslatedFilePath: string;
  renderContentTemplate: string;
  postProcessTarget?: (content: string) => string;
  postProcessBilingualSource: (content: string) => string;
}): Promise<void> {
  const {
    results,
    fileSave,
    tempTranslatedFilePath,
    renderContentTemplate,
    postProcessTarget,
    postProcessBilingualSource,
  } = opts;

  let concatContent = '';
  let tempTranslatedContent = '';

  for (const result of results) {
    // 目标译文后处理（默认路径：简繁归一 + 可选标点去除；混合路径：已在上游套用，跳过）
    const targetContent = postProcessTarget
      ? postProcessTarget(result.targetContent)
      : result.targetContent;
    // 双语内嵌源文行后处理（仅生成并翻译 + 中文源 + 开关开启时去标点）
    const sourceContent = postProcessBilingualSource(result.sourceContent);

    // 根据用户设置的模板生成目标文件内容
    concatContent += `${result.id}\n${result.startEndTime}\n${renderTemplate(
      renderContentTemplate,
      {
        sourceContent,
        targetContent,
      },
    )}`;

    // 对临时文件，只添加纯翻译内容
    tempTranslatedContent += `${result.id}\n${result.startEndTime}\n${targetContent}\n\n`;
  }

  // 保存到目标文件
  logMessage(`append to file ${fileSave}`);
  await appendToFile(fileSave, concatContent);

  // 保存到临时纯翻译文件
  logMessage(`append to temp file ${tempTranslatedFilePath}`);
  await appendToFile(tempTranslatedFilePath, tempTranslatedContent);
}
