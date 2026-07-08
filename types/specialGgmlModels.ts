/**
 * 「特殊来源」的 builtin(ggml) 模型表：这些模型不在标准 `ggerganov/whisper.cpp` 仓库、
 * 或远端文件名不遵循 `ggml-${model}.bin` 惯例，因此下载时需要按模型覆写「仓库 + 远端文件名」。
 *
 * 关键约束：本机仍统一存成 `ggml-${localName}.bin`（localName 即本表的 key），
 * 这样 `getModelsInstalled()` 的通用扫描、builtinEngine 的 `modelPath` 拼接、下拉列表等
 * 全部零改动即可识别与运行。仅「下载来源 URL」这一处按本表覆写。
 *
 * 纯数据模块，不依赖 electron/store，main 与 renderer 皆可安全导入。
 */
export interface SpecialGgmlModelSource {
  /** HuggingFace 仓库 id（`owner/repo`）。 */
  repo: string;
  /** 该仓库内的远端文件名（下载后本机改名为 `ggml-${localName}.bin`）。 */
  remoteFile: string;
  /** 该仓库是否提供 CoreML encoder zip（多数第三方转换版没有）。 */
  hasCoreML: boolean;
}

/** key = 本机模型名（`ggml-${key}.bin`），value = 远端来源覆写。 */
export const SPECIAL_GGML_MODELS: Record<string, SpecialGgmlModelSource> = {
  // 联发科 Breeze-ASR-25（Whisper-large-v2 微调，优化台湾腔中文 + 中英夹杂）。
  // 采用社群预转的 whisper.cpp q5_k 量化版（≈1.08GB，与 large-v2-q5_0 同量级）。
  'breeze-asr-25': {
    repo: 'alan314159/Breeze-ASR-25-whispercpp',
    remoteFile: 'ggml-model-q5_k.bin',
    hasCoreML: false,
  },
};

/** 查表：命中返回来源覆写，未命中返回 null（走标准 whisper.cpp 下载路径）。 */
export function getSpecialGgmlSource(
  model?: string,
): SpecialGgmlModelSource | null {
  if (!model) return null;
  return SPECIAL_GGML_MODELS[model.toLowerCase()] ?? null;
}
