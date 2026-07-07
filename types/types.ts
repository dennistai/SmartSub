import type { EngineStatus, TranscriptionEngine } from './engine';

export interface ISystemInfo {
  modelsInstalled: string[];
  modelsPath: string;
  downloadingModels: string[];
  totalMemoryGB?: number;
  fasterWhisperModelsInstalled?: string[];
  fasterWhisperModelsPath?: string;
  pythonEngineStatus?: EngineStatus;
  /** funasr 引擎包是否已安装 */
  funasrEngineInstalled?: boolean;
  /** funasr 共用 VAD 是否已安装 */
  funasrVadInstalled?: boolean;
  /** 已安装的 funasr ASR 模型 id（如 ['sensevoice-small','paraformer-zh']） */
  funasrAsrModelsInstalled?: string[];
  /** funasr 模型根目录（固定路径，仅展示用，不可更改） */
  funasrModelsPath?: string;
  /** qwen 引擎包（sherpa-onnx，与 funasr 同库）是否已安装 */
  qwenEngineInstalled?: boolean;
  /** qwen 共用 silero VAD 是否已安装 */
  qwenVadInstalled?: boolean;
  /** 已安装的 qwen 模型 id（如 ['qwen3-asr-0.6b']） */
  qwenModelsInstalled?: string[];
  /** qwen 模型根目录（固定路径，仅展示用，不可更改） */
  qwenModelsPath?: string;
  /** fireRed 引擎包（sherpa-onnx，与 funasr 同库）是否已安装 */
  fireRedEngineInstalled?: boolean;
  /** fireRed 共用 silero VAD 是否已安装 */
  fireRedVadInstalled?: boolean;
  /** 已安装的 fireRed 模型 id（如 ['fire-red-asr-large-zh-en']） */
  fireRedModelsInstalled?: string[];
  /** fireRed 模型根目录（固定路径，仅展示用，不可更改） */
  fireRedModelsPath?: string;
}

export interface IFiles {
  uuid: string;
  filePath: string;
  fileName: string;
  fileExtension: string;
  directory: string;
  extractAudio?: boolean;
  extractSubtitle?: boolean;
  translateSubtitle?: boolean;
  audioFile?: string;
  srtFile?: string;
  tempSrtFile?: string;
  tempAudioFile?: string;
  translatedSrtFile?: string;
  tempTranslatedSrtFile?: string;
  /** 校对用无损中间态 sidecar，保存源文/译文/时间轴，避免直接读写有损交付物。 */
  proofreadDataFile?: string;
  /** 多语言分段转录留下的语言旁路 sidecar（临时）：id→每段偵測到的真实语言，供混合标注取代腳本猜测。 */
  langMapFile?: string;
  /** 本次转写实际使用的后端标签（如 "CUDA 12.4.0" / "Vulkan" / "CPU"） */
  whisperBackend?: string;
  /** 该文件走了内封软字幕直提（跳过抽音频 + ASR）：用于任务列表标识 */
  embeddedSubtitle?: boolean;
  /** 媒体总时长（秒），抽音频时从 ffmpeg codecData 记录，供分段/元信息展示。 */
  duration?: number;
}

export type TaskProjectType =
  | 'generateAndTranslate'
  | 'generateOnly'
  | 'translateOnly';

/** 一次任务工程：任务维度记录，下挂文件列表 */
export interface TaskProject {
  id: string;
  /** 默认「时间 + 第一个文件名」，用户可改 */
  name: string;
  taskType: TaskProjectType;
  files: IFiles[];
  createdAt: number;
  updatedAt: number;
}

export interface IFormData {
  /** 任务类型（运行时由任务携带）：用于区分源字幕是 ASR 生成还是用户导入。 */
  taskType?: TaskProjectType;
  /** 转写引擎（逐任务选择，缺省 builtin）。 */
  transcriptionEngine?: TranscriptionEngine;
  /** 转写模型名（引擎相关；云引擎为服务商实例内的模型 id）。 */
  model?: string;
  /** 云端听写：选中的云 ASR 服务商实例 id（transcriptionEngine==='cloud' 时必填）。 */
  asrProviderId?: string;
  translateContent:
    | 'onlyTranslate'
    | 'sourceAndTranslate'
    | 'translateAndSource';
  targetSrtSaveOption: string;
  customTargetSrtFileName: string;
  sourceLanguage: string;
  targetLanguage: string;
  translateRetryTimes: string;
  subtitleOutputFormat?: 'srt' | 'vtt' | 'ass' | 'lrc' | 'txt';
  /** 中文标点去除（任务级开关）：开启后把中文标点替换为空格。作用于源字幕(中文源)与译文(中文目标)。缺省关闭。 */
  removeChinesePunctuation?: boolean;
  /**
   * 混合语言标注（任务级专用开关）：开启后按每条字幕的主要脚本路由，统一输出繁体中文，
   * 并对由英文/泰文转译而来的句子在译文下方另起一行标注原始语言（泰文强制两段式 th→en→zh-Hant）。
   * 开启时目标语言固定为繁体中文（zh-Hant），建议搭配 LLM 供应商。缺省关闭。
   */
  annotateMixedSourceLanguage?: boolean;
  /**
   * 多语言转录模式（任务级专用开关）：开启后把音频切成短段、逐段以 auto 偵測语言各自转录，
   * 救回单次转录会漏掉的语言（如泰文），并把每段真实语言旁路带给「混合语言标注」。
   * 建议与 annotateMixedSourceLanguage 搭配使用。缺省关闭。
   */
  multiLanguageTranscription?: boolean;
}
