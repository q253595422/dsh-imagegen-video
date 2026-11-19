/**
 * Wire contract shared by the host and client halves of dsh-imagegen: the
 * settings namespace, the route paths, and the generate payload/result shapes.
 * Pure types + constants — safe for the client bundle to inline.
 */

/** Settings namespace this plugin owns (host settings seam + bridge). */
export const IMAGEGEN_SETTINGS_NAMESPACE = 'dsh-imagegen'

/** Published package version shared by the host updater and the client UI. */
export const PLUGIN_VERSION = '1.34.0'

/** Same-origin route family (loopback-only, mirroring the dsh-ssh fence). */
export const SETTINGS_API = {
  describe: '/api/dsh-imagegen/settings/describe',
  mutate: '/api/dsh-imagegen/settings/mutate',
} as const

/** Subscription account login and status routes. */
export const SUBSCRIPTION_API = {
  status: '/api/dsh-imagegen/subscription/status',
  login: '/api/dsh-imagegen/subscription/login',
} as const

/** Official/subscription-backed image providers. */
export const SUBSCRIPTION_PROVIDERS = ['chatgpt-sub', 'grok-sub', 'google-sub', 'openrouter-sub'] as const
export type SubscriptionProvider = typeof SUBSCRIPTION_PROVIDERS[number]

/** Transport protocol a channel uses to reach its gateway.
 *  google-native talks to Google Generative Language :generateContent with
 *  an x-goog-api-key, instead of an OpenAI-compatible gateway.
 *  qwen-draw is the self-hosted 千问生图 API (a ComfyUI HTTP wrapper): a
 *  custom POST /api/draw + GET /api/jobs/{id} submit/poll protocol. */
export type ChannelProtocol = 'images' | 'chat-completions' | 'google-native' | 'qwen-draw'

/** Stored preference: auto keeps old channels on images unless the URL is explicit. */
export type ChannelProtocolPreference = 'auto' | ChannelProtocol

/** Whether an endpoint URL explicitly names an OpenAI-compatible chat route. */
export function isChatCompletionsUrl(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return false
  try {
    return /\/chat\/completions\/?$/.test(new URL(trimmed).pathname)
  } catch {
    return /\/chat\/completions\/?$/.test(trimmed.split(/[?#]/, 1)[0] ?? '')
  }
}

/** Whether a stored value is one of the accepted protocol preferences. */
export function isChannelProtocolPreference(value: unknown): value is ChannelProtocolPreference {
  return value === 'auto' || value === 'images' || value === 'chat-completions' || value === 'google-native' || value === 'qwen-draw'
}

/** Resolve a channel preference without changing legacy behavior by default. */
export function resolveChannelProtocol(apiUrl: string, preference: ChannelProtocolPreference | undefined = 'auto'): ChannelProtocol {
  if (preference === 'images' || preference === 'chat-completions' || preference === 'google-native' || preference === 'qwen-draw') return preference
  return isChatCompletionsUrl(apiUrl) ? 'chat-completions' : 'images'
}

/**
 * Normalize the 千问生图 API service root. A user may paste the exact
 * generation URL (`/api/draw` or `/api/draw/sync`) or the model list URL
 * (`/api/models`); model discovery and job polling both need the bare root.
 */
export function qwenDrawBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  try {
    const url = new URL(trimmed)
    url.pathname = url.pathname.replace(/\/api\/(?:draw(?:\/sync)?|models)\/?$/i, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return trimmed
  }
}

/** Subscription channels with a fixed image model. */
export const DEFAULT_SUBSCRIPTION_MODELS: Record<SubscriptionProvider, string> = {
  'chatgpt-sub': 'gpt-image-2.5-flare',
  'grok-sub': 'grok-imagine-image-2.0',
  'google-sub': 'gemini-3-pro-image',
  'openrouter-sub': 'google/gemini-3-pro-image',
}

/** Human-facing provider names used in status and errors. */
export const SUBSCRIPTION_PROVIDER_DISPLAY_NAMES: Record<SubscriptionProvider, string> = {
  'chatgpt-sub': 'ChatGPT 订阅',
  'grok-sub': 'Grok 订阅',
  'google-sub': 'Google 订阅',
  'openrouter-sub': 'OpenRouter 账号',
}

/** Interfaces that are supported experimentally and should be labelled in the UI. */
export const EXPERIMENTAL_SUBSCRIPTION_PROVIDERS: ReadonlySet<SubscriptionProvider> = new Set(['chatgpt-sub', 'google-sub'])

/** Whether a raw string names one of the subscription providers. */
export function isSubscriptionProvider(value: unknown): value is SubscriptionProvider {
  return typeof value === 'string' && (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(value)
}

/** The image-generation proxy route. */
export const GENERATE_API = '/api/dsh-imagegen/generate'

/** Host-mediated OpenAI-compatible prompt enhancement endpoints. */
export const PROMPT_ENHANCE_API = {
  models: '/api/dsh-imagegen/prompt-enhance/models',
  enhance: '/api/dsh-imagegen/prompt-enhance',
} as const

/** Host-mediated candidate discovery for the configured image API. */
export const IMAGE_MODEL_API = {
  models: '/api/dsh-imagegen/image-models',
} as const

/** Host-served built-in provider catalog (channels the user can instantiate). */
export const PRESETS_API = '/api/dsh-imagegen/presets' as const

/** Host-served static GLBs for the director's standard body. */
export const STAGE_ASSETS_API = '/api/dsh-imagegen/stage-assets' as const

/** Loopback-only image reader for Agent tool-result previews. */
export const AGENT_IMAGE_API = '/api/dsh-imagegen/agent-image' as const

/** Store the current composer image for the direct edit_image command. */
export const CONVERSATION_IMAGE_API = '/api/dsh-imagegen/conversation-image' as const

/**
 * Host-computed per-channel usage counters (generation-count badges in the
 * settings card): entries are tallied from the persisted history and gallery
 * by channel + model alias.
 */
export const USAGE_API = '/api/dsh-imagegen/usage' as const

/** Host-resident generation queue endpoints. */
export const TASK_API = {
  submit: '/api/dsh-imagegen/tasks/submit',
  list: '/api/dsh-imagegen/tasks/list',
  get: '/api/dsh-imagegen/tasks/get',
  cancel: '/api/dsh-imagegen/tasks/cancel',
  retry: '/api/dsh-imagegen/tasks/retry',
} as const

/** Reveal the host data directory (saved images) in the OS file manager. */
export const DATA_FOLDER_API = '/api/dsh-imagegen/data-folder/open' as const

/**
 * Generation diagnostics (#38): the retained record of upstream attempts, so a
 * failure can be explained after the fact instead of only being toasted once.
 */
export const DIAGNOSTICS_API = {
  list: '/api/dsh-imagegen/diagnostics/list',
  clear: '/api/dsh-imagegen/diagnostics/clear',
} as const

/**
 * Behaviour signals (self-evolution L0).
 *
 * Diagnostics explain ONE failed request. They cannot answer "is this model
 * getting worse", because they are in-memory, capped at 200, and lost on
 * restart — and because the most informative moments (the user hit retry, the
 * user deleted the result) never reached the host at all.
 *
 * This store is the missing memory: an append-only, on-disk record of what the
 * user did AFTER seeing a result. Deliberately narrow — see signal-store.ts for
 * what is and is not written.
 */
export const SIGNALS_API = {
  list: '/api/dsh-imagegen/signals/list',
  record: '/api/dsh-imagegen/signals/record',
  report: '/api/dsh-imagegen/signals/report',
  export: '/api/dsh-imagegen/signals/export',
  clear: '/api/dsh-imagegen/signals/clear',
} as const

/**
 * One behaviour signal. Every field is metadata: a model id, a mode, an error
 * code, a coarse reason. Never a prompt, an image, or a credential.
 *
 * `kind` names what happened:
 *  - `retry`     the user asked for the same thing again (result unsatisfying)
 *  - `delete`    the user threw the result away (wasted spend)
 *  - `failure`   the pipeline failed on its own (upstream or local)
 *  - `rating`    the user answered the explicit "not good" prompt
 */
export type SignalKind = 'retry' | 'delete' | 'failure' | 'rating'

/** Why the user said a result was not good. Coarse on purpose: a taxonomy
 *  that needs explaining collects no answers. */
export type SignalReason = 'unlike' | 'text' | 'slow' | 'misread'

/** Which pipeline produced the result the signal is about. */
export type SignalPipeline = 'image' | 'video' | 'canvas' | 'skill'

/** Where the signal originated, so a report can separate automatic from asked. */
export type SignalSource = 'auto' | 'user'

/** Prompt-length buckets. Coarse by design: the report needs "long vs short",
 *  not a histogram, and a bucket cannot be inverted back into a prompt. */
export type PromptBucket = 'none' | 'short' | 'medium' | 'long' | 'huge'

export interface SignalEntry {
  /** Monotonic per host; stable enough to dedupe a double-clicked rating. */
  id: string
  at: number
  kind: SignalKind
  pipeline: SignalPipeline
  /** Model id that produced the result ('' when the signal predates a model). */
  model: string
  /** Channel display name snapshot (survives channel deletion). */
  channel: string
  /** Mode string as the pipeline uses it (t2i / i2i / t2v / ...). */
  mode: string
  /** Coarse bucket for the prompt length, never the prompt itself. */
  promptBucket?: PromptBucket
  /** Whether a reference image was involved. */
  hasReference?: boolean
  /** Failure code the pipeline reported (e.g. timeout, http-500). */
  failureCode?: string
  /** Only on `rating`. */
  reason?: SignalReason
  /** Automatic or explicit. */
  source: SignalSource
  /** Plugin version at record time, so a report can credit a fix. */
  version: string
}

/**
 * Wire shapes for the report surface.
 *
 * These mirror `signal-report.ts`, which owns the computation. They live in
 * protocol.ts because the browser renders them directly, and a hand-written
 * client interface would drift from the host's shape silently.
 */
export type SignalVerdict = 'unknown' | 'ok' | 'watch' | 'warn'

export interface SignalBucketSummary {
  pipeline: SignalPipeline
  model: string
  mode: string
  promptBucket: PromptBucket | ''
  hasReference?: boolean
  total: number
  retry: number
  delete: number
  failure: number
  rating: number
  reasons: Record<SignalReason, number>
  retryRate: number
  deleteRate: number
  failureRate: number
  ratingRate: number
  verdict: SignalVerdict
  verdictMetric: 'retry' | 'delete' | 'failure' | 'rating' | ''
}

export interface SignalFindingSummary {
  id: string
  severity: 'info' | 'watch' | 'warn'
  metric: 'retry' | 'delete' | 'failure' | 'rating'
  scope: string
  value: number
  sample: number
  zh: string
  en: string
}

/** Where the reading came from, and what it could not see. */
export interface SignalReportGaps {
  monthsRead: number
  truncated: string[]
  oldestAt?: number
  newestAt?: number
}

export interface SignalReportSummary {
  generatedAt: number
  windowDays: number
  total: number
  byKind: Record<SignalKind, number>
  byPipeline: Record<SignalPipeline, number>
  buckets: SignalBucketSummary[]
  findings: SignalFindingSummary[]
  gaps: SignalReportGaps
  issue: { title: string; body: string; url: string }
}

/** One month as the list route reports it (counts only, not the entries). */
export interface SignalMonthSummary {
  month: string
  count: number
  truncated?: 'size' | 'unreadable'
}

/** Probe the configured S3-compatible object storage. */
export const STORAGE_API = {
  test: '/api/dsh-imagegen/storage/test',
} as const

/** Host-mediated GitHub Release update routes. */
export const UPDATE_API = {
  check: '/api/dsh-imagegen/update/check',
  apply: '/api/dsh-imagegen/update/apply',
} as const

/**
 * Video generation route family. Video is asynchronous upstream (submit →
 * poll → download), so it keeps its own endpoints rather than reusing the
 * synchronous image generate route. Finished clips are persisted as files
 * under ~/.dsh/dsh-imagegen/videos/ and served through the `file` prefix
 * route, so neither list nor submit responses ever carry video bytes.
 */
export const VIDEO_API = {
  /** Submit one video generation and wait for the finished file. */
  generate: '/api/dsh-imagegen/video/generate',
  /** Host-resident video task queue (submit / list / get / cancel / retry). */
  submit: '/api/dsh-imagegen/video/tasks/submit',
  list: '/api/dsh-imagegen/video/tasks/list',
  get: '/api/dsh-imagegen/video/tasks/get',
  cancel: '/api/dsh-imagegen/video/tasks/cancel',
  retry: '/api/dsh-imagegen/video/tasks/retry',
  /**
   * Persisted video history. There is deliberately no `append` endpoint: the
   * host owns the clip bytes, so the runtime persists a finished video itself.
   * A client can never submit video content, which keeps the store free of
   * client-supplied binaries.
   */
  historyList: '/api/dsh-imagegen/video/history/list',
  historyRemove: '/api/dsh-imagegen/video/history/remove',
  historyClear: '/api/dsh-imagegen/video/history/clear',
  /** Prefix route serving one stored clip: `${file}/<file>`. */
  file: '/api/dsh-imagegen/video/file',
  /**
   * Preview the director plan without rendering anything.
   *
   * The submit path plans internally and the finished task carries its plan,
   * so this exists for the one thing a submit cannot do: show the user what
   * the planner decided BEFORE minutes of render time are spent.
   */
  plan: '/api/dsh-imagegen/video/plan',
} as const

/**
 * Code-render route family: the second production path, beside the model APIs.
 *
 * A request here names a chat model, not an image/video model: the chat model
 * writes drawing code and this host renders it locally. Nothing in this family
 * touches an image or video provider.
 */
export const CODE_RENDER_API = {
  /**
   * Resolve what a render WOULD do (dimensions, frames, dependency status)
   * without calling a model or rendering a frame.
   *
   * There is deliberately no `render` route here. A code render is submitted
   * through the ordinary generate / video-submit endpoints with
   * `renderer: 'code'`, so it inherits the same queue, cancellation, retry,
   * placeholder and history behaviour as a model render instead of growing a
   * second pipeline that would drift from the first.
   */
  probe: '/api/dsh-imagegen/code/probe',
} as const

/**
 * Same-origin route family for the host-persisted generation history. Images
 * live as files under ~/.dsh/dsh-imagegen/images/ and are served back through
 * the `image` prefix route, so list responses carry metadata only (never
 * base64) and the browser loads thumbnails/previews lazily.
 */
export const HISTORY_API = {
  list: '/api/dsh-imagegen/history/list',
  append: '/api/dsh-imagegen/history/append',
  remove: '/api/dsh-imagegen/history/remove',
  clear: '/api/dsh-imagegen/history/clear',
  image: '/api/dsh-imagegen/history/image',
} as const

/**
 * Same-origin route family for the user-curated gallery (favorites). Entries
 * reuse the history wire shape and persist under ~/.dsh/dsh-imagegen/gallery/;
 * unlike history there is no size cap — the user adds images on purpose.
 *
 * Every response that can change the trash carries it as a second field next
 * to `entries`: the same two lists are always what the client renders.
 */
export const MODEL_API = { list: '/api/dsh-imagegen/models/list', save: '/api/dsh-imagegen/models/save', image: '/api/dsh-imagegen/models/image' } as const

export const GALLERY_API = {
  list: '/api/dsh-imagegen/gallery/list',
  append: '/api/dsh-imagegen/gallery/append',
  remove: '/api/dsh-imagegen/gallery/remove',
  /** Bring one soft-deleted entry back out of the trash. */
  restore: '/api/dsh-imagegen/gallery/restore',
  /** Permanently delete every trashed entry and its files. */
  purge: '/api/dsh-imagegen/gallery/purge',
  clear: '/api/dsh-imagegen/gallery/clear',
  tags: '/api/dsh-imagegen/gallery/tags',
  image: '/api/dsh-imagegen/gallery/image',
  /** Favorite a finished clip (the host copies it out of the video store). */
  video: '/api/dsh-imagegen/gallery/video',
  /** Prefix route serving one favorited clip: `${videoFile}/<file>`. */
  videoFile: '/api/dsh-imagegen/gallery/video-file',
} as const

/** Host-persisted infinite canvas projects and their content-addressed assets. */
/**
 * 一条待确认的 Agent 画布改动。
 *
 * 定义在协议层而不是存储层：客户端要拿它渲染提案条，而存储层 import 了
 * node:fs，客户端不能碰。
 */
export interface CanvasProposalChange {
  /** 新建的节点（整份，接受时直接并入）。 */
  addedNodes?: CanvasNode[]
  /**
   * 被改的节点，**只带 Agent 真正改过的字段**。
   *
   * WHY 不是整份节点：提案是起草时算出来的，用户可能在这之后自己拖过这个
   * 节点。整份替换会把用户的坐标一并回退——这是上线前探针实测到的真实缺陷
   * （节点被拖到 1234,567，接受一条「改标题」的提案后回到 100,100），而且
   * 静默发生：界面说「接受之前画布不会变化」，用户没法预料一次改标题会把
   * 刚摆好的位置也改回去。字段补丁只碰提案点名的那些键。
   */
  updatedNodes?: CanvasProposalNodeUpdate[]
  /** 被删的节点 id。 */
  removedNodeIds?: string[]
  /** 新建的连线。 */
  addedConnections?: CanvasConnection[]
  /**
   * 被改的连线，只带真正变过的键。
   *
   * 今天只有 `role` 会变（首帧/尾帧/素材），但按「只带变过的键」写，将来加
   * 别的连线字段不用再动协议形状。与 {@link CanvasProposalNodeUpdate} 同一
   * 理由：整份替换会把用户在提案之后做的改动一并回退。
   */
  updatedConnections?: CanvasProposalConnectionUpdate[]
  /** 被删的连线 id。 */
  removedConnectionIds?: string[]
  /** 画布标题改成什么。 */
  title?: string
}

/**
 * 提案里对某个节点的字段补丁。
 *
 * WHY 不叫 `CanvasNodePatch`：客户端 `canvas-flow-context.tsx` 已经有一个同名
 * 类型，但它把 metadata 键平铺在顶层（`patchNode` 的入参形状）。这里是明确的
 * 两层：顶层几何/标题、metadata 逐键。两者形状不同，同名会让人读错。
 */
export interface CanvasProposalNodeUpdate {
  /** 要改的节点 id。 */
  id: string
  /** 顶层字段的补丁：只有出现过的键会被覆盖，其余保持文档当前值。 */
  fields?: Partial<Pick<CanvasNode, 'title' | 'x' | 'y' | 'width' | 'height'>>
  /** metadata 的逐键补丁。未出现的键保持文档当前值。 */
  metadata?: CanvasNodeMetadata
  /** metadata 里要删掉的键（今天的工具都不删键，但补丁语义得自己站得住）。 */
  removedMetadataKeys?: string[]
}

/**
 * 提案里对某条连线的字段补丁。
 *
 * 形状与 {@link CanvasProposalNodeUpdate} 同源：只带真正变过的键，未出现的
 * 键保持文档当前值。今天只有 `role` 会变。
 */
export interface CanvasProposalConnectionUpdate {
  /** 要改的连线 id。 */
  id: string
  /**
   * 改成什么角色。`'input'` 表示「把角色删掉」——见 `connection-role.ts` 的
   * 硬约束：默认值不落盘，所以这里不能是「写成 'input'」。
   */
  role?: CanvasConnectionRole
}

export interface CanvasProposal {
  id: string
  canvasId: string
  /** 产出这条提案的工具名，界面按它说明来源。 */
  tool: string
  /**
   * 一句话说明，直接给用户看。
   *
   * @deprecated 界面改为从 {@link counts} + 语言表渲染。这个字段是服务端
   * 用中文拼好的，英文/俄文用户会看到中文——一条提案的文案却不受语言表
   * 管辖，是这套机制里唯一漏掉的一处。保留它只有一个用途：**旧提案**已经
   * 写进磁盘（`proposals/` 是旁路目录，没人清理过），它们没有 `counts`，
   * 界面用这个字段兜底。新提案同时写两者。
   */
  summary: string
  /**
   * 提案要改动的数量，界面按当前语言渲染成句子。
   *
   * 只放数字与「改成了什么名字」，不放任何一句话：文案在
   * `src/client/locales.ts` 的 `canvas.proposal.summary.*` 里。旧提案没有
   * 这个字段，界面退回 `summary`。
   */
  counts?: CanvasProposalCounts
  /** 起草时的文档 revision。仅供参考：接受时不拿它当门槛（多条提案共享它）。 */
  baseRevision: number
  createdAt: number
  change: CanvasProposalChange
}

/**
 * 一条提案的改动规模。键都只有出现了才算数——没出现表示「这类改动为 0」，
 * 而不是「未知」。
 */
export interface CanvasProposalCounts {
  addedNodes?: number
  updatedNodes?: number
  removedNodes?: number
  addedConnections?: number
  /** 改了角色的连线数。 */
  updatedConnections?: number
  removedConnections?: number
  /** 被改成的标题（只在提案确实改名时出现）。 */
  title?: string
}

export const CANVAS_API = {
  list: '/api/dsh-imagegen/canvas/list',
  create: '/api/dsh-imagegen/canvas/create',
  read: '/api/dsh-imagegen/canvas/read',
  save: '/api/dsh-imagegen/canvas/save',
  remove: '/api/dsh-imagegen/canvas/remove',
  favorite: '/api/dsh-imagegen/canvas/favorite',
  assetUpload: '/api/dsh-imagegen/canvas/asset/upload',
  assetImport: '/api/dsh-imagegen/canvas/asset/import',
  asset: '/api/dsh-imagegen/canvas/asset',
  /** Vision-model layer decomposition for the canvas layer-split tool. */
  layers: '/api/dsh-imagegen/canvas/layers',
  /** Raw-binary upload for arbitrary canvas file nodes (no base64 inflation). */
  fileUpload: '/api/dsh-imagegen/canvas/file/upload',
  /** Structured content preview (text / table / office / archive) of one asset. */
  filePreview: '/api/dsh-imagegen/canvas/file/preview',
  /**
   * 待确认的 Agent 改动。Agent 的写工具只产出提案，用户在这里看到并接受或
   * 丢弃；三者都不碰画布本身，只有 accept 会经由 canvas/save 的乐观锁写入。
   */
  proposals: '/api/dsh-imagegen/canvas/proposals',
  proposalAccept: '/api/dsh-imagegen/canvas/proposal/accept',
  proposalDiscard: '/api/dsh-imagegen/canvas/proposal/discard',
  /**
   * 导演台导出视频：客户端把逐帧 PNG 逐块 POST 到这里，宿主拼成 mp4 并返回
   * 一条可落成视频节点的引用。
   *
   * 为什么不在浏览器里编：WebCodecs 的 H.264 只在部分浏览器/画幅下可用
   * （牧野自己就带了一句「当前浏览器不支持此画幅的 H.264 编码」），而宿主
   * 本来就有 ffmpeg（见 `src/clip-compose.ts`）。逐帧交给宿主，画幅和时长
   * 都不受编码器能力表约束。
   */
  stageFrame: '/api/dsh-imagegen/canvas/stage/frame',
  stageEncode: '/api/dsh-imagegen/canvas/stage/encode',
  /**
   * 读用户工作区里的一集 oh-story 短剧：三份 Markdown 与它们引用到的图片。
   *
   * 只读、只读固定文件名、只在调用方声明的工作区根目录之内。解析不在这里
   * 做——宿主只交字节，格式归浏览器侧（`client/storyboard-markdown.ts`）。
   */
  dramaProject: '/api/dsh-imagegen/canvas/drama/project',
  /**
   * 把项目里的一张参考图读成 data URL 交给浏览器。
   *
   * 只交字节、不入库：宽高要把图解码之后才知道，而那一步在浏览器里（它本来
   * 就要把这张图显示在节点上）。量完尺寸后走已有的 `canvasUpload` 入库——
   * 一条上传通道，不是两条。
   */
  dramaImage: '/api/dsh-imagegen/canvas/drama/image',
  /**
   * 把画布做出来的一个产出文件写回 `剧集/<EP>/制作成果/`。
   *
   * 与 `dramaProject` / `dramaImage` 对称——那两条只读，这一条只写，分工
   * 与读侧一致：浏览器算「要写什么」，宿主只管落盘与安全边界。
   *
   * 一次一个文件：单条视频上限 50MB，base64 之后约 67MB，与文档回写那条
   * 共用路由会把文本请求也放开到同一个内存上限。
   */
  dramaWriteFile: '/api/dsh-imagegen/canvas/drama/write-file',
  /** 把改好的《分镜.md》写回去（先备份，内容没变就不写）。 */
  dramaWriteDocument: '/api/dsh-imagegen/canvas/drama/write-document',
} as const

/** 导演台逐帧导出的线上形状。 */
export interface StageFrameUpload {
  /** 一次导出会话的 id，客户端生成；同一个会话的帧按 `index` 排序。 */
  sessionId: string
  /**
   * 这次导出属于哪张画布。
   *
   * WHY 单独一个字段而不是复用 `sessionId`：导演台导出的成片会写进视频历史，
   * 而历史列表要把「画布产物」与用户自己生成的作品分开——没有这个 id，
   * 重启之后那条成片就分不清是谁的，只能留在列表里冒充一次独立生成。
   */
  canvasId?: string
  /** 帧序号，0 起始。 */
  index: number
  /** 总帧数；最后一帧到达即触发编码。 */
  total: number
  /** 帧宽度与高度（像素），所有帧必须一致。 */
  width: number
  height: number
  /** 帧率；固定 30，写进来是为了让宿主不必猜。 */
  fps: number
  /** 单帧 PNG，data URL。 */
  dataUrl: string
}

export interface StageEncodeResult {
  /** 编好的 mp4，走视频存储的读取路由。 */
  url: string
  mime: string
  /** 实际时长（秒）。 */
  duration: number
  bytes: number
}

/**
 * 宿主读回来的一集短剧。
 *
 * 文档以**原文**交给浏览器：格式解析（条目头、全角冒号、中点、中文分号）
 * 全在 `client/storyboard-markdown.ts` 里，宿主不解释任何一行内容。这个分工
 * 让以后格式再变时只需改一处，而且宿主不必跟着 oh-story 的 SKILL 演进。
 */
export interface DramaProjectDocument {
  /** `storyboard` / `imagePrompts` / `motionPrompts`，固定三个。 */
  key: 'storyboard' | 'imagePrompts' | 'motionPrompts'
  /** 文件名原文，如 `分镜.md`。 */
  fileName: string
  /** 项目相对路径，给界面显示。 */
  relativePath: string
  /** 文件内容；不存在时为 undefined。 */
  text?: string
  bytes: number
}

/** 一次读取的完整结果。 */
export interface DramaProjectRead {
  /** 实际使用的剧集目录（相对工作区），如 `剧集/EP001`。 */
  projectPath: string
  /** 剧集名，如 `EP001`。 */
  episode: string
  documents: DramaProjectDocument[]
  /** 这一集里找到的图片（项目相对路径）；文档里的 `REF-…` 靠它判定有图没图。 */
  images: Array<{ relativePath: string, bytes: number }>
  /** 值得说的事：缺文件、超上限、跳过的链接。 */
  notes: string[]
}

/** Same-origin route family for canvas skills (catalog + run control). */
export const CANVAS_SKILL_API = {
  pptRun: '/api/dsh-imagegen/ppt/run',
  pptTasks: '/api/dsh-imagegen/ppt/tasks',
  pptRuntime: '/api/dsh-imagegen/ppt/runtime',
  list: '/api/dsh-imagegen/canvas/skills/list',
  run: '/api/dsh-imagegen/canvas/skills/run',
  task: '/api/dsh-imagegen/canvas/skills/task',
  cancel: '/api/dsh-imagegen/canvas/skills/cancel',
  /** Local skill library (`~/.dsh/skills`): inspect, install, remove. */
  library: '/api/dsh-imagegen/canvas/skills/library',
  install: '/api/dsh-imagegen/canvas/skills/install',
  remove: '/api/dsh-imagegen/canvas/skills/remove',
  /** Per-skill configuration values declared by `skill.config.json` (or a recipe). */
  configSave: '/api/dsh-imagegen/canvas/skills/config/save',
  /** Run a declaration's `apply` steps (commands / files) with the saved values. */
  configApply: '/api/dsh-imagegen/canvas/skills/config/apply',
} as const

/** Maximum number of history entries retained host-side (oldest evicted). */
export const HISTORY_MAX = 50

/**
 * Same-origin route family for the prompt-template libraries. The library is
 * multi-source: every request names a source id from {@link TEMPLATE_SOURCES},
 * each source keeps an independent snapshot/image cache host-side, and
 * reference images are proxied through the source-scoped `image` prefix route
 * (`…/image/<sourceId>/<file>`) and cached on disk so repeated views never hit
 * the network again.
 */
export const TEMPLATES_API = {
  list: '/api/dsh-imagegen/templates/list',
  refresh: '/api/dsh-imagegen/templates/refresh',
  sample: '/api/dsh-imagegen/templates/sample',
  image: '/api/dsh-imagegen/templates/image',
} as const

/** Same-origin route family for the user's saved (favorited) templates. */
export const TEMPLATE_FAVORITES_API = {
  list: '/api/dsh-imagegen/templates/favorites/list',
  add: '/api/dsh-imagegen/templates/favorites/add',
  remove: '/api/dsh-imagegen/templates/favorites/remove',
} as const

/** One prompt-template library source (a tab in the library overlay). */
export interface TemplateSourceMeta {
  /** Stable source id: snapshot dir name, image-cache dir, and request key. */
  id: string
  /** Tab label shown in the library overlay. */
  label: string
  /** Source homepage linked in the overlay footer. */
  homepage: string
  /** One-line description of the source (tab tooltip). */
  description: string
  /** False for bundled snapshots that are refreshed with plugin releases. */
  refreshable?: boolean
}

/**
 * The template-library source registry. Each entry is fully independent (own
 * upstream JSON, own image pool, own refresh state) and renders as its own
 * tab; adding a source later means appending an entry here plus a host-side
 * fetch definition in templates-store.ts and an optional bundled snapshot.
 */
export const TEMPLATE_SOURCES: TemplateSourceMeta[] = [
  {
    id: 'vibeui',
    label: '精选案例库',
    homepage: 'https://vibeui.top/',
    description: 'awesome-gpt-image-2 精选提示词案例（vibeui.top 镜像）',
  },
  {
    id: 'canghe',
    label: '沧河案例库',
    homepage: 'https://gpt-image2.canghe.ai/',
    description: 'GPT-Image2 Prompt Gallery（gpt-image2.canghe.ai，定期更新）',
  },
  {
    id: 'handraw',
    label: '手绘模板库',
    homepage: 'https://github.com/yang0/handraw-style',
    description: '手绘风格、排版图型与主题色图鉴（yang0/handraw-style）',
    refreshable: false,
  },
  {
    id: 'prompt-signal',
    label: 'Prompt/Signal',
    homepage: 'https://github.com/andy7076/image_prompt',
    description: 'andy7076/image_prompt 的 570+ 精选生图提示词',
    refreshable: false,
  },
  {
    id: 'evolink',
    label: 'GPT Image 2 案例库',
    homepage: 'https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts',
    description: 'EvoLink 整理的 GPT Image 2 电商、广告、人像、海报、角色与 UI 案例',
    refreshable: false,
  },
  {
    id: 'itgoyo',
    label: 'Prompt 图集',
    homepage: 'https://github.com/itgoyo/awesome-gpt-image2-prompt',
    description: '612 组带示例图的 GPT-Image-2 提示词（itgoyo/awesome-gpt-image2-prompt，CC BY 4.0）',
    refreshable: false,
  },
  {
    id: 'songtianlun',
    label: '多模态提示词',
    homepage: 'https://github.com/songtianlun/awesome-prompts',
    description: '按模态收录的生图 / 改图 / 生视频提示词（songtianlun/awesome-prompts，MIT）',
    refreshable: false,
  },
  {
    id: 'youart',
    label: 'YouArt 2.5',
    homepage: 'https://github.com/youart-open-source/awesome-gpt-image-2-5-prompts',
    description: '逐条署名到原作者与原始帖子的 GPT Image 2.5 提示词（CC BY 4.0，无示例图）',
    refreshable: false,
  },
]

/** Default source id when a request does not name one (legacy clients). */
export const DEFAULT_TEMPLATE_SOURCE_ID = TEMPLATE_SOURCES[0]!.id

/** True when the id names a registered template source. */
export function isTemplateSourceId(id: string): boolean {
  return TEMPLATE_SOURCES.some(source => source.id === id)
}

/** One prompt-library case as the browser consumes it. */
export interface TemplateCase {
  /** Upstream case id (stable across refreshes; numeric legacy ids are accepted). */
  id: string
  /** Short case title. */
  title: string
  /** Full reusable prompt text. */
  prompt: string
  /** English category name (grouping key). */
  category: string
  /** Chinese category display name. */
  categoryZh: string
  /** Style tags. */
  styles: string[]
  /** Scene tags. */
  scenes: string[]
  /** Original author handle, e.g. @vista8. */
  sourceLabel: string
  /** Original author link. */
  sourceUrl: string
  /** awesome-gpt-image-2 repo anchor link. */
  githubUrl: string
  /** Reference-image key or absolute URL served through the image route ('' when none). */
  image: string
  /** Whether the source gallery featured the case. */
  featured: boolean
}

/** Template-library list payload (one source). */
export interface TemplateListResult {
  /** The source this list belongs to. */
  sourceId: string
  cases: TemplateCase[]
  total: number
  /** Where the served list came from. */
  origin: 'bundled' | 'refreshed'
  /** Upstream repository the library mirrors. */
  repository: string
  /** ISO time of the last successful refresh / bundle snapshot. */
  fetchedAt: string
}

/** Template-library refresh outcome (one source). */
export interface TemplateRefreshResult {
  sourceId: string
  total: number
  fetchedAt: string
}

/** One random inspiration pick served to the studio's empty state. */
export interface TemplateSample {
  /** Source the case came from (drives the image proxy URL). */
  sourceId: string
  /** The sampled case (full prompt is handed to the form on use). */
  case: TemplateCase
}

/** One favorited template as persisted host-side and served to the browser. */
export interface TemplateFavorite {
  /** Stable key: `${sourceId}:${caseId}`. */
  key: string
  /** Source the case came from. */
  sourceId: string
  /** ISO time the favorite was saved. */
  savedAt: string
  /** Full case snapshot, so favorites survive upstream list churn. */
  case: TemplateCase
}

/** Generation modes for image requests. */
export type GenerateMode = 'text' | 'edit'

/**
 * How one stored history/gallery entry was produced.
 *
 * A superset of {@link GenerateMode}: history and the gallery may also hold a
 * clip. Kept separate so an image request can never claim `mode: 'video'` —
 * the image engine has no such branch and would mis-shape the request.
 */
export type StoredEntryMode = GenerateMode | 'video'

/**
 * Video generation modes. Mirrors the async submit/poll video contract
 * instead of the synchronous image one:
 *  - text      → text-to-video
 *  - image     → image-to-video (one reference frame)
 *  - keyframe  → first/last frame interpolation (providers accepting both)
 *  - reference → one or more style/subject references (providers accepting several)
 *  - compose   → NOT a provider mode: labels a clip the host stitched together
 *                from other clips with ffmpeg, so the history can record where
 *                the bytes came from. It never reaches the generate route (whose
 *                mode whitelist would silently downgrade it) and no model
 *                catalog declares it, so it never becomes a studio tab.
 */
export type VideoMode = 'text' | 'image' | 'keyframe' | 'reference' | 'compose'

/** Request-shaping family a video model id routes through. */
export type VideoModelFamily =
  | 'agnes'
  | 'comemoe'
  | 'xai'
  | 'seedance'
  | 'openai-video'
  | 'snapgen'
  | 'muse'
  // Nbility's MiniMax-H3 contract: a `content` array with per-item `role`, and
  // every reference must be uploaded to a public HTTPS URL first -- the family
  // exists because that upload leg has no analogue in the generic shape.
  | 'minimax'
  // 启航AIGC's gateway: flat video parameters under `/v1/videos/generations`,
  // then `GET /v1/tasks/{id}` with `is_final` / `output_url`.
  | 'qihang'
  | 'unknown'

/**
 * Video output resolution tier, mapped per family by the engine.
 *
 * `768P` is not a marketing tier: some providers accept exactly one number and
 * reject everything else (MiniMax-H3 answers 400 to both 720P and 1080P), so
 * the union has to be able to name what they actually take. Families that do
 * not list it never see it — `normalizeVideoResolution` degrades it away.
 */
export type VideoResolution = '480P' | '720P' | '768P' | '1080P'

/** Aspect ratios the video panel offers; families narrow this themselves. */
export const VIDEO_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const
export type VideoAspectRatio = typeof VIDEO_ASPECT_RATIOS[number]

/** Durations (seconds) the video panel offers; families narrow this themselves. */
export const VIDEO_DURATIONS = [5, 10] as const

/**
 * One generated video as the browser consumes it. Video bytes never travel
 * inline (a clip is far larger than an image): the host persists the finished
 * file and returns a servable URL instead.
 */
export interface GeneratedVideo {
  /** Same-origin URL: `${VIDEO_API.file}/<file>`. */
  url: string
  /** MIME type, e.g. video/mp4. */
  mime: string
  /** Duration in seconds, when the provider reports it. */
  duration?: number
  /** Poster/thumbnail URL, when the provider supplies one. */
  poster?: string
  /** Upstream revised prompt, when provided. */
  revisedPrompt?: string
}

/** Successful video generation outcome. */
export interface VideoGenerateResult {
  videos: GeneratedVideo[]
  /** Updated host-persisted video history, when returned by the route. */
  history?: VideoHistoryEntry[]
  /** Persistence failure after the video was successfully generated. */
  historyError?: string
  /** The director plan that produced this clip, when planning ran. */
  plan?: VideoDirectorPlan
  /** `code` when a chat model wrote the drawing code for this clip. */
  renderer?: 'model' | 'code'
  /** The drawing code that produced the clip (code path only). */
  renderSource?: string
  /** True when the model answered prose and the built-in title card drew it. */
  degraded?: boolean
  degradedReason?: string
}

/** One code-render request as the route accepts it (already shape-checked). */
export interface CodeRenderRequest {
  kind: CodeTarget
  source: string
  width: number
  height: number
  fps: number
  seconds: number
}

/** Shape of the code-render probe answer. */
export interface CodeRenderResponse {
  width: number
  height: number
  fps: number
  seconds: number
  frames: number
  /** False when no ffmpeg was found: a video render would fail, an image would not. */
  ffmpegAvailable: boolean
  ffmpegPath?: string
}

/** What `code/render` answers: the produced bytes already persisted, plus where. */
export interface CodeRenderApiResult {
  kind: CodeTarget
  width: number
  height: number
  fps?: number
  seconds?: number
  source: string
  degraded: boolean
  degradedReason?: string
  video?: { entryId: string; url: string; mime: string; duration?: number }
  image?: { entryId: string; url: string; mime: string }
  history?: VideoHistoryEntry[] | HistoryEntry[]
}

/** `video` renders an MP4 here; `image` renders a PNG here. */
export type CodeTarget = 'video' | 'image'

/** A client → host video generation request (what the panel collects). */
export interface VideoGenerateRequest {
  /** Video mode; drives which reference fields the engine reads. */
  mode: VideoMode
  /**
   * User-facing model alias from the channel's video catalog. The host maps it
   * onto the configured channel and fills `upstream` with the real id.
   */
  model: string
  /** The prompt. Upstream providers may impose their own length limits. */
  prompt: string
  /** Aspect ratio as '16:9' / '9:16' / '1:1' / '4:3' / '3:4'. */
  aspectRatio: string
  /** Output resolution tier. */
  resolution: VideoResolution
  /** Clip length in seconds. */
  seconds: number
  /** Reference image as a data URL (image / keyframe / reference modes). */
  image?: string
  /** Additional reference images as data URLs (reference mode). */
  images?: string[]
  /** First frame as a data URL (keyframe mode). */
  firstFrame?: string
  /** Last frame as a data URL (keyframe mode). */
  lastFrame?: string
  /** Original reference-image name, retained in the history entry. */
  refName?: string
  /** Channel this request targets (host falls back to the default). */
  channelId?: string
  /** Channel display name snapshot, kept on the history entry (host-filled). */
  channel?: string
  /** Upstream model id actually sent to the gateway (host-filled from alias). */
  upstream?: string
  /** Deterministic seed, when the provider accepts one. */
  seed?: number
  /** Optional canvas lineage metadata (which canvas started this video). */
  canvas?: CanvasVideoTaskMeta
  /**
   * Run the director planning step before rendering. Absent means off: the
   * prompt is sent exactly as typed, which is the historical behaviour and the
   * right default for callers that already planned (a replayed task, a test).
   */
  plan?: boolean
  /**
   * A plan the user already previewed. When present, submit adopts it instead
   * of calling the chat model again, so the render matches what was shown.
   * Re-validated host-side against `seconds` / `aspectRatio` / `resolution`.
   */
  planPreview?: VideoDirectorPlan
  /**
   * How this clip should be produced. Absent means the video model path, which
   * is the historical behaviour; `code` makes a chat model write drawing code
   * that this host renders and encodes — no video model is contacted.
   */
  renderer?: 'model' | 'code'
  /**
   * A drawing source produced by a previous code run. A retry sends it back so
   * the same clip is reproduced without another chat call.
   */
  renderSource?: string
  /**
   * Reattach an already-submitted render instead of submitting a new one (#10-1).
   *
   * Set only by the host when it restores an in-flight task after a restart. The
   * engine goes straight to polling; a request carrying this must never reach a
   * submit, or the user pays for the render twice.
   */
  resume?: {
    /** The provider's own task id. */
    taskId: string
    /** Protocol family that owns the status URL and the poll cadence. */
    family: string
    /** When the original submit succeeded: the poll budget counts from here. */
    submittedAt: number
  }
}

/**
 * Canvas lineage for one video generation.
 *
 * Mirrors {@link CanvasTaskMeta} but keys on the video-task id, because the
 * canvas looks up its video placeholder nodes by the task that will fill them.
 */
export interface CanvasVideoTaskMeta {
  canvasId: string
  /** The config node whose composer submitted this run. */
  sourceNodeId?: string
  /** The placeholder video node awaiting this result. */
  nodeId?: string
  /** Upstream image nodes that fed the run (reference / first / last frame). */
  referenceNodeIds?: string[]
}

/** One shot the director plan proposed. */
export interface VideoPlanShot {
  /** 1-based ordinal within the clip. */
  index: number
  /** What the camera sees. */
  shot: string
  /** What moves in this shot. */
  action: string
  /** Camera movement for this shot. */
  camera: string
  /** Share of the clip this shot covers, in seconds. */
  seconds: number
}

/**
 * The reasoning step's result: a request-shaped plan plus what it changed.
 *
 * Echoed back on the finished task and on the history entry so a clip can be
 * explained later ("why is this 10s and 9:16?") without re-running the model.
 */
export interface VideoDirectorPlan {
  /** Which backend produced it. */
  source: 'chat' | 'heuristic'
  style: {
    /** Shot size and lighting, e.g. 中景 + 侧光. */
    shotLanguage: string
    /** Visual style, e.g. 写实电影感. */
    look: string
    /** 0..1: how much happens per second. */
    pacing: number
  }
  shots: VideoPlanShot[]
  /** The prompt actually sent to the provider. */
  prompt: string
  /** The parameters actually used, after clamping to the family. */
  params: { seconds: number; aspectRatio: string; resolution: string }
  /** What the planner changed, in user-facing copy. */
  notes: string[]
  /** True when a chat answer had to be repaired or replaced. */
  degraded: boolean
  /** Why it degraded. */
  degradedReason?: string
}

/** One stored video reference as the browser consumes it. */
export interface VideoHistoryFile {
  /** Same-origin URL: `${VIDEO_API.file}/<file>`. */
  url: string
  mime: string
  duration?: number
  poster?: string
  revisedPrompt?: string
}

/** A saved video generation (metadata + served file). */
export interface VideoHistoryEntry {
  id: string
  createdAt: number
  mode: VideoMode
  model: string
  prompt: string
  aspectRatio: string
  resolution: string
  seconds: number
  videos: VideoHistoryFile[]
  /** Reference-image filename, kept for display only. */
  refName?: string
  /** Channel id snapshot. */
  channelId?: string
  /** Channel display name snapshot (survives channel deletion). */
  channel?: string
  /** The director plan that shaped this clip, when planning ran. */
  plan?: VideoDirectorPlan
  /**
   * How this clip was produced. Absent means the model provider rendered it;
   * `code` means a chat model wrote drawing code and this host rendered it.
   */
  renderer?: 'model' | 'code'
  /**
   * Canvas lineage, when this clip came from a canvas video node.
   *
   * WHY it is persisted: the canvas used to know a clip only through the
   * in-memory task queue, which a host restart wipes. A placeholder whose
   * render finished but whose task row was gone then had no way back to its
   * clip and was reported as lost, even though the bytes were on disk. The
   * lineage makes the history entry the durable half of that link, so a
   * reopened canvas can adopt a finished clip into the node it was made for.
   */
  canvas?: CanvasVideoTaskMeta
}
export interface VideoHistoryEntryInput {
  id: string
  createdAt: number
  mode: VideoMode
  model: string
  prompt: string
  aspectRatio: string
  resolution: string
  seconds: number
  /** Host-filled after the file lands on disk; ignored on input. */
  videos?: GeneratedVideo[]
  refName?: string
  channelId?: string
  channel?: string
  /** Host-filled: the plan that produced this clip, when planning ran. */
  plan?: VideoDirectorPlan
  /** Host-filled: `code` when a chat model wrote the drawing code. */
  renderer?: 'model' | 'code'
  /** Canvas lineage, for a clip generated from a canvas video node. */
  canvas?: CanvasVideoTaskMeta
}

/** Lifecycle of one host-resident video generation task. */
export type VideoTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * What became of the render on the PROVIDER's side when the user cancelled.
 *
 * A cancel request only ever aborts the local poll loop, so the honest answer
 * is a status rather than a boolean: this plugin has no measured cancel
 * endpoint for any family (see `REMOTE_CANCEL` in video-engine.ts), so a
 * cancelled task is normally `unsupported` — "stopped here, still running
 * there". Without this field the panel said "已取消" and the user believed the
 * billing had stopped, which is exactly the #10-2 complaint.
 */
export type VideoCancelState = 'pending' | 'stopped' | 'unconfirmed' | 'unsupported'

/**
 * One queued or finished video generation as the browser consumes it.
 *
 * Shared by the host queue and the panel, so the wire shape is declared once
 * here rather than in the host-only queue module (which the browser bundle
 * must not import).
 */
export interface VideoTask {
  id: string
  request: VideoGenerateRequest
  status: VideoTaskStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  result?: VideoGenerateResult
  error?: string
  /**
   * The provider's own task id, once the submit leg returned one (#10-1).
   *
   * Carried on the task so a restart can pick the SAME remote render back up
   * instead of paying for a second submit. Absent for tasks that never reached
   * the provider (queued behind another render, code-path renders).
   */
  remoteTaskId?: string
  /** What happened to the provider-side render on cancel (see the type). */
  remoteCancel?: VideoCancelState
  /**
   * Set when this task was re-attached after a host restart rather than
   * submitted in this process. The panel says so, because "已用时" would
   * otherwise start from zero on a render that has been running for minutes.
   */
  resumedAt?: number
}

/**
 * Poll payload: keeps the result URL but never the raw reference frames.
 *
 * `resultUrl` is the servable clip of a completed task. The full `result` is
 * omitted because it carries no more than this for the browser's purposes,
 * while the request's base64 frames are large and already held client-side.
 */
export interface VideoTaskSummary extends Omit<VideoTask, 'result'> {
  resultAvailable: boolean
  resultUrl?: string
  /**
   * The finished clip in full (url + mime + duration). The canvas needs more
   * than a bare URL to build its video node, and this avoids a second round
   * trip through the history list to learn the clip's shape.
   */
  resultVideo?: VideoHistoryFile
  /**
   * The video-history entry this task produced, when it persisted one. The
   * canvas records it on the node so "add to gallery" can name the entry
   * without searching the history list.
   */
  resultEntryId?: string
  /**
   * The director plan that shaped this run, once the render finished. Lets the
   * panel show the shot list and the parameters it chose alongside the clip.
   */
  plan?: VideoDirectorPlan
  /**
   * The drawing code that produced this clip (code path only), so the canvas
   * can retry the render without paying for another chat call.
   */
  renderSource?: string
  /** True when the model answered prose and the fallback title card drew it. */
  degraded?: boolean
  degradedReason?: string
}

/** Origin information carried by a generation started from the canvas. */
export interface CanvasTaskMeta {
  canvasId: string
  sourceNodeId?: string
  /** Legacy v1 annotation workflow; kept so old history entries still parse. */
  annotationNodeId?: string
  parentNodeId?: string
  placement?: 'right' | 'below'
}

/** One image or file asset referenced by a canvas node. Image assets always
 *  carry real dimensions; file assets may report `0` (nothing to preview). */
export interface CanvasAssetRef {
  assetId: string
  url: string
  mime: string
  bytes: number
  width: number
  height: number
  origin: 'upload' | 'history' | 'gallery' | 'generated'
  originId?: string
  entryId?: string
  imageIndex?: number
  /** Discriminator for nodes that carry arbitrary files; absent = image. */
  kind?: 'image' | 'file'
  /** Original (upload) or produced (skill run) file name, without a path. */
  name?: string
  /** Extracted text head for inline preview of text-like files. */
  textPreview?: string
}

export type CanvasNodeType = 'image' | 'text' | 'file' | 'config' | 'video' | 'storyboard'

/**
 * One shot in a storyboard node's list.
 *
 * A shot owns its own prompt and length and nothing else: the clip it produces
 * is an ORDINARY canvas video node, named by {@link nodeId}. Keeping the
 * result as a reference to that node rather than a copy of its status means
 * there is exactly one place a clip's state lives (`metadata.status` on the
 * video node), so the storyboard can never disagree with what the canvas shows,
 * and the same node is immediately previewable, favoritable and stitchable.
 */
export interface CanvasShot {
  id: string
  /** Camera direction for this shot only. */
  prompt: string
  /** Length handed to the video provider, in seconds. */
  seconds: number
  /** The video node this shot produced, once one has been created. */
  nodeId?: string
  /**
   * The clip this shot produced can no longer be trusted as input to the next
   * one.
   *
   * Set when a `carry` storyboard re-runs an earlier shot: every downstream
   * clip was rendered from the old tail frame, so its first frame no longer
   * matches. The clip file is kept (the user may still want to look at it) —
   * only its standing as "ready input" is withdrawn. `submitShot` is the one
   * place that clears it again, by re-running the shot.
   */
  stale?: boolean
}

/**
 * Where a video node came from, when a storyboard made it. Written on the
 * produced node so a later stitch or a re-run can find its shot again without
 * scanning every storyboard's list.
 */
export interface CanvasShotOrigin {
  storyboardId: string
  shotId: string
  /** 1-based position in the shot list, for provenance text. */
  index: number
}

/** Coarse bucket driving the file node's icon and preview branch. */
export type CanvasFileKind = 'text' | 'pdf' | 'image' | 'office' | 'archive' | 'audio' | 'video' | 'other'

/**
 * One structured file preview built host-side for a canvas file node. Media
 * types that the browser can already render (image / pdf / audio / video) are
 * handed back as an inline URL; everything else arrives decoded, bounded, and
 * shaped for one of the renderers below.
 */
export type CanvasFilePreview =
  /** The asset itself renders in the browser (image, pdf, audio, video). */
  | {
    kind: 'media'
    media: 'image' | 'pdf' | 'audio' | 'video'
    /** Same-origin URL that serves the asset inline. */
    url: string
    width: number
    height: number
  }
  /** Decoded plain text (text files, extracted office documents, PDF fallback). */
  | {
    kind: 'text'
    /** Format bucket used in the UI, e.g. `md` / `docx` / `pdf`. */
    format: string
    text: string
    /** True when the file is longer than the preview cap. */
    truncated: boolean
    /** Total line count of the returned text. */
    lines: number
    /** Non-fatal extraction note (heuristics, partial reads). */
    warning?: string
  }
  /** HTML document rendered in a sandboxed iframe (scripts disabled). */
  | { kind: 'html'; format: 'html'; html: string; truncated: boolean }
  /** Markdown source, rendered to rich text by the client. */
  | { kind: 'markdown'; format: 'markdown'; markdown: string; truncated: boolean }
  /** SVG source, rendered as a browser image (scripts never run in `<img>`). */
  | { kind: 'svg'; format: 'svg'; svg: string; truncated: boolean }
  /** Rectangular data (CSV / TSV / XLSX) rendered as a grid. */
  | {
    kind: 'table'
    format: string
    rows: string[][]
    /** Row count in the source file (may exceed `rows.length`). */
    totalRows: number
    truncated: boolean
  }
  /** ZIP central directory listing. */
  | {
    kind: 'archive'
    entries: Array<{ name: string; size: number; dir: boolean }>
    /** Total entries in the archive (may exceed `entries.length`). */
    totalEntries: number
    truncated: boolean
  }
  /** Structured document preview (DOCX): headings, runs, lists, tables. */
  | { kind: 'document'; format: string; blocks: CanvasDocBlock[]; truncated: boolean }
  /** Slide-deck preview (PPTX): one card per slide with text and pictures. */
  | { kind: 'slides'; format: string; slides: CanvasSlidePreview[]; truncated: boolean }
  /** Nothing readable: the node shows the reason plus a download action. */
  | {
    kind: 'none'
    format: string
    /** Machine-readable reason so the browser can localize its own copy. */
    reason: 'unsupported' | 'unreadable'
    /** Host-side detail; used as a tooltip fallback, never as primary copy. */
    message?: string
  }

/** One styled run of rich document text (bold / italic fragments). */
export interface CanvasDocRun {
  text: string
  bold?: true
  italic?: true
}

/** One block of a structured document preview. Lists arrive pre-grouped so the
 *  renderer only walks a flat sequence. */
export type CanvasDocBlock =
  | { type: 'heading'; level: 1 | 2 | 3; runs: CanvasDocRun[] }
  | { type: 'paragraph'; runs: CanvasDocRun[] }
  | { type: 'list'; ordered: boolean; items: CanvasDocRun[][] }
  | { type: 'table'; rows: string[][] }

/** One slide of a PPTX preview: title, body lines and embedded pictures as
 *  data URLs (bounded: raster formats only, capped count and total bytes). */
export interface CanvasSlidePreview {
  title?: string
  lines: string[]
  images: Array<{ mime: string; data: string }>
}

/** Provenance stamped on nodes produced by a canvas skill run. */
export interface CanvasSkillProvenance {
  id: string
  label: string
  sourceNodeIds: string[]
  createdAt: number
  /** Wall-clock duration of the producing run in ms (absent for instant runs). */
  durationMs?: number
}

/**
 * One skill offered to canvas nodes. `builtin` entries are implemented by this
 * plugin (prompt actions, extraction, PPT conversion); `external` entries come
 * from the host skill registry (`ctx.skills`) and run through their own body.
 */
/**
 * Local clip stitching seam (ffmpeg).
 *
 * One interface, injected into the runner, covering every step the host must do
 * on the runner's behalf: locate ffmpeg, find the bytes behind a served clip
 * URL, run the pipeline, and persist the result. Keeping it as a single seam
 * means the smoke suites can exercise the whole compose path — ordering, stage
 * text, produced node, error surfacing — with a fake, offline and with no
 * ffmpeg installed.
 *
 * Deliberately expressed with plain types (no `node:` imports) so it can live
 * in the shared protocol file and still be inlined into the browser bundle.
 * The client never stitches anything; it only asks the host to.
 */
export interface ClipComposer {
  /** False when no usable ffmpeg/ffprobe pair was found; the run fails loudly. */
  available: () => boolean
  /** Human-readable resolution result, surfaced in errors and the run stage. */
  describe: () => string
  /**
   * Resolve a served clip URL back to its local file, when the bytes are still
   * on disk. Undefined means this clip can no longer be read (evicted history,
   * foreign URL) and the caller must fail the run rather than skip the clip —
   * silently dropping one would make the result shorter than the badges promise.
   */
  resolve: (url: string) => Promise<string | undefined>
  /**
   * Stitch clips in the given order into one MP4. `sources` are local file
   * paths, in final play order.
   *
   * `trims` and `transitions` are optional so a plain stitch keeps its original
   * shape; a timeline editor fills them from its own model. Index i of `trims`
   * belongs to source i, and index i of `transitions` is the seam between
   * source i and i+1.
   */
  stitch: (input: {
    sources: readonly string[]
    /** Per-source in-point and length, in seconds; absent = whole clip. */
    trims?: readonly { start: number; seconds?: number }[]
    /** Seam kinds, in order; absent = every seam is a hard cut. */
    transitions?: readonly { kind: 'cut' | 'fade' | 'dissolve'; seconds: number }[]
    /** False drops audio entirely (a silent film). Defaults to true. */
    keepAudio?: boolean
    signal?: AbortSignal
    /** Called as the pipeline advances, for the task's `stage` text. */
    onStage?: (stage: 'probe' | 'encode') => void
  }) => Promise<ClipStitchResult>
  /** Persist the produced bytes as one history entry; returns its served ref. */
  publish: (input: {
    id: string
    bytes: Uint8Array
    mime: string
    /** Measured length of the produced clip, in seconds. */
    duration?: number
    /** Human-readable provenance ("stitched from 3 clips"). */
    prompt: string
    /**
     * 这次拼接属于哪张画布。
     *
     * WHY 拼接入参也要带：成片会写进视频历史，而历史列表要把画布产物与用户
     * 自己生成的作品分开。技能运行本来就知道 `canvasId`，不传就只剩一条
     * 「不知道谁拼的」的孤立成片。
     */
    canvasId?: string
  }) => Promise<{ url: string; mime: string; duration?: number }>
}

/** Result of one ffmpeg stitch run. */
export interface ClipStitchResult {
  bytes: Uint8Array
  mime: string
  /** Measured from the produced file, not summed from the inputs. */
  duration?: number
  width?: number
  height?: number
}

export interface CanvasSkillDescriptor {
  id: string
  name: string
  description: string
  whenToUse?: string
  origin: 'builtin' | 'external'
  /**
   * light  = one chat completion.
   * heavy  = a headless DSH agent run (needs the agent runtime installed).
   * local  = a local subprocess on this machine — no model, no agent, no
   *          network. `compose.videos` is the only entry today (ffmpeg).
   */
  tier: 'light' | 'heavy' | 'local'
  accepts: CanvasNodeType[]
  output: 'text' | 'image' | 'file' | 'video' | 'nodes'
  /** Human-readable cost/time hint shown before a heavy run. */
  costHint?: string
  /** Extra preconditions the run reports as actionable errors. */
  requires?: string[]
  /** Built-in parameter vocabulary, e.g. polish styles. */
  params?: Array<{ id: string; label: string; placeholder?: string }>
  /** Host-skill name backing this entry (built-in deck conversion included). */
  skillName?: string
  /** Canonical home of the backing skill, offered as a one-click install. */
  installUrl?: string
  /**
   * Labels of required configuration fields that still have no value. The
   * picker shows them with a "go configure" affordance; it does not disable the
   * action, because a skill may still run without the value.
   */
  configMissing?: string[]
}

export type CanvasSkillTier = CanvasSkillDescriptor['tier']

export type CanvasSkillRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** Node/connection drafts a finished run hands back to the browser. The client
 *  is the single writer: it merges these into the document through its own
 *  mutation path so undo, autosave and revision checks keep working. */
export interface CanvasSkillOutput {
  nodes: CanvasNode[]
  connections: CanvasConnection[]
  warnings: string[]
}

/** Live PPT execution progress, read from the skill's own run directory.
 *  Page states come from the upstream `page_jobs.json` validation records, never
 *  from a timer, so a stalled run shows its last observable state instead of a
 *  made-up percentage. */
export interface PptTaskProgress {
  lastActivityAt: number
  currentOperation?: string
  upstreamStage?: string
  pages?: Array<{ page: number; state: 'pending' | 'running' | 'validated' }>
  events: Array<{ time: number; label: string; state: 'running' | 'done' | 'warning' }>
}

export interface CanvasSkillTask {
  progress?: PptTaskProgress
  /** Trace identifiers for finding the corresponding host execution log. */
  agentSessionId?: string
  runDirectory?: string
  /** History/checkpoint failure, separate from conversion success or failure. */
  persistenceError?: string
  /** Standalone PPT conversions retain their ordered input thumbnails. */
  pptImages?: CanvasAssetRef[]
  id: string
  canvasId: string
  skillId: string
  label: string
  tier: CanvasSkillTier
  status: CanvasSkillRunStatus
  /** Coarse progress stage for the UI (queued / preparing / running / collecting). */
  stage?: string
  /** Machine-readable phase that drives the run card's step indicator. */
  phase?: 'queued' | 'preparing' | 'running' | 'collecting'
  /** Input node ids the run was queued with (the client rebuilds its run cards). */
  nodeIds?: string[]
  startedAt: number
  finishedAt?: number
  /** Copy language of the run, so polled stages stay in the caller's language. */
  language?: string
  output?: CanvasSkillOutput
  error?: string
}

export interface CanvasSkillRunRequest {
  canvasId: string
  skillId: string
  /** Nodes whose content feeds the run (the selected/acting node first). */
  nodeIds: string[]
  /** Free-form instruction (custom polish, extra requirements). */
  instruction?: string
  /** Built-in parameter selection, e.g. `{ style: 'formal' }`. */
  params?: Record<string, string>
  /** New-node placement hint, mirroring the generation workflow. */
  placement?: 'right' | 'below'
  /** UI language for host-rendered copy (pool copy, errors, stage labels). */
  language?: string
}

/** Polls and cancels carry the same language hint so stages stay translated.
 *  A `canvasId` without a `taskId` lists that canvas's unfinished runs, which
 *  is how a reopened canvas rebuilds its live run cards. */
export interface PptRunRequest {
  images: CanvasAssetRef[]
  /** The user chose offline OCR in the conversion form. */
  offlineOcr: boolean
  language?: string
}

export interface PptRuntimeStatus {
  available: boolean
  message: string
}

export interface CanvasSkillTasksRequest {
  taskId: string
  canvasId?: string
  language?: string
}

export interface CanvasSkillCatalog {
  skills: CanvasSkillDescriptor[]
  /** Whether the host agent runtime is available for heavy skills. */
  agentAvailable: boolean
  /** Whether the host skill registry answered. */
  registryAvailable: boolean
  /**
   * Names of the external skills the canvas can actually offer: whatever the
   * host registry exposes plus everything loadable under the local skill root
   * (`~/.dsh/skills`). Drives the install affordance on entries whose backing
   * skill is missing.
   */
  installed: string[]
  /** Why the catalog is partial, when it is. */
  reason?: string
}

/** One configuration field a skill declares (see `docs/skill-config.md`). */
export interface CanvasSkillConfigField {
  id: string
  label: string
  description?: string
  type: 'string' | 'secret' | 'boolean' | 'number' | 'select'
  required?: boolean
  default?: string
  /** `select` only. */
  options?: Array<{ value: string; label: string }>
  /**
   * Whether the value may ride the run prompt as a "configured" context block.
   * Secrets are never exposable, whatever the declaration says.
   */
  expose?: boolean
}

/**
 * One skill's configuration as the panel sees it. Values are never secrets: a
 * secret field reports only whether the host holds one.
 */
export interface CanvasSkillConfigView {
  fields: CanvasSkillConfigField[]
  values: Array<{ id: string; set: boolean; value?: string }>
  /** Where the declaration came from: the skill bundle, or this plugin. */
  source: 'skill' | 'plugin'
  /** Whether `apply` declares steps "save and apply" can run. */
  applicable: boolean
  /** Labels of required fields that still have no value. */
  missing: string[]
  /** Author note rendered above the form. */
  note?: string
  /** Why the declaration was ignored, when it was (host-rendered copy). */
  issue?: string
}

/** Save request: only the fields the user edited are sent. */
export interface CanvasSkillConfigSaveRequest {
  name: string
  /** Edited values; an empty string clears that field. */
  values?: Array<{ id: string; value: string }>
  language?: string
}

export interface CanvasSkillConfigSaveResult {
  ok: boolean
  library: CanvasSkillLibrary
  message?: string
}

/** One executed `apply` step, as reported back to the panel. */
export interface CanvasSkillConfigStep {
  kind: 'command' | 'file'
  /** Human-readable summary of what was executed or written (secrets masked). */
  detail: string
  ok: boolean
  /** Tail of the command output, secrets masked. */
  output?: string
}

export interface CanvasSkillConfigApplyRequest {
  name: string
  language?: string
}

export interface CanvasSkillConfigApplyResult {
  ok: boolean
  library: CanvasSkillLibrary
  steps: CanvasSkillConfigStep[]
  message?: string
}

/** One skill inside the local skill library (`~/.dsh/skills`). */
export interface CanvasSkillLibraryEntry {
  name: string
  description: string
  /** Registry path of the skill's `SKILL.md`, when the registry reports one. */
  path?: string
  sizeBytes: number
  updatedAt: number
  /** Browsable upstream home, when this plugin knows one for the name. */
  installUrl?: string
  /**
   * Why the node skill menu cannot offer this entry, in the caller's language.
   * Present when the host skill registry would ignore the bundle (a
   * non-kebab-case frontmatter name, a missing description, a user-only
   * invocation policy), so an install that "succeeded" is never silently
   * unusable.
   */
  issue?: string
  /** The skill's declared configuration, when it has one. */
  config?: CanvasSkillConfigView
}

export interface CanvasSkillLibrary {
  /** Root the host writes installs into. */
  root: string
  entries: CanvasSkillLibraryEntry[]
  /** Names a source install is available for, so the UI can offer one click. */
  catalog: Array<{ name: string; url: string }>
  /** Whether the host can fetch sources at all (git / network availability). */
  networkAvailable: boolean
}

export interface CanvasSkillInstallRequest {
  /** One or more sources: a git URL, an archive URL, or a raw `SKILL.md` URL. */
  sources?: string[]
  /** Previously uploaded archive asset (from the canvas file upload route). */
  asset?: CanvasAssetRef
  /** Target folder name override for archive installs that carry no name. */
  name?: string
  /** Replace an already installed skill of the same name. */
  force?: boolean
  language?: string
}

export interface CanvasSkillInstallResult {
  ok: boolean
  installed: string[]
  failed: Array<{ source: string; message: string }>
  library: CanvasSkillLibrary
  message?: string
}

export interface CanvasSkillRemoveRequest {
  name: string
  language?: string
}

export interface CanvasSkillRemoveResult {
  ok: boolean
  library: CanvasSkillLibrary
  message?: string
}

/** Normalized (0..1) rectangle inside an image asset: origin top-left. */
export interface CanvasRect {
  x: number
  y: number
  width: number
  height: number
}

/** One annotation box drawn on an image node by the 标注 tool. */
export interface CanvasAnnotation extends CanvasRect {
  id: string
  /** Text node holding the prompt for this box (absent once deleted). */
  nodeId?: string
}

/** Layer kinds produced by the canvas layer-split tool. */
export type CanvasLayerKind = 'background' | 'object' | 'text'

/** One layer in a vision-model decomposition of an image. */
export interface CanvasLayerPlanItem {
  kind: CanvasLayerKind
  label: string
  /** Object/text layers: the normalized box the layer occupies. */
  rect?: CanvasRect
  /** Text layers: the recognized string. */
  text?: string
  /** Text layers: recognized color as a hex string. */
  color?: string
}

/** Result of the host-mediated layer decomposition. */
export interface CanvasLayerPlan {
  layers: CanvasLayerPlanItem[]
}

/** Provenance kept on nodes produced by the layer-split tool. */
export interface CanvasLayerInfo {
  kind: CanvasLayerKind
  label: string
  sourceNodeId: string
}

/** One free-hand stroke on a sketch board. Points are normalized to the board
 *  rect (0..1 on both axes) so the drawing survives resize and raster export. */
export interface CanvasSketchStroke {
  color: string
  /** Stroke width in board pixels (the board's on-screen size at 100% zoom). */
  width: number
  points: Array<{ x: number; y: number }>
}

/** Sketch boards: vector strokes kept in node metadata, rasterized to a PNG
 *  asset in the background so downstream nodes treat the board like an image. */
export interface CanvasSketchDrawing {
  strokes: CanvasSketchStroke[]
}

/** 姿势人偶的关节名。与人偶骨骼的层级一一对应（见 `canvas/pose-rig.ts`）。 */
export type CanvasPoseJoint =
  | 'hips' | 'spine' | 'chest' | 'neck' | 'head'
  | 'shoulderL' | 'elbowL' | 'handL'
  | 'shoulderR' | 'elbowR' | 'handR'
  | 'hipL' | 'kneeL' | 'footL'
  | 'hipR' | 'kneeR' | 'footR'

/** 一个关节绕自身三个轴的旋转，单位为度。 */
export interface CanvasPoseAngles { x: number; y: number; z: number }

/**
 * 姿势节点：一套关节角度。
 *
 * 与草图画板同一个模式——节点本体只带这份数据，预览在客户端算，导出时画成
 * 一张 PNG 落进 `metadata.asset`，于是下游只看见一个普通 image 节点，生成、
 * 标注、图库、导出全都不必知道「姿势」存在。
 *
 * `joints` 允许缺项：缺的那个关节按 0 度处理。这样新增关节不会让老文档读不
 * 动，而校验器也只需要拒绝「有但类型不对」的值。
 */
export interface CanvasPoseRig {
  joints: Partial<Record<CanvasPoseJoint, CanvasPoseAngles>>
  /** 整体朝向，绕 y 轴，单位为度；0 = 正面朝相机。 */
  facing: number
}

/**
 * 导演台里的一个角色：一套姿势 + 它在世界里的站位。
 *
 * `id` 是稳定的引用键（机位、面板选中态、将来 Agent 的工具调用都指向它），
 * 不用数组下标——删掉一个角色之后，下标会把所有人的选中态错位一格。
 */
export interface CanvasPoseActor {
  id: string
  /** 显示名，也画在角色头顶（`scene.labels` 打开时）。 */
  name: string
  rig: CanvasPoseRig
  /** 站位：世界坐标（米），x 右、z 朝相机。y 由落地自动决定，不存。 */
  x: number
  z: number
  /** 整体缩放，1 = 标准身高。可以拿来做「远处的路人」。 */
  scale?: number
  /** 绕 y 轴额外旋转（度），叠加在 `rig.facing` 之上。 */
  rotation?: number
}

/**
 * 一台机位：显式视点 + 注视点 + 视场角。
 *
 * 故意不用 yaw/pitch/distance：机位是「摆在哪、看向哪」，和环绕相机的参数
 * 不是同一件事。用环绕参数存机位，用户拖动视点时会看到视场角跟着一起变。
 */
export interface CanvasPoseCamera {
  id: string
  name: string
  /** 视点（米）。 */
  x: number
  y: number
  z: number
  /** 注视点（米）。 */
  targetX: number
  targetY: number
  targetZ: number
  /** 竖直视场角（度）。 */
  fov: number
}

/**
 * 场景：地面、天空、全景球与整组变换。
 *
 * 变换（平移/旋转/缩放）是**整组**施加在角色与地面上的，不是单独挪相机：
 * 用户说「场景缩放 300%」时，期望的是人变大、地面跟着变大，而不是相机
 * 凑近——后者会把地面网格拉成一片放射线。
 */
export interface CanvasPoseScene {
  /** 天空（上半）颜色，CSS 颜色字符串。 */
  sky: string
  /** 地面颜色；缺省由天空色推出来。 */
  ground?: string
  /**
   * 人偶材质。缺省 `clay`（灰白膜）。
   *
   * 木色是早期「木制人偶」的辨认特征，但 blocking 阶段更需要的是一块
   * 中性、不参与画面冷暖的体块；木色留成可选，不改老文档的数据形状。
   */
  figure?: CanvasFigureMaterial
  /**
   * 角色底模。缺省 `standard`（标准蒙皮人形）；`procedural` 是轻量木偶回退。
   *
   * 标准体需要 three.js/WebGL；2D 回退永远画程序化木偶。
   */
  body?: CanvasFigureBody
  /** 整组平移（米）。 */
  translate: [number, number, number]
  /** 整组绕 y 旋转（度）。 */
  rotateY: number
  /** 整组缩放。 */
  scale: number
  /** 全景球水平旋转（度）与半径（米）。半径只影响采样时的映射强度。 */
  panoYaw: number
  panoRadius: number
  /** 角色头顶的名字标签。 */
  labels: boolean
}

/** 人偶材质：灰白膜（默认）或木色。 */
export type CanvasFigureMaterial = 'clay' | 'wood'

/** 角色底模：标准蒙皮人形或程序化木偶。 */
export type CanvasFigureBody = 'standard' | 'procedural'

/**
 * 导演台：多角色 + 多机位 + 场景。
 *
 * 与 `pose` 的关系是**并列而非替代**：老文档只有 `pose`，读的时候按单角色
 * 舞台合成（见 `pose-stage.ts` 的 `stageOf`），不写盘、不改字节；一旦用户
 * 在导演台里动了任何东西，写 `stage` 的同时把 `actors[0].rig` 镜像回 `pose`
 * ——这样同一份文档在旧版本插件里仍然是一张姿势人偶，不是一张空白图片。
 */
export interface CanvasPoseStage {
  actors: CanvasPoseActor[]
  cameras: CanvasPoseCamera[]
  /** 当前选中的机位；缺省用第一台。 */
  cameraId?: string
  scene: CanvasPoseScene
  /**
   * 底部那一行「描述想要搭建的场景」。
   *
   * 它只是节点上的一句话，**不是**一条生成指令：这一版还没有把导演台接到
   * Agent 上，静默丢掉用户敲的字比留着一个不触发的字段更糟。写成可选字段，
   * 缺项照旧合法。
   */
  prompt?: string
  /**
   * 时间轴。**缺项 = 静态舞台**：老文档没有这个字段，编辑器按「没有时间维度」
   * 渲染，不写盘、不改字节。一旦用户动了关键帧或时长，整份 timeline 一起写。
   *
   * 为什么整份存而不是每条轨道分开存：关键帧的时间与时长是同一个坐标系，
   * 拆开放进 actor / camera 里，删掉一个对象时它的轨道就成了孤儿，而校验器
   * 没有办法知道该删哪一半。集中一处，删对象就是删一条轨道。
   */
  timeline?: CanvasStageTimeline
  /**
   * 场景道具：立方体、球体、导入的 GLB。
   *
   * 与 actors 分开而不是都塞进 actors：角色的核心是 rig（骨骼），道具没有
   * 骨骼、只有变换与尺寸。合成一个数组之后，每个遍历 actor 的地方——姿势
   * 面板、骨骼投影、关键帧快照——都要先判一次「这是不是人」，而漏判的表现
   * 是给立方体画一副骨架。
   *
   * 缺项 = 没有道具，老文档照旧合法。
   */
  props?: CanvasStageProp[]
}

/** 道具的形状。`glb` 是需要显式上传的模型，其余是程序化的基础几何。 */
export type CanvasStagePropKind = 'cube' | 'sphere' | 'glb'

/**
 * 场景里的一个道具。
 *
 * 位置存 `y`（与角色不同）：角色是「站在地上」，y 由落地决定；道具可以被
 * 摆在半空——把盒子垫在脚下、让球悬在头顶，都是常见需求，用一个隐式落地
 * 规则满足不了。
 */
export interface CanvasStageProp {
  id: string
  name: string
  kind: CanvasStagePropKind
  /** 世界坐标（米）。 */
  x: number
  y: number
  z: number
  /** 绕各轴的欧拉角（度）。 */
  rotateX?: number
  rotateY?: number
  rotateZ?: number
  /** 缩放。`cube`/`sphere` 的基准边长是 1 米。 */
  scaleX?: number
  scaleY?: number
  scaleZ?: number
  /**
   * GLB 模型的来源。`glb` 之外忽略。
   *
   * 用画布资产引用而不是内联字节：一个 GLB 动辄几 MB，写进节点会让整份画布
   * JSON 变成十几 MB，每次保存都重传一次。存在资产里，引用只带 id。
   */
  asset?: { assetId: string; url: string; name?: string }
}

/**
 * 时间轴：时长 + 帧率 + 每条轨道的动画。
 *
 * 帧率固定 30（不是可选参数）：导出 MP4 时逐帧交给宿主 ffmpeg 编码，帧率
 * 一变，`at` 里的帧号含义就跟着变，用户改一次时长整条轨道的时间就对不上了。
 * 存成「秒」而不是「帧」也同理——帧号是渲染期的派生量。
 */
export interface CanvasStageTimeline {
  /** 工程时长（秒），2–15 的整数。 */
  duration: number
  /** 固定 30。写进数据是为了让导出端不必猜，而不是给用户改。 */
  fps: number
  /** 每条轨道对应一个对象（角色 id 或机位 id）。 */
  tracks: CanvasStageTrack[]
}

/** 一条轨道：属于某个对象，按时间排好的关键帧。 */
export interface CanvasStageTrack {
  /** 指向 `actors[].id` 或 `cameras[].id`。 */
  targetId: string
  /** 这个对象是角色还是机位——同一个 id 命名空间下要靠它区分。 */
  target: 'actor' | 'camera'
  /** 关键帧，按 `at` 升序。同一时刻最多一个（写入时后到者覆盖）。 */
  keyframes: CanvasStageKeyframe[]
  /**
   * 运动轨迹片段（路径动画）。与位置关键帧互斥：一段轨迹在时间上覆盖的那
   * 一段里，对象的位置由路径求值，不再读 `position` 关键帧。
   */
  paths?: CanvasStagePath[]
}

/**
 * 一个关键帧。
 *
 * 所有字段都是可选的：机位关键帧只有位姿，角色关键帧可以只有姿势。用
 * 「有什么就插值什么」而不是给每种对象一个独立的关键帧类型，是因为用户会
 * 在同一个时间点上既转身又摆姿势——分成两种关键帧之后，时间轴上那一格会
 * 出现两个重叠的标记，删起来必然误删。
 */
export interface CanvasStageKeyframe {
  /** 时间（秒，对齐到 1/fps 的整数帧）。 */
  at: number
  /** 角色姿势（整份 rig 快照）。插值时逐关节欧拉角线性插值。 */
  rig?: CanvasPoseRig
  /** 角色站位（世界坐标米）。 */
  position?: [number, number, number]
  /** 角色朝向（度，绕 y）。 */
  facing?: number
  /** 机位位姿快照（视点 + 注视点 + 视场角）。 */
  camera?: CanvasPoseCamera
}

/** 轨迹：把一段路径铺在一段时间上。 */
export interface CanvasStagePath {
  id: string
  /** 形状。`free` 是铅笔/钢笔出来的折线，点直接存在 `points` 里。 */
  shape: 'circle' | 'line' | 'rect' | 'free'
  /** 路径在世界坐标里的控制点（米）。circle 用前两个点定圆心与半径。 */
  points: Array<[number, number, number]>
  /** 这段路径生效的时间窗口（秒）。 */
  start: number
  end: number
  /** 路径高度（米）；0 = 贴地。 */
  height?: number
  /** 沿路径朝向（角色朝切线方向）而不是保持固定朝向。 */
  orient?: boolean
}

export interface CanvasViewport {
  x: number
  y: number
  /** Zoom factor. */
  k: number
}

/** Free-form per-node state, mirroring the node-graph canvas model. */
/**
 * One finished clip on a canvas video node.
 *
 * Deliberately NOT a {@link CanvasAssetRef}: a clip lives in the video store
 * and is served from there, so its `url` is the video route and it carries no
 * `assetId`. Keeping the two shapes distinct stops the canvas asset upload path
 * (which expects a content-addressed id and copies bytes) from ever being
 * pointed at a clip.
 */
export interface CanvasVideoRef {
  /** Same-origin video-store URL, e.g. `${VIDEO_API.file}/<file>`. */
  url: string
  mime: string
  /** Clip length in seconds, when the provider reported it. */
  duration?: number
  /** Bytes on disk, when known (shown in the node footer). */
  bytes?: number
  /** The video-history entry this clip came from, for gallery round-trips. */
  entryId?: string
  /** Provider result URL, retained in case local persistence was unavailable. */
  sourceUrl?: string
}

/**
 * Re-exported so the host half and the client bundle agree on one poster
 * recipe shape without the client importing a second module by path.
 */
export type { PosterDocument, PosterImageLayer, PosterLayer, PosterTextLayer } from './poster.ts'

/** What an image node represents when it is pinned as an identity reference. */
export type CanvasCastRole = 'character' | 'item' | 'style'

/**
 * Identity anchoring: an image node marked as a cast member.
 *
 * The definition lives ON the node rather than in a separate registry, so there
 * is exactly one place a face can be changed and every later generation picks
 * it up. Marking is a property of an ordinary image node — no new node type, no
 * extra document field, and a canvas without one behaves exactly as before.
 */
export interface CanvasCastMember {
  role: CanvasCastRole
  /** Name used in the prompt ("the character 阿禾"); defaults to the node title. */
  name?: string
}

/**
 * 套图里的一条：一句带标题的提示词。
 *
 * `title` 会落到结果节点的标题上（「正面视图 · 第1张」比「图片节点」有用），
 * 所以它在文档里是有意义的数据，不是给人看的备注。`id` 只用于 React 列表
 * 的 key 与「改哪一条」，不参与生成。
 */
export interface CanvasPromptSetItem {
  id: string
  /** 这一条的名字；空串表示「用兜底标题」。保存时允许为空（用户正在打字）。 */
  title: string
  /** 这一条真正发出去的提示词；空串表示这一条还没写。 */
  prompt: string
}

export interface CanvasNodeMetadata {
  /**
   * 这一张被钉住了：拖不动、改不了大小、删不掉。
   *
   * 存在 metadata 而不是新字段：老文档没有它，读出来就是「没锁」，零迁移；
   * 而锁定是单张卡片自己的属性，跟画布、跟分组都无关。
   */
  locked?: boolean
  /**
   * 这一张收起来了：不渲染、不参与框选，但仍在 `nodes` 数组里。
   *
   * WHY 不真的从数组里删掉：删了就再也找不回来。隐藏是「暂时别看」，不是
   * 「不要了」——两者的差别只有用户自己知道。
   */
  hidden?: boolean
  /**
   * Image nodes: this node is a pinned identity reference. Generation attaches
   * it (and every other pinned node) as a reference image automatically.
   */
  cast?: CanvasCastMember
  /**
   * Image nodes: the editable overlay recipe behind the flattened asset. The
   * asset stays the rendered image, so every existing reader (node body,
   * download, generation reference) keeps working and only the editor reads
   * this field.
   */
  poster?: import('./poster.ts').PosterDocument
  /** Image nodes: the rendered asset. */
  asset?: CanvasAssetRef
  /**
   * Video nodes: the finished clip, described like any other asset so the node
   * renderer and the toolbar treat it uniformly. Its `url` points at the video
   * store route (not the canvas asset route), so the clip is referenced rather
   * than copied into the canvas asset library.
   */
  video?: CanvasVideoRef
  status?: 'idle' | 'generating' | 'success' | 'error'
  error?: string
  /**
   * 这个节点的失败是不是「任务从宿主队列里消失了」，而不是上游真的报错。
   *
   * WHY 一个标记而不是只看 `error` 文本：文案随语言变（`videoTaskLost` 有三套
   * 翻译），而历史认领必须能事后重建。只比对字符串的话，用户切一次语言，那个
   * 已经被误判的节点就再也救不回来了。老文档没有这个字段，认领处仍保留对旧
   * 文案的比对作为兼容。
   */
  failure?: 'task-lost'
  /** Config/image nodes: generation settings. */
  prompt?: string
  model?: string
  /** Channel selected alongside the model; omitted means the default channel. */
  channelId?: string
  size?: string
  quality?: string
  /** Config nodes: how many images to generate (1-4). */
  count?: number
  /**
   * 配置节点：一组**带标题的提示词**（套图）。跑一次，每条各出一张图。
   *
   * 与 `count` 语义相反，不要合并：`count` 是「同一条出 N 张」（求同，用来
   * 挑最好的一张），套图是「N 条各出一张」（求异，用来一次出齐一套三视图 /
   * 一组电商图）。把两者塞进同一个数字，填 3 想出一套三视图的人会拿到三张
   * 一样的正面。
   *
   * 只有配置节点读它；别的类型上出现也合法（老文档、复制粘贴都可能带过来），
   * 只是没人读——那条取舍写在 `canvas-store` 的类型守卫旁边。
   */
  promptSet?: CanvasPromptSetItem[]
  /** Config nodes: generation mode (image), video, or plain writing (text). */
  mode?: 'image' | 'text' | 'video'
  /** Config/video nodes: the video generation mode (which reference inputs the
   *  run uses) and its parameters. Present only on video runs. */
  videoMode?: VideoMode
  aspectRatio?: string
  seconds?: number
  resolution?: string
  taskId?: string
  sourceNodeId?: string
  /** Generated nodes: how the run was produced (`code` = chat-written code). */
  renderer?: 'model' | 'code'
  /**
   * Code-rendered nodes: the drawing code that produced them. A retry re-sends
   * it so the same pixels are reproduced instead of paying for another model
   * call — and so the node can show what actually drew it.
   */
  renderSource?: string
  /** Text nodes. */
  text?: string
  fontSize?: number
  /** Text nodes: CSS color for the text (absent = theme label color). */
  color?: string
  /** Text nodes: bold weight toggle. */
  bold?: boolean
  /** Text nodes created by the 标注 tool: the box this prompt describes. */
  annotation?: { sourceNodeId: string; rect: CanvasRect }
  /** Image nodes: annotation boxes drawn on this image. */
  annotations?: CanvasAnnotation[]
  /** Generated nodes: the 标注 edit behind them. The result is composited back
   *  onto the clean original outside these boxes, so the red marker that the
   *  model may echo never reaches the finished image. */
  annotationEdit?: { sourceNodeId: string; boxes: CanvasRect[] }
  /** Image nodes: layer-split provenance (label/kind of the extracted layer). */
  layer?: CanvasLayerInfo
  /** Image nodes: the asset carries real transparency (local matting). */
  transparent?: boolean
  /** Sketch boards: the live drawing behind an image node. */
  sketch?: CanvasSketchDrawing
  /**
   * 姿势人偶：一块带关节角度的人偶，导出成 PNG 落在 `asset` 上。
   *
   * 与 `sketch` 同一个模式——节点仍是 `type: 'image'`，这个字段只是「图片
   * 还没生成时拿什么画预览」。所以删掉它，节点就退回一张普通图片，而不会
   * 变成一份读不懂的文档。
   */
  pose?: CanvasPoseRig
  /**
   * 导演台：多角色 + 多机位 + 场景。
   *
   * 与 `pose` 并存（不是替代）。`pose` 始终镜像 `stage.actors[0].rig`，于是
   * 一份带舞台的文档在只认 `pose` 的旧版本里仍然是一张可用的姿势人偶。
   * 只写 `pose` 的旧文档读出来是一个单角色、单机位的舞台。
   */
  stage?: CanvasPoseStage
  /** File nodes: coarse bucket driving the icon and preview branch. */
  fileKind?: CanvasFileKind
  /** Skill-produced nodes: which skill produced this and from what. */
  skill?: CanvasSkillProvenance
  /**
   * Storyboard nodes: the ordered shot list plus the settings every shot
   * shares. The per-shot clip lives on the video node named by
   * `shots[].nodeId`, never here.
   */
  storyboard?: CanvasStoryboard
  /** Video nodes: the shot that produced this clip, when a storyboard did. */
  shot?: CanvasShotOrigin
}

/**
 * 一块分镜板来自哪份剧集文档。
 *
 * 用它判断「这是同一集的板」：`projectPath` 已经归一化成相对工作区的
 * 形式（`剧集/EP001`），所以工作区换位置也不影响判断。`episode` 单独留着
 * 是给界面显示用的，判等只看 `projectPath`。
 */
export interface CanvasStoryboardSource {
  /** 读文档时用的工作区绝对路径；只作溯源展示，不参与判等。 */
  root: string
  /** 剧集目录，相对工作区，如 `剧集/EP001`。 */
  projectPath: string
  /** 剧集名，如 `EP001`。 */
  episode: string
}

/** A storyboard node's whole editable state. */
export interface CanvasStoryboard {
  /** Shots in play order; the list itself is the film's running order. */
  shots: CanvasShot[]
  /** Shared video settings, the same vocabulary the video node carries. */
  aspectRatio: string
  resolution: string
  /**
   * `cut` starts every shot from text; `carry` feeds each shot the LAST FRAME
   * of the previous shot as its first frame, so consecutive shots join up.
   */
  continuity: 'cut' | 'carry'
  /** Shared model override; absent means the canvas default video model. */
  model?: string
  channelId?: string
  /**
   * 这块板是从哪份剧集文档铺出来的。
   *
   * WHY 记在板上：铺板动作是幂等的——同一部剧的同一集再铺一次，该更新
   * 原来那块板，而不是在画布上叠第二块 22 镜的板。没有这个标记就只能靠
   * 标题猜，而用户可以改标题、也可能同时铺两集。
   *
   * 老文档没有它，读出来就是「不是从文档铺的」，不需要迁移。
   */
  source?: CanvasStoryboardSource
}

export interface CanvasNode {
  id: string
  type: CanvasNodeType
  title: string
  x: number
  y: number
  width: number
  height: number
  metadata?: CanvasNodeMetadata
}

/**
 * What an upstream node supplies to its downstream node.
 *
 * `input` is the historical meaning and the default: the downstream node just
 * receives it. The other three only matter to video generation, where the
 * order of the references decides which picture becomes the first frame and
 * which becomes the last — an order that used to be "whatever the connections
 * array happened to hold", so deleting and re-drawing one wire silently
 * swapped the two frames.
 *
 * Absent means `input`. Old documents never carry this field and must keep
 * loading unchanged; see `canvas/connection-role.ts` for the one place that
 * resolves it.
 */
export type CanvasConnectionRole = 'input' | 'first' | 'last' | 'reference'

export interface CanvasConnection {
  id: string
  fromNodeId: string
  toNodeId: string
  /** Optional so every canvas written before this field still loads. */
  role?: CanvasConnectionRole
}

/**
 * A named box the user draws around a set of nodes.
 *
 * WHY a top-level array and not a `groupId` on each node: a group is a thing the
 * user names and can act on as a whole ("ungroup", later "run this group"), and
 * membership has to be readable in one place for the frame to be drawn without
 * walking every node. It also keeps `CanvasNode` unchanged, so every canvas
 * written before this feature loads byte-for-byte as it was.
 *
 * WHY `nodeIds` rather than nesting nodes: the canvas drag code moves nodes by
 * writing `x`/`y` on the node itself. Nesting would mean a second coordinate
 * space, and every existing reader (bounds, snap, connections) would have to
 * learn about it. Flat membership costs one prune call at the deletion sites.
 *
 * A node belongs to at most one group; `withGroupSelection` enforces that.
 */
export interface CanvasGroup {
  id: string
  title: string
  nodeIds: string[]
}

export interface CanvasDocument {
  version: 2
  id: string
  title: string
  revision: number
  viewport: CanvasViewport
  background: 'dots' | 'lines' | 'blank' | 'image' | 'flow' | 'liquid' | 'floatingLines' | 'galaxy' | 'silk' | 'waves' | 'faultyTerminal' | 'dotField' | 'dotGrid' | 'shapeGrid'
  /** Custom background image URL (a canvas asset) when background is 'image'. */
  backgroundImage?: string
  nodes: CanvasNode[]
  connections: CanvasConnection[]
  /**
   * Optional so every canvas written before grouping still loads unchanged.
   * Absent and `[]` mean the same thing; readers use `document.groups ?? []`.
   */
  groups?: CanvasGroup[]
  createdAt: number
  updatedAt: number
}

export interface CanvasSummary {
  id: string
  title: string
  revision: number
  nodeCount: number
  createdAt: number
  updatedAt: number
  /** User pinned this canvas to the favorites group. */
  favorite?: boolean
  /**
   * 列表里那一格缩略图（画布首张图片节点的资产 URL）。
   *
   * WHY 存在摘要里而不是列表时去读文档：列表要一次画几十张画布，逐个读
   * `pages/*.json` 是几十次磁盘读；而保存时文档本来就在手上，顺手取一张图
   * 的 URL 是零成本。老画布没有这个字段，界面退回到画布图标。
   */
  thumb?: string
  /**
   * Agent 在这份画布上还等着用户点头的改动条数。
   *
   * 有它，用户才能在下拉里看出「哪个画布上有人在等我」——否则切到别的画布
   * 之后，那条提案条就再也看不到了（提案按 canvasId 拉取）。省略或 0 都
   * 表示没有；列表页不会为它多读一遍磁盘。
   */
  proposalCount?: number
}

/** Workflow metadata carried by generated results across task, history and gallery. */
export interface EcommerceTaskMeta {
  workflow?: 'ecommerce' | 'replica'
  projectId?: string
  projectName?: string
  slotKey?: string
  slotLabel?: string
}

/** Role an uploaded product asset plays in the ecommerce workflow. 'none' is
 *  only used as a slot selection meaning "generate without a reference";
 *  'layout' is a composition template the image borrows zoning from, never a
 *  picture of the product itself. */
export type EcommerceRefRole = 'none' | 'product' | 'packaging' | 'detail' | 'style' | 'layout'

/** One planned image slot in a product set. */
export interface ProductSetSlot {
  key: string
  label: string
  description: string
  count: number
  enabled: boolean
  /** Which uploaded asset role this slot uses as its edit reference. */
  refRole?: EcommerceRefRole
}

/** A browser-local ecommerce product-set draft. */
export interface ProductSetDraft {
  projectId: string
  projectName: string
  category: string
  platform: string
  language: string
  /** Custom copy language when language is 'custom'. */
  customLanguage?: string
  size: string
  /** Main-image platform compliance. When true the `main` slot alone is
   *  generated on a pure #FFFFFF background with no props, text or shadow, and
   *  is forced to a square 1:1 (Amazon and friends require exactly that);
   *  every other slot keeps `size`. Drafts saved before this field existed
   *  simply lack it, which reads as false. */
  whiteBackground?: boolean
  productName: string
  /** 参数信息（提示词）: the merged reference-info field (v1.5.9+). */
  promptInfo: string
  /** Per-image prompt overrides keyed by `slotKey` (`main-1`, `selling-2`…);
   *  written from the pre-generation preview board. */
  promptOverrides?: Record<string, string>
  /** Legacy v1.5.9 separate fields; folded into promptInfo on load. */
  sellingPoints?: string
  protectedFeatures?: string
  styleHint?: string
  slots: ProductSetSlot[]
}

/** Host-mediated product-listing copy generation endpoint. */
export const LISTING_COPY_API = '/api/dsh-imagegen/listing-copy' as const
/** Host-side product page extraction endpoint. */
export const ECOMMERCE_LINK_API = '/api/dsh-imagegen/ecommerce/fetch-link' as const
export interface EcommerceLinkResult {
  ok: boolean
  title?: string
  images?: string[]
  sellingPoints?: string[]
  price?: string
  source?: 'json-ld' | 'og'
  reason?: 'blocked-host' | 'timeout' | 'too-large' | 'not-html' | 'no-product-data' | 'fetch-failed'
}

/** One generated product-listing spec row. */
export interface ListingSpec {
  name: string
  value: string
}

/** Structured listing copy the model must produce (fields may be missing). */
export interface ListingCopy {
  title?: string
  sellingPoints?: string[]
  description?: string
  keywords?: string[]
  specs?: ListingSpec[]
}

/** A client → host listing-copy request, projected from the product draft. */
export interface ListingCopyRequest {
  productName: string
  category: string
  platform: string
  language: string
  /** User-supplied product facts; the model must not invent beyond these. */
  promptInfo: string
}

/** A client → host listing-copy reply. `ok: false` carries an actionable message. */
export type ListingCopyResult =
  | { ok: true; copy: ListingCopy }
  | { ok: false; code: 'listing-copy-failed' | 'listing-copy-unstructured'; message: string }

/** A client → host generate request (what the panel collects). */
export interface GenerateRequest extends EcommerceTaskMeta {
  /** Tool name marker for Agent-submitted generations (history bookkeeping). */
  agentTool?: string
  /** text-to-image (images/generations) or image-to-image (images/edits). */
  mode: GenerateMode
  /**
   * User-facing model name (an alias from the channel's model catalog). The
   * host maps it onto the configured channel and fills `upstream` with the
   * real id before the engine sees it.
   */
  model: string
  /** The prompt. Upstream providers may impose their own length limits. */
  prompt: string
  /** Canvas size as an aspect ratio: 'auto' or e.g. '1:1' / '16:9' / '21:9'.
   *  The host maps it onto each model's own vocabulary (aspect_ratio for Grok
   *  and Nano Banana, resolution-tier size for Seedream, the closest pixel size for
   *  OpenAI-compatible endpoints). */
  size: string
  /** Clarity tier: 'auto' | '1k' | '2k' | '4k'. The host maps it onto the
   *  model's own vocabulary (resolution for Grok, image_size for Nano Banana,
   *  and size for Seedream,
   *  Nano Banana, quality for OpenAI). */
  quality: string
  /** Number of images, 1-4. */
  n: number
  /**
   * Passthrough detail parameter: '' (omit), 'standard', or 'high'. Some
   * gpt-image-2 gateways expose it; official OpenAI endpoints reject unknown
   * parameters, so the UI defaults to '' (omit).
   */
  detail: string
  /**
   * Output format. Absent and 'png' both mean the still image path; `gif`
   * asks gpt-image-2.6 for an animated GIF through `output_format: 'gif'`.
   * Generation only: the upstream guide states /images/edits does not do GIF.
   */
  outputFormat?: 'png' | 'gif'
  /** GIF frame count (host clamps to 2-16). Only meaningful with `gif`. */
  frameCount?: number
  /** GIF per-frame delay in milliseconds (host clamps to >= 20). Only with `gif`. */
  frameDurationMs?: number
  /** Reference image as a data URL (edit mode only). */
  image?: string
  /** Additional reference images as data URLs (edit mode only). The first
   *  image stays in `image`; providers that accept several references get them
   *  all, single-reference providers see `image` alone. */
  images?: string[]
  /** Original reference-image name, retained in the history entry. */
  refName?: string
  /** Channel this request targets (the host falls back to the default when
   *  absent, and re-routes by model alias when the alias lives elsewhere). */
  channelId?: string
  /** Channel display name snapshot, kept on the history entry (host-filled). */
  channel?: string
  /** Upstream model id actually sent to the gateway (host-filled from the
   *  alias mapping; defaults to `model` when absent). */
  upstream?: string
  /** Stable client-created id shared by the tasks in one comparison run. */
  comparisonId?: string
  /** All model aliases selected for one comparison run. */
  comparisonModels?: string[]
  /** Optional canvas lineage metadata. */
  canvas?: CanvasTaskMeta
  /**
   * How this still should be produced. Absent means the image model path, which
   * is the historical behaviour; `code` makes a chat model write drawing code
   * that this host renders locally — no image model is contacted.
   */
  renderer?: 'model' | 'code'
  /**
   * A drawing source produced by a previous code run. A retry sends it back so
   * the same still is reproduced without another chat call.
   */
  renderSource?: string
}

/** One generated image, normalized host-side to base64 so the browser never
 *  has to fetch the upstream (no CORS, no key exposure). */
export interface GeneratedImage {
  /** Raw base64 payload (no data: prefix). */
  b64: string
  /** MIME type of the payload, e.g. image/png. */
  mime: string
  /** Upstream revised prompt, when provided. */
  revisedPrompt?: string
}

/** Successful generate outcome. */
export interface GenerateResult {
  images: GeneratedImage[]
  /** Id of the history entry persisted for this generation (files[] paths key off it). */
  embedId?: string
  /** Updated host-persisted history, when returned by the generate route. */
  history?: HistoryEntry[]
  /** Persistence failure after images were successfully generated. */
  historyError?: string
  /** `code` when a chat model wrote the drawing code for these images. */
  renderer?: 'model' | 'code'
  /** The drawing code that produced the image (code path only). */
  renderSource?: string
  /** True when the model answered prose and the built-in title card drew it. */
  degraded?: boolean
  degradedReason?: string
}

/**
 * One model mapping in a channel's catalog: the display alias the user, the
 * panel, and the Agent see, and the upstream model id actually sent to the
 * gateway. The alias defaults to the upstream id but can be renamed freely.
 */
export interface ModelMapping {
  /** User-facing model name (defaults to the upstream id). */
  alias: string
  /** Upstream model id sent to the gateway. */
  id: string
}

/**
 * One configured image channel (provider). Secrets never live here — the API
 * key is stored at `channelSecrets.<channelId>` in the settings document so
 * whole-array writes can never clobber keys the user did not re-enter.
 */
export interface ChannelConfig {
  /** Stable channel id (the channelSecrets dict is keyed by it). */
  id: string
  /** Preset provider id this channel was created from ('' = custom). */
  preset: string
  /** Display name shown in the list, the panel, and Agent guidance. */
  name: string
  /** OpenAI-compatible base URL, or the exact generation URL when apiUrlFull is true. */
  apiUrl: string
  /** Use apiUrl verbatim instead of appending /images/generations or /images/edits. */
  apiUrlFull: boolean
  /**
   * Ask Seedream to stamp its「AI 生成」corner badge into the result. The official
   * Volcengine Ark / BytePlus API defaults this to `true`, so absent means on;
   * only an explicit `false` is sent upstream, and only to channels that
   * document the field (#56).
   */
  watermark?: boolean
  /**
   * Automatically use the selected model's reference-image ceiling.
   *
   * Absent means true: legacy channels keep the adapter's automatic behavior.
   * `false` pins the safe plugin default (5 images). This is per channel
   * because two channels can serve the same model id with different gateways.
   */
  autoReferenceLimit?: boolean
  /** Request protocol; 'auto' infers chat-completions from an exact chat URL. */
  protocol?: ChannelProtocolPreference
  /** Authentication source; absent means the legacy API-key path. */
  auth?: 'api-key' | 'subscription'
  /** Subscription provider when auth is subscription. */
  subscription?: SubscriptionProvider
  /** The channel's model catalog (alias → upstream id). */
  models: ModelMapping[]
  /**
   * The channel's video model catalog (alias → upstream id). Kept separate from
   * `models` because video models speak the async submit/poll contract rather
   * than the synchronous image one, so the two lists route differently. Absent
   * on channels configured before video support: an absent list is empty.
   */
  videoModels?: ModelMapping[]
}

/** One built-in provider as the settings card consumes it. */
export interface PresetProviderView {
  id: string
  name: string
  apiUrl: string
  /** Public provider page opened from the picker. */
  link?: string
  hint: string
  models: ModelMapping[]
  /** Video model catalog prefilled alongside the image one. */
  videoModels?: ModelMapping[]
  /** Set for subscription-backed presets. */
  subscription?: SubscriptionProvider
  /** True when the subscription relies on an undocumented interface. */
  experimental?: boolean
}

export type GenerationTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface GenerationTask extends EcommerceTaskMeta {
  id: string
  request: GenerateRequest
  status: GenerationTaskStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  result?: GenerateResult
  error?: string
}

/**
 * Wire shape for the queue poll. Reference-image and result payloads stay
 * host-side; the client hydrates a completed task once through TASK_API.get.
 */
export interface GenerationTaskSummary extends Omit<GenerationTask, 'result'> {
  resultAvailable: boolean
}

/** What one upstream attempt was doing (see diagnostics-store.ts). */
export type DiagnosticPhase =
  // image chain
  | 'generate' | 'fetch-result' | 'poll-task' | 'chat' | 'config'
  // video chain. Video is a submit → poll → download
  // pipeline rather than one synchronous call, so each leg is its own phase:
  // "the render never started" and "the status endpoint stopped answering" are
  // different problems, and the image phases cannot express that difference.
  | 'video-submit' | 'video-poll' | 'video-download'
  // Reference media for providers that only accept public HTTPS URLs has to be
  // uploaded before the submit; that leg fails on its own terms (size, format,
  // expiry) and needs its own phase to be readable.
  | 'video-upload'
  // The reasoning step that runs before a submit. Its own phase because a
  // failed plan is neither a rejected submit nor a failed render.
  | 'video-plan'
  // The code-render path: the chat call that writes the drawing code, and the
  // local render that turns it into bytes. Two phases because "the model wrote
  // bad code" and "this machine could not render it" have different fixes.
  | 'code-generate' | 'code-render'

/**
 * One retained upstream attempt (#38). Every string is already redacted
 * host-side, so the panel may render and copy these freely.
 */
export interface DiagnosticEntry {
  id: string
  at: number
  phase: DiagnosticPhase
  channel: string
  model: string
  mode: string
  /** The exact URL called, query string stripped. */
  url: string
  method: string
  status?: number
  errorCode?: string
  failureCode?: string
  message: string
  bodyExcerpt?: string
  requestExcerpt?: string
  requestBytes?: number
  responseBytes?: number
  durationMs: number
  hadAuth: boolean
  apiUrlFull?: boolean
}
/** GitHub Release update information shown by the client. */
export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
  publishedAt?: string
  /** Markdown release body shown in the update popover. */
  releaseNotes?: string
  /**
   * Download URL of the release's installable archive. This plugin ships as a
   * GitHub Release asset rather than an npm package, so the host installs from
   * this URL. Absent when the release carries no archive.
   */
  tarballUrl?: string
  /**
   * How this host can install the update. `host` means the launcher performs the
   * install itself; `host-managed` means only the user can (the CLI refuses that
   * profile); `cli` is the historical `dsh plugin add` path. Absent from hosts
   * that predate the host install hook.
   */
  installMode?: 'cli' | 'host' | 'host-managed'
  /** Profile the update would be installed into, as the host resolved it. */
  profile?: string
}

/** One history image reference as the browser consumes it (a served URL). */
export interface HistoryImageRef {
  /** Same-origin URL: `${HISTORY_API.image}/<file>`. */
  url: string
  /** MIME type, e.g. image/png. */
  mime: string
  /** Upstream revised prompt, when provided. */
  revisedPrompt?: string
}

/** A saved generation as the browser consumes it (metadata + served images). */
export interface HistoryEntry extends EcommerceTaskMeta {
  id: string
  /** Tool name marker for Agent-submitted generations (absent for panel generations). */
  agentTool?: string
  createdAt: number
  mode: StoredEntryMode
  model: string
  prompt: string
  size: string
  quality: string
  detail: string
  n: number
  /** `gif` when this entry is an animated GIF; absent for still images. */
  outputFormat?: 'png' | 'gif'
  /** GIF frame count as requested (absent for still images). */
  frameCount?: number
  /** GIF per-frame delay in milliseconds (absent for still images). */
  frameDurationMs?: number
  images: HistoryImageRef[]
  /** Reference-image filename (edit mode), kept for display only. */
  refName?: string
  /** User-managed gallery labels (unused by history entries). */
  tags?: string[]
  /** Channel id snapshot (usage counters key by it for new entries). */
  channelId?: string
  /** Channel display name snapshot (survives channel deletion). */
  channel?: string
  /** Stable id shared by the history entries in one comparison run. */
  comparisonId?: string
  /** Model aliases included in the comparison run. */
  comparisonModels?: string[]
  canvas?: CanvasTaskMeta
  /**
   * How this still was produced. Absent means an image model returned it;
   * `code` means a chat model wrote drawing code and this host rendered it.
   * Downstream code treats both the same — the bytes land in the same store.
   */
  renderer?: 'model' | 'code'
  /**
   * A favorited clip, recorded by reference to the video store rather than
   * copied: a clip is orders of magnitude larger than an image, and the video
   * route already serves it with Range support. An entry with `video` may have
   * an empty `images` list.
   */
  video?: GalleryVideoRef
  /**
   * When set, the entry sits in the gallery's trash: removal is a soft delete
   * that keeps the files readable for 30 days, and this timestamp is what the
   * restore window and the lazy sweep are measured against. Absent = live, so
   * a manifest written by an older host reads back unchanged.
   */
  deletedAt?: number
}

/** A clip referenced by a gallery entry. */
export interface GalleryVideoRef {
  /** Same-origin video-store URL. */
  url: string
  mime: string
  duration?: number
}

/** A history entry the client submits for persistence (images still carry base64). */
export interface HistoryEntryInput extends EcommerceTaskMeta {
  id: string
  /** Tool name marker for Agent-submitted generations. */
  agentTool?: string
  createdAt: number
  mode: StoredEntryMode
  model: string
  prompt: string
  size: string
  quality: string
  detail: string
  n: number
  /** `gif` when this entry is an animated GIF; absent for still images. */
  outputFormat?: 'png' | 'gif'
  /** GIF frame count as requested (absent for still images). */
  frameCount?: number
  /** GIF per-frame delay in milliseconds (absent for still images). */
  frameDurationMs?: number
  images: GeneratedImage[]
  refName?: string
  /** Channel id snapshot, tallied by the usage endpoint. */
  channelId?: string
  /** Channel display name snapshot (survives channel deletion). */
  channel?: string
  /** Stable id shared by the history entries in one comparison run. */
  comparisonId?: string
  /** Model aliases included in the comparison run. */
  comparisonModels?: string[]
  canvas?: CanvasTaskMeta
  /** Host-filled: `code` when a chat model wrote the drawing code. */
  renderer?: 'model' | 'code'
}
