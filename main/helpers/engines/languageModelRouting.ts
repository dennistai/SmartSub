/**
 * 多语言分段转录的「依语言路由模型」策略。
 *
 * 背景（见 test_data/breeze-vs-whisper-comparison.md 实测）：
 *   - 中文（台湾腔/中英夹杂）：Breeze-ASR-25 最佳。
 *   - 泰语：Breeze 明显退步（甚至被中文吞掉），应用 large-v3-turbo / large-v2。
 *   - 英文：large-v3-turbo 最佳。
 * 多语管线已用 MMS-LID 逐段判定语言（audioLid），故可在逐段转录时按语言选最合适的模型。
 *
 * 纯函数模块（零运行时依赖），便于单元测试直接导入——刻意不 import audioLid，
 * 避免把 whisper.ts 的重依赖图拖进纯逻辑单测。
 */

/** LID 语言标签，与 audioLid 的 `LidLang` 结构一致（'th' | 'zh' | 'en'）。 */
export type RouteLang = 'th' | 'zh' | 'en';

/** 语言 → 该语言的模型偏好清单（按优先级排序，取第一个「已安装」者）。 */
export type LanguageModelRoutes = Partial<Record<RouteLang, string[]>>;

/**
 * 依实测得到的默认路由。清单里放「去掉 ggml- 前缀与 .bin 后缀」的模型名，
 * 允许列多个量化变体作回退（如 large-v2 / large-v2-q5_0）。
 */
export const DEFAULT_LANGUAGE_MODEL_ROUTES: LanguageModelRoutes = {
  zh: ['breeze-asr-25'],
  th: ['large-v3-turbo', 'large-v2-q5_0', 'large-v2', 'large-v3'],
  en: ['large-v3-turbo', 'large-v3', 'large-v2-q5_0', 'large-v2'],
};

/**
 * 为某段音频（已知语言）挑选转录模型：
 * 返回「该语言偏好清单中第一个『已安装』的模型」；都没装 / 无语言 / 无该语言配置时回退 baseModel。
 * 这样「路由目标未下载」不会导致失败，只是静默退回用户所选的基础模型（优雅降级）。
 *
 * @param lang       MMS-LID 判定的语言（null 表示不可用 → 用 baseModel）
 * @param baseModel  用户为本任务所选的基础模型（去前后缀名，必定已安装）
 * @param installed  已安装 ggml 模型名列表（getModelsInstalled 输出）
 * @param routes     路由表（默认 DEFAULT_LANGUAGE_MODEL_ROUTES；可由设置覆盖）
 */
export function resolveModelForLanguage(
  lang: RouteLang | null,
  baseModel: string,
  installed: readonly string[],
  routes: LanguageModelRoutes = DEFAULT_LANGUAGE_MODEL_ROUTES,
): string {
  if (!lang) return baseModel;
  const prefs = routes[lang];
  if (!prefs?.length) return baseModel;
  const installedLower = installed.map((m) => m.toLowerCase());
  const match = prefs.find((cand) =>
    installedLower.includes(cand.toLowerCase()),
  );
  return match ?? baseModel;
}
