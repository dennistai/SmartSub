import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Provider, TranslationResult } from './types';
import { CONTENT_TEMPLATES } from './constants';
import { createOrClearFile } from './utils/file';
import { writeTranslationResults } from './writeResults';
import { translateMixedWithAnnotation } from './mixedLanguage';
import { readLangMap } from '../helpers/langMapData';
import {
  detectSubtitleFormatFromContent,
  parseSubtitleEntries,
} from '../helpers/subtitleFormats';
import {
  translateWithProvider,
  TRANSLATOR_MAP,
} from './services/translationProvider';
import { getSrtFileName } from '../helpers/utils';
import { logMessage, store } from '../helpers/storeManager';
import { IFiles, IFormData } from '../../types';
import { ensureTempDir } from '../helpers/fileUtils';
import { isTaskCancelledError } from '../helpers/taskContext';
import { assertValidTestTranslation } from './utils/error';
import {
  getDesiredChineseScript,
  convertChineseText,
  removeChineseSubtitlePunctuation,
} from '../helpers/chineseConvert';

/**
 * 解析「中文标点去除」生效值：任务级单开关（issue #330）。
 */
function resolveRemoveChinesePunctuation(
  formData: IFormData | undefined,
): boolean {
  return formData?.removeChinesePunctuation === true;
}

/**
 * 解析「混合语言标注」生效值：任务级专用开关。
 * 开启后走逐条脚本路由 + 统一繁体 + 原始语言注解的独立流程。
 */
function resolveAnnotateMixedSourceLanguage(
  formData: IFormData | undefined,
): boolean {
  return formData?.annotateMixedSourceLanguage === true;
}

export default async function translate(
  event,
  file: IFiles,
  formData: IFormData,
  provider: Provider,
  onProgress?: (progress: number) => void,
  maxRetries?: number,
): Promise<boolean> {
  const {
    translateContent,
    targetSrtSaveOption,
    customTargetSrtFileName,
    sourceLanguage,
    targetLanguage,
    translateRetryTimes,
  } = formData || {};
  const { fileName, directory, srtFile } = file;

  // 如果参数中有指定重试次数，则使用参数值，否则使用表单中的值或默认为2
  const retryCount =
    maxRetries !== undefined
      ? maxRetries
      : translateRetryTimes
        ? parseInt(translateRetryTimes)
        : 0;
  const renderContentTemplate = CONTENT_TEMPLATES[translateContent];

  // 译文后处理：
  // 1) 目标为中文时按简/繁做确定性归一，兜底 Ai 概率性输出繁体（issue #332）。
  // 2) 按「中文标点去除」生效值，把中文标点替换为空格（issue #330）。
  const desiredTargetScript = getDesiredChineseScript(targetLanguage);
  const isChineseTarget = desiredTargetScript !== null;
  const removePunctuation = resolveRemoveChinesePunctuation(formData);
  // 译文台湾用词开关：与 ASR 源字幕一致（全局设置 openccPhraseConversion，默认关）
  const taiwanPhrase = store.get('settings')?.openccPhraseConversion === true;
  const postProcessTarget = (content: string): string => {
    if (!content) return content;
    let out = content;
    if (desiredTargetScript) {
      out = convertChineseText(out, desiredTargetScript, { taiwanPhrase }).text;
    }
    if (removePunctuation && isChineseTarget) {
      out = removeChineseSubtitlePunctuation(out);
    }
    return out;
  };

  // 双语字幕内嵌「源文行」的标点后处理（issue #330）：
  // 仅当源为中文、开关开启、且源字幕由 ASR 生成（generateAndTranslate）时才去标点；
  // translateOnly 的源为用户导入字幕，保持原样。源字幕简繁归一已在 fileProcessor 完成，
  // 翻译输入仍保留标点（不影响断句质量），此处只清理写入双语文件的源文展示。
  const isChineseSource = getDesiredChineseScript(sourceLanguage) !== null;
  const isGeneratedSource = formData?.taskType === 'generateAndTranslate';
  const removeSourcePunctuation =
    removePunctuation && isChineseSource && isGeneratedSource;
  const postProcessBilingualSource = (content: string): string => {
    if (!content) return content;
    return removeSourcePunctuation
      ? removeChineseSubtitlePunctuation(content)
      : content;
  };

  try {
    const translator = TRANSLATOR_MAP[provider.type];
    if (!translator) {
      throw new Error(`Unknown translation provider: ${provider.type}`);
    }

    logMessage(
      `Translation started using ${provider.type}, max retries: ${retryCount}`,
      'info',
    );

    // 源字幕按扩展名+内容自动识别格式（srt/vtt/ass/lrc），统一解析为内部 Subtitle 结构
    const rawSourceContent = await fs.promises.readFile(srtFile, 'utf-8');
    const subtitles = parseSubtitleEntries(
      rawSourceContent,
      detectSubtitleFormatFromContent(srtFile, rawSourceContent),
    );
    if (subtitles.length === 0) {
      throw new Error(
        `无法读取字幕内容，请确认文件包含有效的字幕时间轴: ${srtFile}`,
      );
    }

    const templateData = {
      fileName,
      sourceLanguage,
      targetLanguage,
      model: '',
      translateProvider: provider.name,
    };
    const targetSrtFileName = getSrtFileName(
      targetSrtSaveOption,
      fileName,
      targetLanguage,
      customTargetSrtFileName,
      templateData,
    );

    const fileSave = path.join(directory, `${targetSrtFileName}.srt`);
    file.translatedSrtFile = fileSave;
    await createOrClearFile(fileSave);

    // 生成临时纯翻译文件，无论是否是双语字幕
    const tempDir = ensureTempDir();
    const tempTranslatedFileName = `${uuidv4()}.srt`;
    const tempTranslatedFilePath = path.join(tempDir, tempTranslatedFileName);
    file.tempTranslatedSrtFile = tempTranslatedFilePath;
    await createOrClearFile(tempTranslatedFilePath);

    logMessage(
      `Created temporary pure translation file: ${tempTranslatedFilePath}`,
      'info',
    );

    const handleTranslationResult = async (results: TranslationResult[]) => {
      await writeTranslationResults({
        results,
        fileSave,
        tempTranslatedFilePath,
        renderContentTemplate,
        postProcessTarget,
        postProcessBilingualSource,
      });
    };

    // 混合语言标注（专用开关）：逐条按脚本路由，统一输出繁体中文并标注原始语言。
    // 走独立分支，完全不影响既有单一语向翻译路径（开关默认关闭）。
    if (resolveAnnotateMixedSourceLanguage(formData)) {
      // 多语言转录留下的语言旁路（id→真实偵測语言），有则优先于文字腳本猜测
      const langMap = readLangMap(file.langMapFile);
      await translateMixedWithAnnotation({
        provider,
        subtitles,
        formData,
        translator,
        retryCount,
        onProgress,
        fileSave,
        tempTranslatedFilePath,
        renderContentTemplate,
        postProcessBilingualSource,
        langMap,
      });
      logMessage('Mixed-language annotated translation completed', 'info');
      return true;
    }

    await translateWithProvider(
      provider,
      subtitles,
      sourceLanguage,
      targetLanguage,
      translator,
      onProgress,
      handleTranslationResult,
      retryCount,
    );

    logMessage('Translation completed', 'info');
    return true;
  } catch (error) {
    if (!isTaskCancelledError(error)) {
      event.sender.send('message', error.message || error);
    }
    throw error;
  }
}

export async function testTranslation(
  provider: Provider,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<{ translation: string; analysis?: any }> {
  // 样本文本跟随源语言，避免「中文源」却拿英文样本测试
  const sampleText = sourceLanguage?.startsWith('zh') ? '你好' : 'Hello';
  const testSubtitle = {
    id: '1',
    startEndTime: '00:00:01,000 --> 00:00:04,000',
    content: [sampleText],
  };

  try {
    const translator = TRANSLATOR_MAP[provider.type];
    if (!translator) {
      throw new Error(`Unknown translation provider: ${provider.type}`);
    }

    const startTime = Date.now();
    const results = await translateWithProvider(
      provider,
      [testSubtitle],
      sourceLanguage,
      targetLanguage,
      translator,
    );

    let translation: string;
    if (provider.isAi && provider.useBatchTranslation) {
      translation = (results as string[])[0];
    } else {
      translation = (results as TranslationResult[])[0].targetContent;
    }

    assertValidTestTranslation(translation);

    // For now, return basic result until we implement full analysis
    // TODO: Add thinking mode analysis when we have access to raw API response
    return {
      translation,
      analysis: {
        response_time_ms: Date.now() - startTime,
        provider_name: provider.name,
        model_name: provider.modelName,
        test_completed: true,
      },
    };
  } catch (error) {
    throw error;
  }
}
