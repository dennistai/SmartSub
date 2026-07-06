import {
  Provider,
  Subtitle,
  TranslationResult,
  TranslatorFunction,
} from './types';
import { translateWithProvider } from './services/translationProvider';
import { writeTranslationResults } from './writeResults';
import {
  ANNOTATION,
  FAILURE_PREFIX,
  assembleMixedResults,
  classifyCues,
  createTraditionalNormalizer,
} from './mixedAnnotation';
import { convertLanguageCode } from '../helpers/utils';
import { logMessage } from '../helpers/storeManager';
import { throwIfTaskCancelled } from '../helpers/taskContext';
import { IFormData } from '../../types';

/** 混合语言流程固定的目标枢纽：统一输出繁体中文。 */
const PIVOT_TARGET = 'zh-Hant';

type MixedArgs = {
  provider: Provider;
  subtitles: Subtitle[];
  formData: IFormData;
  translator: TranslatorFunction;
  retryCount: number;
  onProgress?: (progress: number) => void;
  fileSave: string;
  tempTranslatedFilePath: string;
  renderContentTemplate: string;
  postProcessBilingualSource: (content: string) => string;
  /** 转录期真实偵測语言（id→whisper码）；有则优先于文字腳本猜测。 */
  langMap?: Map<string, string>;
};

/**
 * 非 AI（传统 API）供应商的语向守卫：混合流程需要 th→en、en→zh-Hant 两个语向，
 * 任一不被该平台支持（convertLanguageCode 返回 null）则在写盘前抛出清晰的配置错误，
 * 引导用户改用 LLM 供应商。AI 供应商用自然语言名称提示，不受此限。
 */
function assertProviderSupportsMixed(provider: Provider): void {
  if (provider.isAi) return;
  const type = provider.type as Parameters<typeof convertLanguageCode>[1];
  const pairs: Array<[string, string]> = [
    ['th', 'en'],
    ['en', PIVOT_TARGET],
  ];
  for (const [from, to] of pairs) {
    if (
      convertLanguageCode(from, type) === null ||
      convertLanguageCode(to, type) === null
    ) {
      throw new Error(
        `当前翻译服务「${provider.name}」不支持混合语言标注所需的语向（${from}→${to}）。请改用 LLM 供应商（如 OpenAI 风格 API）。`,
      );
    }
  }
}

/**
 * 「混合语言 → 统一繁体中文 + 逐句标注原始语言」翻译流程。
 *
 * 逐条字幕按主要脚本路由：中文只做简→繁归一（不翻译、不标注）；英文翻成繁中并标注
 * 「（原始語言：英文）」；泰文强制两段式 th→en→zh-Hant 并标注「（原始語言：泰文）」。
 * 各语言分组分别调用 translateWithProvider（同语言、单一语向），因此不会触发 ai.ts/api.ts
 * 的「返回条数需与请求一致」校验错位。最后按原始顺序重组、注入注解、一次性写盘。
 */
export async function translateMixedWithAnnotation(
  args: MixedArgs,
): Promise<void> {
  const {
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
  } = args;

  assertProviderSupportsMixed(provider);

  const removePunctuation = formData?.removeChinesePunctuation === true;
  const normalizeTraditional = createTraditionalNormalizer(removePunctuation);

  // 1) 逐条分类（有转录期真实语言则优先，否则回退文字腳本猜测）
  const { scriptById, enCues, thCues } = classifyCues(subtitles, langMap);

  logMessage(
    `混合语言标注：共 ${subtitles.length} 条，英文 ${enCues.length} 条，泰文 ${thCues.length} 条（其余中文/其他本地处理）`,
    'info',
  );

  // 进度按「翻译单位」加权：英文 1 单位/条，泰文 2 单位/条（两段翻译）。
  const totalUnits = enCues.length + thCues.length * 2;
  let doneUnits = 0;
  const makeSubProgress = (unitCount: number) => {
    const base = doneUnits;
    return (p: number) => {
      if (!onProgress || totalUnits <= 0) return;
      const progressed =
        base + (Math.min(Math.max(p, 0), 100) / 100) * unitCount;
      onProgress(Math.min((progressed / totalUnits) * 100, 100));
    };
  };

  // 译文本文（繁体归一前）：id → body
  const translatedBody = new Map<string, string>();
  const annotationById = new Map<string, string>();

  // 2) 英文组：en → zh-Hant
  if (enCues.length > 0) {
    throwIfTaskCancelled();
    const results = (await translateWithProvider(
      provider,
      enCues,
      'en',
      PIVOT_TARGET,
      translator,
      makeSubProgress(enCues.length),
      undefined,
      retryCount,
    )) as TranslationResult[];
    for (const r of results) {
      translatedBody.set(r.id, r.targetContent);
      if (!r.targetContent.startsWith(FAILURE_PREFIX)) {
        annotationById.set(r.id, ANNOTATION.en!);
      }
    }
    doneUnits += enCues.length;
  }

  // 3) 泰文组：两段式 th → en → zh-Hant
  if (thCues.length > 0) {
    throwIfTaskCancelled();
    // Pass 1: th → en（中介英文仅用于第二段翻译与日志，不写入任何输出文件）
    const en1 = (await translateWithProvider(
      provider,
      thCues,
      'th',
      'en',
      translator,
      makeSubProgress(thCues.length),
      undefined,
      retryCount,
    )) as TranslationResult[];
    doneUnits += thCues.length;

    const en1ById = new Map(en1.map((r) => [r.id, r.targetContent]));
    // 第一段成功的条目进入第二段；失败的保留占位、不再翻译、不加注解。
    const midSubs: Subtitle[] = [];
    for (const cue of thCues) {
      const mid = en1ById.get(cue.id) ?? '';
      if (!mid || mid.startsWith(FAILURE_PREFIX)) {
        translatedBody.set(cue.id, mid || cue.content.join('\n'));
        logMessage(`泰文第一段翻译失败，跳过第二段: cue ${cue.id}`, 'warning');
        continue;
      }
      logMessage(`泰文中介英文 cue ${cue.id}: ${mid}`, 'info');
      midSubs.push({
        id: cue.id,
        startEndTime: cue.startEndTime,
        content: mid.split('\n'),
      });
    }

    // Pass 2: en → zh-Hant
    if (midSubs.length > 0) {
      throwIfTaskCancelled();
      const zh2 = (await translateWithProvider(
        provider,
        midSubs,
        'en',
        PIVOT_TARGET,
        translator,
        makeSubProgress(midSubs.length),
        undefined,
        retryCount,
      )) as TranslationResult[];
      for (const r of zh2) {
        translatedBody.set(r.id, r.targetContent);
        if (!r.targetContent.startsWith(FAILURE_PREFIX)) {
          annotationById.set(r.id, ANNOTATION.th!);
        }
      }
    }
    doneUnits += midSubs.length;
  }

  // 4) 按原始顺序重组 + 注入注解
  const results = assembleMixedResults({
    subtitles,
    scriptById,
    translatedBody,
    annotationById,
    normalizeTraditional,
  });

  // 5) 一次性写盘（本路径不再跑 postProcessTarget：本文已归一、注解须原样保留）
  await writeTranslationResults({
    results,
    fileSave,
    tempTranslatedFilePath,
    renderContentTemplate,
    postProcessTarget: undefined,
    postProcessBilingualSource,
  });

  onProgress?.(100);
}
