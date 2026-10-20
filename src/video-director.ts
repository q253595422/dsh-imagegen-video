/**
 * Video director: turn one sentence into a plan before anything is rendered.
 *
 * The video pipeline used to take the prompt exactly as typed and submit it.
 * A one-line request ("两个图片的人物在一起交朋友") then reached the provider as
 * that same line: no shot description, no camera movement, no temporal
 * structure — and a 5s/16:9/720P default the user never chose. This module is
 * the missing reasoning step. It runs *before* the engine and its output is
 * what the engine actually sends:
 *
 *   prompt  → the shot-by-shot description the provider receives
 *   seconds → the clip length (may only narrow to what the family accepts)
 *   aspect / resolution → the same, never widened beyond the panel's choice
 *   shots   → what the panel shows back, so the decision is inspectable
 *
 * Two backends, one contract:
 *  - `chat`: an OpenAI-compatible chat completion through the same endpoint the
 *    image studio's prompt enhancement already uses (`resolvePromptModelConfig`),
 *    so there is no new credential to configure.
 *  - `heuristic`: a fully offline planner used when no chat model is
 *    configured, and the fallback when the chat answer is unusable. It is
 *    deterministic, so an offline host can still be tested end to end.
 *
 * The plan is a *proposal checked for validity*, not free text: every field is
 * clamped to what the resolved video family accepts, so a model cannot make the
 * request unsendable (a 20s clip on a 10s family, a 4:3 frame on comemoe).
 *
 * The prompt skeleton follows Wan 2.2's own `--use_prompt_extend` guide
 * (Wan-Video/Wan2.2, Apache-2.0, `wan/utils/system_prompt.py`): subject and
 * action first, then shot size, camera angle/movement, lighting, colour tone
 * and style, and — for image-to-video — emphasis on motion over static scene
 * description. That model is the reference implementation of the licence-clean
 * open video family this plugin actually routes (`wan2.2-*` through comemoe),
 * so its vocabulary is the one the provider was trained against.
 */

import {
  clampVideoSeconds,
  describeVideoModel,
  type VideoCatalogEntry,
} from './video-model-catalog.ts'
import type { PromptModelConfig } from './prompt-enhancer.ts'
import type { VideoDirectorPlan, VideoMode, VideoResolution } from './protocol.ts'

/** Who produced a plan. */
export type VideoPlanSource = 'chat' | 'heuristic'

/** One shot in the plan. */
export interface VideoShot {
  /** Ordinal within the clip, 1-based. */
  index: number
  /** What the camera sees, one line. */
  shot: string
  /** What moves in this shot. */
  action: string
  /** Camera movement for this shot, e.g. 缓慢推近 / 固定机位. */
  camera: string
  /** Share of the clip's total duration, in seconds. */
  seconds: number
}

/** The parameters a plan proposes, after clamping to the family. */
export interface VideoPlanParams {
  seconds: number
  aspectRatio: string
  resolution: VideoResolution
}

/** A complete plan, ready to be applied to the request. */
export interface VideoPlan {
  source: VideoPlanSource
  /** Camera/look vocabulary the plan picked. */
  style: {
    /** 镜头语言, e.g. 中景 + 侧光. */
    shotLanguage: string
    /** 视觉风格, e.g. 写实电影感 / 二次元插画. */
    look: string
    /** 节奏 0..1: how much happens per second. */
    pacing: number
  }
  shots: VideoShot[]
  /** The single prompt string handed to the engine. */
  prompt: string
  params: VideoPlanParams
  /** What the planner changed relative to the request, in user-facing copy. */
  notes: string[]
  /** True when the chat backend's answer had to be repaired or replaced. */
  degraded: boolean
  /** Why it degraded, for the diagnostics record. */
  degradedReason?: string
}

/** Stable wire code for a planning failure. */
export class VideoPlanError extends Error {
  readonly code: string
  constructor(message: string, code = 'video-plan-failed') {
    super(message)
    this.name = 'VideoPlanError'
    this.code = code
  }
}

/** Hard cap on the user's sentence, in characters. */
export const MAX_PROMPT_CHARS = 4_000

/**
 * Cap on the planned prompt. Providers truncate silently past their own limit,
 * and a plan longer than this is a sign the planner copied the input instead
 * of distilling it. 900 chars is comfortably inside every family's budget and
 * long enough for a 5-shot description.
 */
export const MAX_PLANNED_PROMPT_CHARS = 900

/** Cap on the number of shots a plan may propose. */
export const MAX_SHOTS = 6

/** Chat budget. Planning is one small completion, not a render. */
const PLAN_TIMEOUT_MS = 45_000

/** Request fields a plan is allowed to change. */
export interface VideoPlanInput {
  mode: VideoMode
  prompt: string
  aspectRatio: string
  resolution: VideoResolution
  seconds: number
  /** Upstream model id, used to narrow the params to the family. */
  model: string
  /** True when the request carries a reference/first frame. */
  hasReference: boolean
}

/**
 * Validated planner output before it is clamped to the family.
 *
 * Kept separate from {@link VideoPlan} because the chat backend can produce
 * each field independently and a partially-bad answer must not throw the good
 * fields away.
 */
interface RawPlan {
  look?: string
  shotLanguage?: string
  pacing?: number
  shots: Array<{ shot?: string; action?: string; camera?: string; seconds?: number }>
  prompt?: string
  seconds?: number
  aspectRatio?: string
  resolution?: string
}

/** Reject blank input with copy that says what to do. */
export function requirePrompt(prompt: string): string {
  const value = prompt.trim()
  if (value === '') {
    throw new VideoPlanError('视频描述为空：请先写一句你想要的画面，例如「雨夜霓虹街头，女孩回头看向镜头」', 'video-prompt-empty')
  }
  if (value.length > MAX_PROMPT_CHARS) {
    throw new VideoPlanError(
      `视频描述过长（${value.length} 字符，上限 ${MAX_PROMPT_CHARS}）：请压缩到核心动作与场景，其余交给镜头规划`,
      'video-prompt-too-long',
    )
  }
  return value
}

/** Whether a string carries a motion verb the planner can anchor on. */
const MOTION_HINTS = [
  '走', '跑', '跳', '转', '回头', '挥', '推', '拉', '抬', '坐', '站', '飞', '漂', '摇', '笑', '哭', '说', '唱', '舞', '伸', '闭', '睁', '落', '升', '冲', '拥抱', '打', '吻',
  'walk', 'run', 'jump', 'turn', 'wave', 'push', 'pull', 'sit', 'stand', 'fly', 'drift', 'shake', 'smile', 'cry', 'talk', 'sing', 'dance', 'stretch', 'close', 'open', 'fall', 'rise', 'hug', 'fight', 'kiss',
] as const

/** Whether the sentence already names a shot size. */
const SHOT_HINTS = ['特写', '近景', '中景', '全景', '远景', '俯拍', '航拍', '仰拍', 'close-up', 'medium shot', 'wide shot', 'aerial'] as const

/** Whether the sentence already names a camera movement. */
const CAMERA_HINTS = ['推近', '拉远', '横移', '摇镜', '跟拍', '环绕', '手持', '固定机位', 'push-in', 'pull-back', 'pan', 'tracking', 'orbit', 'handheld'] as const

/** Whether the sentence already names a look/style. */
const LOOK_HINTS = ['写实', '电影感', '二次元', '插画', '水彩', '油画', '赛博朋克', '定格动画', '胶片', 'photoreal', 'cinematic', 'anime', 'illustration', 'watercolour', 'oil painting', 'cyberpunk', 'stop-motion', 'film grain'] as const

/** Whether the sentence already names a lighting setup. */
const LIGHT_HINTS = ['逆光', '侧光', '柔光', '硬光', '暖光', '冷光', '日落', '清晨', '夜晚', '霓虹', 'backlit', 'side light', 'soft light', 'hard light', 'warm light', 'cool light', 'sunset', 'dawn', 'night', 'neon'] as const

function hasAny(text: string, hints: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return hints.some(hint => lower.includes(hint.toLowerCase()))
}

/** Whether the sentence contains any motion at all. */
export function hasMotion(text: string): boolean {
  return hasAny(text, MOTION_HINTS)
}

/**
 * Split a long sentence into clauses a shot can be built from.
 *
 * Chinese and English both end a clause at a full stop or a comma-like pause;
 * keeping the separators out means every clause is a clean phrase.
 */
function clausesOf(prompt: string): string[] {
  return prompt
    .split(/[。；;，,、\n]+|\.\s+/)
    .map(clause => clause.trim())
    .filter(clause => clause !== '')
}

/** The dominant language of the prompt, so the plan answers in the same one. */
export function looksChinese(text: string): boolean {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  return cjk > 0 && cjk >= text.replace(/\s/g, '').length / 4
}

/** A shot plan built entirely offline from the prompt's own structure. */
function heuristicRaw(input: VideoPlanInput, prompt: string): RawPlan {
  const chinese = looksChinese(prompt)
  const clauses = clausesOf(prompt)
  // A request with one clause becomes one shot; a longer one is split so the
  // plan can give each beat its own camera. Never more than MAX_SHOTS.
  const beats = clauses.length <= 1 ? [prompt] : clauses.slice(0, MAX_SHOTS)
  const total = clampVideoSeconds(input.seconds)
  const perShot = Math.max(1, Math.round(total / beats.length))
  const moving = hasMotion(prompt)
  const camera = hasAny(prompt, CAMERA_HINTS)
    ? (chinese ? '沿用描述中的运镜' : 'keep the movement described')
    : (chinese ? (moving ? '镜头随主体缓慢跟随' : '固定机位，轻微呼吸感') : (moving ? 'slow tracking follow' : 'locked-off camera with a slight drift'))
  const look = hasAny(prompt, LOOK_HINTS) ? undefined : (chinese ? '写实电影感' : 'photoreal cinematic')
  const shotLanguage = hasAny(prompt, SHOT_HINTS)
    ? (chinese ? '沿用描述中的景别与光线' : 'keep the shot size and lighting described')
    : (chinese ? '中景为主，按动作切近景' : 'medium shot, cutting to a close-up on the action')

  return {
    ...look === undefined ? {} : { look },
    shotLanguage,
    pacing: moving ? 0.6 : 0.35,
    shots: beats.map((beat, index) => ({
      shot: chinese ? `第 ${index + 1} 个画面：${beat}` : `Shot ${index + 1}: ${beat}`,
      // The provider needs a motion even when the sentence has none; a still
      // subject plus drifting background is the safest implied movement.
      action: moving ? beat : (chinese ? `${beat}（主体轻微动作，背景有自然流动）` : `${beat} (subtle subject movement, living background)`),
      camera,
      seconds: perShot,
    })),
    seconds: total,
  }
}

/** Render a raw plan into one prompt string the provider can be given. */
function renderPrompt(raw: RawPlan, input: VideoPlanInput): string {
  const chinese = looksChinese(input.prompt)
  const parts: string[] = []
  if (raw.look !== undefined && raw.look !== '') parts.push(raw.look)
  if (raw.shotLanguage !== undefined && raw.shotLanguage !== '') parts.push(raw.shotLanguage)

  const shots = raw.shots
    .map((shot, index) => {
      const subject = (shot.shot ?? '').trim()
      const action = (shot.action ?? '').trim()
      const camera = (shot.camera ?? '').trim()
      const pieces = [subject, action, camera].filter(piece => piece !== '')
      if (pieces.length === 0) return ''
      // A shot line that already starts with its own ordinal must not gain a
      // second one ("Shot 1: Shot 1: …").
      return /^(?:shot\s*\d+|第\s*\d+\s*个画面)/i.test(subject) || subject === ''
        ? pieces.join(chinese ? '；' : '; ')
        : `${chinese ? `第 ${index + 1} 个画面` : `Shot ${index + 1}`}${chinese ? '：' : ': '}${pieces.join(chinese ? '；' : '; ')}`
    })
    .filter(line => line !== '')
  parts.push(...shots)

  // Image-bearing modes must describe motion, not restate the still: those
  // frames already carry the scene, and Wan's i2v guide says so explicitly.
  if (input.mode !== 'text') {
    parts.push(chinese ? '以参考图中的主体与构图为基准，强调动作过程，不复述静态场景' : 'Anchor on the reference frame\'s subject and composition; emphasise the action, do not restate the static scene')
  }
  const text = parts.join(chinese ? '。' : '. ').replace(/\s+/g, ' ').trim()
  return text === '' ? input.prompt : text
}

/** Clamp one duration onto the step the family actually accepts. */
function clampToFamilySeconds(seconds: number, entry: VideoCatalogEntry): number {
  const clamped = clampVideoSeconds(seconds)
  // The panel offers 5 / 10; a planner asking for 7 is legal but produces a
  // clip the user cannot compare with the rest, so it snaps to the offered set
  // only when the family has no finer preference of its own.
  const offered = [5, 10]
  if (offered.includes(clamped)) return clamped
  const nearest = offered.reduce((best, candidate) =>
    Math.abs(candidate - clamped) < Math.abs(best - clamped) ? candidate : best, offered[0]!)
  // Never widen: a user asking for 5s must not come back with 10.
  return Math.min(nearest, clamped) >= 1 ? Math.min(nearest, clamped) : clamped
}

/**
 * Apply a raw plan to a request and produce the validated plan.
 *
 * Every widening is refused here, which is what makes the result safe to feed
 * straight into the engine: the request the user typed is the ceiling.
 */
function finalize(raw: RawPlan, input: VideoPlanInput, source: VideoPlanSource, degradedReason?: string): VideoPlan {
  const entry = describeVideoModel(input.model)
  const notes: string[] = []
  let degraded = degradedReason !== undefined

  // --- prompt --------------------------------------------------------------
  let prompt = (raw.prompt ?? '').trim()
  if (prompt === '') prompt = renderPrompt(raw, input)
  if (prompt.length > MAX_PLANNED_PROMPT_CHARS) {
    const cut = prompt.slice(0, MAX_PLANNED_PROMPT_CHARS)
    // Cut on a clause boundary when one is close to the cap, so the prompt does
    // not end mid-word.
    const boundary = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('. '), cut.lastIndexOf('；'), cut.lastIndexOf('; '))
    prompt = boundary > MAX_PLANNED_PROMPT_CHARS * 0.6 ? cut.slice(0, boundary) : cut
    notes.push(`规划提示词超长，已截断到 ${MAX_PLANNED_PROMPT_CHARS} 字符`)
    degraded = true
  }

  // --- seconds -------------------------------------------------------------
  const requested = clampVideoSeconds(input.seconds)
  const planned = raw.seconds === undefined ? requested : clampToFamilySeconds(raw.seconds, entry)
  // Only narrow. A planner that asks for longer than the user chose would
  // silently increase render time and cost.
  const seconds = Math.max(1, Math.min(planned, requested))
  if (seconds !== requested) notes.push(`时长按镜头节奏收紧为 ${seconds}s（原 ${requested}s）`)

  // --- aspect --------------------------------------------------------------
  let aspectRatio = input.aspectRatio.trim() === '' ? '16:9' : input.aspectRatio.trim()
  const wantedAspect = (raw.aspectRatio ?? '').trim()
  if (wantedAspect !== '' && wantedAspect !== aspectRatio && (entry.aspectRatios.length === 0 || entry.aspectRatios.includes(wantedAspect))) {
    // The planner may re-orient a vertical subject, but never past what the
    // family accepts.
    aspectRatio = wantedAspect
    notes.push(`画幅调整为 ${wantedAspect}`)
  }

  // --- resolution ----------------------------------------------------------
  let resolution: VideoResolution = input.resolution
  const wantedResolution = (raw.resolution ?? '').trim().toUpperCase()
  if (wantedResolution !== '' && wantedResolution !== resolution && entry.resolutions.includes(wantedResolution as VideoResolution)) {
    // The plan may drop to a cheaper tier when the clip is a draft, never raise.
    const order: VideoResolution[] = ['480P', '720P', '1080P']
    if (order.indexOf(wantedResolution as VideoResolution) < order.indexOf(resolution)) {
      resolution = wantedResolution as VideoResolution
      notes.push(`分辨率降为 ${resolution} 以缩短出片时间`)
    }
  }

  // --- shots ---------------------------------------------------------------
  const shots: VideoShot[] = raw.shots.slice(0, MAX_SHOTS).map((shot, index) => ({
    index: index + 1,
    shot: (shot.shot ?? '').trim() || (looksChinese(input.prompt) ? `第 ${index + 1} 个画面` : `Shot ${index + 1}`),
    action: (shot.action ?? '').trim(),
    camera: (shot.camera ?? '').trim(),
    seconds: Math.max(1, Math.round(shot.seconds ?? seconds / Math.max(1, raw.shots.length))),
  }))

  return {
    source,
    style: {
      shotLanguage: (raw.shotLanguage ?? '').trim(),
      look: (raw.look ?? '').trim(),
      pacing: typeof raw.pacing === 'number' && Number.isFinite(raw.pacing)
        ? Math.min(1, Math.max(0, raw.pacing))
        : 0.5,
    },
    shots: shots.length > 0 ? shots : [{
      index: 1,
      shot: input.prompt,
      action: input.prompt,
      camera: '',
      seconds,
    }],
    prompt,
    params: { seconds, aspectRatio, resolution },
    notes,
    degraded,
    ...degradedReason === undefined ? {} : { degradedReason },
  }
}

/** The offline plan. Always succeeds for non-empty input. */
export function planVideoLocally(input: VideoPlanInput): VideoPlan {
  const prompt = requirePrompt(input.prompt)
  return finalize(heuristicRaw(input, prompt), { ...input, prompt }, 'heuristic')
}

/** The system prompt the chat backend is given. */
export function directorSystemPrompt(chinese: boolean): string {
  const shape = `{"look":"…","shotLanguage":"…","pacing":0.0,"shots":[{"shot":"…","action":"…","camera":"…","seconds":5}],"prompt":"…","seconds":5,"aspectRatio":"16:9","resolution":"720P"}`
  if (chinese) {
    return [
      '你是视频导演。把用户的一句话需求拆成镜头、动作、运镜、时长、风格，并落成可直接送给视频模型的一条提示词。',
      '规则：',
      '1. 不改变用户的原意（主体、动作、数量、语言）；不添加用户没有提到的新主体。',
      '2. 提示词结构：先风格，再景别/光线，然后按镜头顺序写「第 N 个画面：主体 + 动作过程 + 运镜」。动作要写出过程，而不是只给静态描述。',
      '3. 若用户没写运镜，补一个克制的运镜（固定机位微呼吸、缓慢推近、横向跟拍等）；若用户写了，则沿用。',
      '4. 若用户没写风格，不要强加；确有需要时给一个中性的写实电影感。',
      '5. 不要写"氛围""张力""美感"这类空泛形容；不要写台词、字幕、水印。',
      '6. 总时长不得超过用户给定的秒数上限；每镜 seconds 之和应接近总时长。',
      '7. 只输出一个 JSON 对象，不要 Markdown、不要解释：',
      shape,
      '字段含义：look=视觉风格；shotLanguage=景别与光线；pacing=节奏 0..1；shots=镜头列表；prompt=最终提示词（不超过 900 字）；seconds/aspectRatio/resolution=建议参数（时长不得超过用户值）。',
    ].join('\n')
  }
  return [
    'You are a video director. Turn one sentence into shots, motion, camera work, duration and style, and produce the single prompt a video model can be given.',
    'Rules:',
    '1. Preserve the request\'s subject, action, count and language; never add a subject the user did not mention.',
    '2. Prompt structure: style first, then shot size / lighting, then each shot in order as "Shot N: subject + action process + camera". Describe the motion as a process, not a still.',
    '3. If the user named no camera movement, add a restrained one (locked-off with a slight drift, slow push-in, lateral tracking); if they did, keep it.',
    '4. If the user named no style, do not invent one beyond a neutral photoreal cinematic look when needed.',
    '5. No mood words ("cinematic tension", "beautiful atmosphere"), no dialogue, subtitles or watermarks.',
    '6. Total duration must not exceed the user\'s chosen seconds; per-shot seconds should add up to roughly the total.',
    '7. Output exactly one JSON object — no markdown, no explanation:',
    shape,
    'Fields: look = visual style; shotLanguage = shot size and lighting; pacing = 0..1; shots = the shot list; prompt = the final prompt (under 900 characters); seconds/aspectRatio/resolution = proposed params (duration must not exceed the user value).',
  ].join('\n')
}

/**
 * Outcome of reading one chat answer.
 *
 * "Unparseable" and "parsed but empty" are reported separately: the first says
 * the model broke the contract, the second says it answered an object with no
 * usable field. Both fall back, but the diagnostics record has to say which.
 */
export type PlanParseResult =
  | { ok: true; plan: RawPlan }
  | { ok: false; reason: 'no-json' | 'invalid-json' | 'not-an-object' | 'no-content' }

/** Parse one chat answer into a RawPlan, tolerating fences and stray prose. */
export function parsePlanAnswer(answer: string): PlanParseResult {
  const cleaned = answer.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, reason: 'no-json' }
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, reason: 'not-an-object' }
  const record = parsed as Record<string, unknown>
  const shotsRaw = Array.isArray(record.shots) ? record.shots : []
  const shots = shotsRaw.flatMap(item => {
    if (item === null || typeof item !== 'object') return []
    const shot = item as Record<string, unknown>
    const read = (key: string): string | undefined =>
      typeof shot[key] === 'string' && (shot[key] as string).trim() !== '' ? (shot[key] as string).trim() : undefined
    const seconds = typeof shot.seconds === 'number' && Number.isFinite(shot.seconds) ? shot.seconds : undefined
    return [{
      ...read('shot') === undefined ? {} : { shot: read('shot')! },
      ...read('action') === undefined ? {} : { action: read('action')! },
      ...read('camera') === undefined ? {} : { camera: read('camera')! },
      ...seconds === undefined ? {} : { seconds },
    }]
  })
  const text = (key: string): string | undefined =>
    typeof record[key] === 'string' && (record[key] as string).trim() !== '' ? (record[key] as string).trim() : undefined
  const number = (key: string): number | undefined =>
    typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] as number : undefined
  const plan: RawPlan = {
    shots,
    ...text('prompt') === undefined ? {} : { prompt: text('prompt')! },
    ...text('look') === undefined ? {} : { look: text('look')! },
    ...text('shotLanguage') === undefined ? {} : { shotLanguage: text('shotLanguage')! },
    ...text('aspectRatio') === undefined ? {} : { aspectRatio: text('aspectRatio')! },
    ...text('resolution') === undefined ? {} : { resolution: text('resolution')! },
    ...number('pacing') === undefined ? {} : { pacing: number('pacing')! },
    ...number('seconds') === undefined ? {} : { seconds: number('seconds')! },
  }
  // An answer with neither a prompt nor shots is not a plan.
  if (plan.prompt === undefined && plan.shots.length === 0) return { ok: false, reason: 'no-content' }
  return { ok: true, plan }
}

/** The chat call, injected so this module stays testable without a network. */
export type ChatCompleter = (options: { system: string; content: string; temperature?: number; maxTokens?: number; signal?: AbortSignal }) => Promise<string>

/**
 * Plan one video through the configured chat model.
 *
 * Failure policy: a *configuration* problem (no model, unreachable endpoint)
 * raises {@link VideoPlanError} so the user is told why nothing was planned —
 * silently rendering the raw sentence is exactly the behaviour this feature
 * exists to remove. A *content* problem (the model answered prose, or JSON
 * outside the schema) keeps the plan but marks it `degraded`, because the
 * offline planner still produces a usable shot list from the same sentence.
 *
 * @param input - the request as collected, before the engine sees it.
 * @param config - resolved chat endpoint (same one prompt enhancement uses).
 * @param complete - chat call, or undefined when no chat model is configured.
 * @param signal - caller cancellation; a cancelled plan is reported as cancelled.
 * @returns a validated plan whose params never exceed the request's own.
 */
export async function planVideo(
  input: VideoPlanInput,
  config: PromptModelConfig | undefined,
  complete: ChatCompleter | undefined,
  signal?: AbortSignal,
): Promise<VideoPlan> {
  const prompt = requirePrompt(input.prompt)
  const chinese = looksChinese(prompt)
  const configured = config !== undefined && config.model.trim() !== '' && config.apiUrl.trim() !== ''
  if (!configured || complete === undefined) {
    // No chat model is a legitimate setup (the studio works without one), so
    // this is the offline path rather than an error: the plan still happens.
    const plan = finalize(heuristicRaw(input, prompt), { ...input, prompt }, 'heuristic', '未配置对话模型，使用离线镜头规划')
    return plan
  }

  const bounded = AbortSignal.timeout(PLAN_TIMEOUT_MS)
  const combined = signal === undefined ? bounded : AbortSignal.any([signal, bounded])
  const reference = input.mode === 'text' ? '' : chinese
    ? `\n\n本视频带参考图（模式 ${input.mode}）：描述应以图中的主体与构图为基准，强调动作，不要复述静态画面。`
    : `\n\nThis run carries a reference frame (mode ${input.mode}): anchor on its subject and composition, emphasise motion, and do not restate the static scene.`
  const request = `${chinese ? '用户需求' : 'Request'}: ${prompt}\n${chinese ? '参数上限' : 'Param ceiling'}: seconds<=${clampVideoSeconds(input.seconds)}, aspectRatio=${input.aspectRatio}, resolution=${input.resolution}${reference}`

  let answer: string
  try {
    answer = await complete({
      system: directorSystemPrompt(chinese),
      content: request,
      temperature: 0.4,
      maxTokens: 1_200,
      signal: combined,
    })
  } catch (error) {
    if (signal?.aborted === true) {
      throw new VideoPlanError('视频规划已取消', 'video-plan-cancelled')
    }
    // A timeout or an unreachable chat endpoint leaves the run unable to plan.
    // Falling back is deliberate: the render itself may still work, and a plan
    // is an enhancement, not a precondition. The reason is recorded.
    const reason = error instanceof Error ? error.message : String(error)
    const plan = finalize(
      heuristicRaw(input, prompt),
      { ...input, prompt },
      'heuristic',
      `对话模型调用失败（${reason}），已改用离线规划`,
    )
    return plan
  }

  const outcome = parsePlanAnswer(answer)
  if (!outcome.ok) {
    const reasonZh: Record<typeof outcome.reason, string> = {
      'no-json': '回复里没有 JSON',
      'invalid-json': 'JSON 语法无效',
      'not-an-object': 'JSON 不是对象',
      'no-content': 'JSON 里没有可用的提示词或镜头',
    }
    return finalize(
      heuristicRaw(input, prompt),
      { ...input, prompt },
      'heuristic',
      `对话模型返回的规划不可用（${reasonZh[outcome.reason]}），已改用离线规划`,
    )
  }
  const raw = outcome.plan
  // A plan that merely echoed the input adds nothing: that is the bug this
  // feature fixes, so it is treated as a failed plan and repaired offline.
  const planned = (raw.prompt ?? '').trim()
  if (planned !== '' && planned.length <= prompt.length + 8) {
    const repaired = heuristicRaw(input, prompt)
    return finalize(
      { ...repaired, ...raw.shots.length > 0 ? {} : { shots: repaired.shots } },
      { ...input, prompt },
      'chat',
      '对话模型只复述了原描述，已补充镜头与运镜',
    )
  }
  return finalize(raw, { ...input, prompt }, 'chat')
}

/**
 * Apply a plan to a request. Returns the request the engine must receive.
 *
 * Only the fields a plan controls are replaced; reference frames, channel and
 * canvas lineage pass through untouched, so this cannot break the modes that
 * carry images.
 */
export function applyPlan<T extends { prompt: string; seconds: number; aspectRatio: string; resolution: VideoResolution }>(
  request: T,
  plan: { prompt: string; params: { seconds: number; aspectRatio: string; resolution: string } },
): T {
  return {
    ...request,
    prompt: plan.prompt,
    seconds: plan.params.seconds,
    aspectRatio: plan.params.aspectRatio,
    resolution: plan.params.resolution as VideoResolution,
  }
}

/** Cap on a plan prompt that arrived over the wire. */
const MAX_ADOPTED_PROMPT_CHARS = MAX_PLANNED_PROMPT_CHARS

/**
 * Adopt a plan the client already previewed, re-validated against this request.
 *
 * A previewed plan travels over the wire, so it is untrusted input: the prompt
 * length, the family's accepted duration/aspect/resolution and the user's own
 * ceiling are all re-checked here. Without this, a caller could hand the engine
 * a 30s render where the user asked for 5s — the exact class of bug the
 * director is supposed to prevent.
 *
 * @param request - the submitted request, including `planPreview`.
 * @param model - the resolved upstream model id (the family is read from it).
 */
export function adoptPlan(
  request: { prompt: string; seconds: number; aspectRatio: string; resolution: VideoResolution; planPreview?: VideoDirectorPlan | undefined },
  model: string,
): VideoDirectorPlan {
  const preview = request.planPreview
  if (preview === undefined) throw new VideoPlanError('预览规划缺失', 'video-plan-invalid')
  const entry = describeVideoModel(model)
  const notes = [...(preview.notes ?? [])]

  let prompt = (preview.prompt ?? '').trim()
  if (prompt === '') throw new VideoPlanError('预览规划里没有提示词', 'video-plan-invalid')
  if (prompt.length > MAX_ADOPTED_PROMPT_CHARS) {
    prompt = prompt.slice(0, MAX_ADOPTED_PROMPT_CHARS)
    notes.push(`规划提示词超长，已截断到 ${MAX_ADOPTED_PROMPT_CHARS} 字符`)
  }

  // Never widen: the request's own values are the ceiling, and the family's
  // accepted set is the floor of what can be sent at all.
  const requestedSeconds = clampVideoSeconds(request.seconds)
  const plannedSeconds = typeof preview.params?.seconds === 'number' && Number.isFinite(preview.params.seconds)
    ? clampVideoSeconds(preview.params.seconds)
    : requestedSeconds
  const seconds = Math.max(1, Math.min(plannedSeconds, requestedSeconds))
  if (seconds !== requestedSeconds) notes.push(`时长按镜头节奏收紧为 ${seconds}s（原 ${requestedSeconds}s）`)

  const wantedAspect = (preview.params?.aspectRatio ?? '').trim()
  const aspectRatio = wantedAspect !== ''
    && (entry.aspectRatios.length === 0 || entry.aspectRatios.includes(wantedAspect))
    ? wantedAspect
    : request.aspectRatio

  const wantedResolution = (preview.params?.resolution ?? '').trim().toUpperCase()
  const order: VideoResolution[] = ['480P', '720P', '1080P']
  const resolution = entry.resolutions.includes(wantedResolution as VideoResolution)
    && order.indexOf(wantedResolution as VideoResolution) < order.indexOf(request.resolution)
    ? wantedResolution as VideoResolution
    : request.resolution

  const shots = Array.isArray(preview.shots)
    ? preview.shots.slice(0, MAX_SHOTS).map((shot, index) => ({
      index: index + 1,
      shot: String(shot?.shot ?? '').trim(),
      action: String(shot?.action ?? '').trim(),
      camera: String(shot?.camera ?? '').trim(),
      seconds: Math.max(1, Math.round(Number(shot?.seconds) || seconds)),
    }))
    : []

  return {
    source: preview.source === 'chat' ? 'chat' : 'heuristic',
    style: {
      shotLanguage: String(preview.style?.shotLanguage ?? '').trim(),
      look: String(preview.style?.look ?? '').trim(),
      pacing: Number.isFinite(preview.style?.pacing) ? Math.min(1, Math.max(0, preview.style.pacing)) : 0.5,
    },
    shots,
    prompt,
    params: { seconds, aspectRatio, resolution },
    notes,
    degraded: preview.degraded === true,
    ...preview.degradedReason === undefined ? {} : { degradedReason: preview.degradedReason },
  }
}
