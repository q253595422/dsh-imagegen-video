/**
 * 导演台时间轴的**纯函数**：时间求值、关键帧增删、轨迹采样。
 *
 * 这一层只做数学，不碰 DOM、不碰 React、不碰 canvas。规则必须能离线测——
 * 「第 2.4 秒这一帧角色在哪、看哪」是这个功能的核心承诺，它不能只在浏览器
 * 里被验证过一次就算数。
 *
 * 单位约定：时间一律是**秒**，角度一律是**度**（与协议里的 `CanvasPoseAngles`
 * 一致），位置是**米**。帧率固定 {@link STAGE_FPS}，帧号只在导出时出现。
 */

import type {
  CanvasPoseAngles,
  CanvasPoseRig,
  CanvasPoseStage,
  CanvasStageKeyframe,
  CanvasStagePath,
  CanvasStageTimeline,
  CanvasStageTrack,
} from '../../protocol.ts'

/** 帧率。与 `CanvasStageTimeline.fps` 同一个值；导出端不应另写一个 30。 */
export const STAGE_FPS = 30
/** 工程时长下限（秒）。 */
export const STAGE_MIN_DURATION = 2
/** 工程时长上限（秒）。 */
export const STAGE_MAX_DURATION = 15
/** 新建时间轴的缺省时长。 */
export const STAGE_DEFAULT_DURATION = 5

/** 一帧的时长（秒）。 */
const FRAME = 1 / STAGE_FPS

/** 新工程：5 秒、30fps、空轨道。 */
export function emptyStageTimeline(): CanvasStageTimeline {
  return { duration: STAGE_DEFAULT_DURATION, fps: STAGE_FPS, tracks: [] }
}

/**
 * 把任意来源的时间轴收敛成合法值。
 *
 * 不抛异常：老文档、手改的 JSON、Agent 写的残缺结构都要能打开。坏的部分
 * 被丢掉（而不是整份作废）——一个少了某条轨道的画布仍然比一张空白图片有用。
 */
export function timelineOf(raw: CanvasStageTimeline | undefined): CanvasStageTimeline {
  if (raw === undefined || raw === null) return emptyStageTimeline()
  const duration = clampDuration(raw.duration)
  const tracks: CanvasStageTrack[] = []
  for (const rawTrack of Array.isArray(raw.tracks) ? raw.tracks : []) {
    const track = trackOfRaw(rawTrack, duration)
    if (track !== undefined) tracks.push(track)
  }
  return { duration, fps: STAGE_FPS, tracks }
}

function clampDuration(value: unknown): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : STAGE_DEFAULT_DURATION
  return Math.min(STAGE_MAX_DURATION, Math.max(STAGE_MIN_DURATION, Math.round(num)))
}

function trackOfRaw(raw: Partial<CanvasStageTrack>, duration: number): CanvasStageTrack | undefined {
  if (raw === undefined || raw === null) return undefined
  const targetId = typeof raw.targetId === 'string' && raw.targetId !== '' ? raw.targetId : undefined
  if (targetId === undefined) return undefined
  const target = raw.target === 'camera' ? 'camera' : 'actor'
  const keyframes: CanvasStageKeyframe[] = []
  for (const frame of Array.isArray(raw.keyframes) ? raw.keyframes : []) {
    if (frame === undefined || frame === null) continue
    if (typeof frame.at !== 'number' || !Number.isFinite(frame.at)) continue
    keyframes.push({ ...frame, at: clampSeconds(frame.at, duration) })
  }
  keyframes.sort((a, b) => a.at - b.at)
  const paths: CanvasStagePath[] = []
  for (const path of Array.isArray(raw.paths) ? raw.paths : []) {
    if (path === undefined || path === null) continue
    if (typeof path.id !== 'string' || path.id === '') continue
    const points = (Array.isArray(path.points) ? path.points : [])
      .filter(point => Array.isArray(point) && point.length === 3 && point.every(n => typeof n === 'number' && Number.isFinite(n)))
      .map(point => [point[0]!, point[1]!, point[2]!] as [number, number, number])
    if (points.length === 0) continue
    const shape = path.shape === 'circle' || path.shape === 'rect' || path.shape === 'line' ? path.shape : 'free'
    paths.push({
      id: path.id,
      shape,
      points,
      start: clampSeconds(typeof path.start === 'number' ? path.start : 0, duration),
      end: clampSeconds(typeof path.end === 'number' ? path.end : duration, duration),
      height: typeof path.height === 'number' && Number.isFinite(path.height) ? path.height : 0,
      orient: path.orient === true,
    })
  }
  return paths.length > 0 ? { targetId, target, keyframes, paths } : { targetId, target, keyframes }
}

function clampSeconds(value: number, duration: number): number {
  return Math.min(duration, Math.max(0, value))
}

/** 对齐到最近的一帧（秒）。写入关键帧与导出取样都先过这一步。 */
export function snapToFrame(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0
  return Math.round(seconds / FRAME) * FRAME
}

/** 夹到 `[0, duration]`。 */
export function clampTime(seconds: number, timeline: CanvasStageTimeline): number {
  if (!Number.isFinite(seconds)) return 0
  return Math.min(timeline.duration, Math.max(0, seconds))
}

/**
 * 时长改了之后，把所有关键帧与轨迹裁进新区间。
 *
 * 不裁的话，把 15 秒缩到 3 秒会留下一堆 `at > duration` 的关键帧：时间轴上
 * 看不见、导出时永远取不到，但 `sampleStage` 在 t=2.9 会拿它做插值，于是
 * 「缩了时长之后最后一个姿势变了」——一个没有可见原因的 bug。
 */
export function retimeTimeline(timeline: CanvasStageTimeline, duration: number): CanvasStageTimeline {
  const next = clampDuration(duration)
  const tracks = timeline.tracks.map(track => {
    const keyframes = track.keyframes.filter(frame => frame.at <= next)
    const paths = (track.paths ?? [])
      .filter(path => path.start < next)
      .map(path => ({ ...path, end: Math.min(path.end, next) }))
    return { ...track, keyframes, paths }
  }).filter(track => track.keyframes.length > 0 || (track.paths ?? []).length > 0)
  return { duration: next, fps: STAGE_FPS, tracks }
}

/** 取某个对象的轨道。 */
export function trackOf(
  timeline: CanvasStageTimeline,
  target: 'actor' | 'camera',
  targetId: string,
): CanvasStageTrack | undefined {
  return timeline.tracks.find(track => track.target === target && track.targetId === targetId)
}

/**
 * 写一个关键帧：同一时刻已有的整条替换，其余按时间保持升序。
 *
 * 返回新对象，不改入参——React 的依赖比较按引用，原地改会让面板不重绘。
 */
export function putKeyframe(
  timeline: CanvasStageTimeline,
  target: 'actor' | 'camera',
  targetId: string,
  keyframe: CanvasStageKeyframe,
): CanvasStageTimeline {
  const at = snapToFrame(clampTime(keyframe.at, timeline))
  const incoming: CanvasStageKeyframe = { ...keyframe, at }
  const existing = trackOf(timeline, target, targetId)
  const merged = (existing?.keyframes ?? []).filter(frame => snapToFrame(frame.at) !== at)
  merged.push(incoming)
  merged.sort((a, b) => a.at - b.at)
  const track: CanvasStageTrack = {
    targetId,
    target,
    keyframes: merged,
    ...(existing?.paths !== undefined ? { paths: existing.paths } : {}),
  }
  return replaceTrack(timeline, track)
}

/** 删掉某一时刻（按帧对齐后）的关键帧。 */
export function removeKeyframe(
  timeline: CanvasStageTimeline,
  target: 'actor' | 'camera',
  targetId: string,
  at: number,
): CanvasStageTimeline {
  const existing = trackOf(timeline, target, targetId)
  if (existing === undefined) return timeline
  const snapped = snapToFrame(at)
  const keyframes = existing.keyframes.filter(frame => snapToFrame(frame.at) !== snapped)
  if (keyframes.length === (existing.paths ?? []).length + keyframes.length && keyframes.length === existing.keyframes.length) return timeline
  if (keyframes.length === 0 && (existing.paths ?? []).length === 0) {
    return { ...timeline, tracks: timeline.tracks.filter(track => track !== existing) }
  }
  return replaceTrack(timeline, { ...existing, keyframes })
}

/** 删掉整个对象的轨道。删角色/机位后必须调，否则会留下指向不存在对象的轨道。 */
export function removeTrack(
  timeline: CanvasStageTimeline,
  target: 'actor' | 'camera',
  targetId: string,
): CanvasStageTimeline {
  return { ...timeline, tracks: timeline.tracks.filter(track => !(track.target === target && track.targetId === targetId)) }
}

/** 追加/替换一条轨迹片段（同 id 覆盖）。 */
export function putPath(
  timeline: CanvasStageTimeline,
  target: 'actor' | 'camera',
  targetId: string,
  path: CanvasStagePath,
): CanvasStageTimeline {
  const start = snapToFrame(clampTime(path.start, timeline))
  const end = snapToFrame(Math.max(start + FRAME, clampTime(path.end, timeline)))
  const existing = trackOf(timeline, target, targetId)
  const paths = (existing?.paths ?? []).filter(item => item.id !== path.id)
  paths.push({ ...path, start, end })
  paths.sort((a, b) => a.start - b.start)
  return replaceTrack(timeline, {
    targetId,
    target,
    keyframes: existing?.keyframes ?? [],
    paths,
  })
}

/** 删掉一条轨迹片段。 */
export function removePath(
  timeline: CanvasStageTimeline,
  target: 'actor' | 'camera',
  targetId: string,
  pathId: string,
): CanvasStageTimeline {
  const existing = trackOf(timeline, target, targetId)
  if (existing === undefined) return timeline
  const paths = (existing.paths ?? []).filter(item => item.id !== pathId)
  if (existing.keyframes.length === 0 && paths.length === 0) {
    return { ...timeline, tracks: timeline.tracks.filter(track => track !== existing) }
  }
  return replaceTrack(timeline, { ...existing, paths })
}

function replaceTrack(timeline: CanvasStageTimeline, track: CanvasStageTrack): CanvasStageTimeline {
  const index = timeline.tracks.findIndex(item => item.target === track.target && item.targetId === track.targetId)
  const tracks = index === -1
    ? [...timeline.tracks, track]
    : timeline.tracks.map((item, at) => (at === index ? track : item))
  return { ...timeline, tracks }
}

/**
 * 在时间 `t` 求值，得到那一刻的舞台。
 *
 * 三条规则，按优先级：
 * 1. 有轨迹片段覆盖 `t` → 位置由路径求值（`orient` 时朝向取切线）。
 * 2. 有位置/姿势/机位关键帧 → 相邻两帧之间插值。
 * 3. 都没有 → 用 stage 里存的静态值。
 *
 * 返回的每个对象都是新的；入参不会被改写（导出路径会反复调用）。
 */
export function sampleStage(stage: CanvasPoseStage, t: number): CanvasPoseStage {
  const timeline = stage.timeline
  if (timeline === undefined) return stage
  const time = clampTime(t, timeline)

  const actors = stage.actors.map(actor => {
    const track = trackOf(timeline, 'actor', actor.id)
    if (track === undefined) return actor
    let next = { ...actor }
    const position = positionAt(track, time, timeline)
    if (position !== undefined) {
      next.x = position[0]
      next.z = position[2]
    }
    const rig = rigAt(track, time)
    if (rig !== undefined) next.rig = rig
    const facing = facingAt(track, time)
    if (facing !== undefined) next.rotation = facing
    return next
  })

  const cameras = stage.cameras.map(camera => {
    const track = trackOf(timeline, 'camera', camera.id)
    if (track === undefined) return camera
    const pose = cameraAt(track, time)
    return pose ?? camera
  })

  return { ...stage, actors, cameras }
}

function positionAt(track: CanvasStageTrack, time: number, timeline: CanvasStageTimeline): [number, number, number] | undefined {
  for (const path of track.paths ?? []) {
    if (time < path.start || time > path.end) continue
    const span = Math.max(FRAME, path.end - path.start)
    const u = Math.min(1, Math.max(0, (time - path.start) / span))
    const point = pathPointAt(path, u)
    return [point[0], point[1] + (path.height ?? 0), point[2]]
  }
  return lerpField(track.keyframes, time, frame => frame.position)
}

function rigAt(track: CanvasStageTrack, time: number): CanvasPoseRig | undefined {
  const frames = track.keyframes.filter(frame => frame.rig !== undefined)
  if (frames.length === 0) return undefined
  if (frames.length === 1) return frames[0]!.rig
  const [a, b, k] = bracket(frames, time)
  if (a === b) return a.rig
  return lerpRig(a.rig!, b.rig!, k)
}

function facingAt(track: CanvasStageTrack, time: number): number | undefined {
  for (const path of track.paths ?? []) {
    if (!path.orient || time < path.start || time > path.end) continue
    const span = Math.max(FRAME, path.end - path.start)
    const u = Math.min(1, Math.max(0, (time - path.start) / span))
    const ahead = pathPointAt(path, Math.min(1, u + 0.001))
    const here = pathPointAt(path, u)
    const dx = ahead[0] - here[0]
    const dz = ahead[2] - here[2]
    if (dx !== 0 || dz !== 0) return (Math.atan2(dx, dz) * 180) / Math.PI
  }
  return lerpField(track.keyframes, time, frame => frame.facing)
}

function cameraAt(track: CanvasStageTrack, time: number): CanvasPoseStage['cameras'][number] | undefined {
  const frames = track.keyframes.filter(frame => frame.camera !== undefined)
  if (frames.length === 0) return undefined
  if (frames.length === 1) return frames[0]!.camera
  const [a, b, k] = bracket(frames, time)
  if (a === b) return a.camera
  const from = a.camera!
  const to = b.camera!
  return {
    id: from.id,
    name: from.name,
    x: mix(from.x, to.x, k),
    y: mix(from.y, to.y, k),
    z: mix(from.z, to.z, k),
    targetX: mix(from.targetX, to.targetX, k),
    targetY: mix(from.targetY, to.targetY, k),
    targetZ: mix(from.targetZ, to.targetZ, k),
    fov: mix(from.fov, to.fov, k),
  }
}

/** 找出包住 `time` 的两帧与插值比例。区间外取最近的一端（不外推）。 */
function bracket(frames: CanvasStageKeyframe[], time: number): [CanvasStageKeyframe, CanvasStageKeyframe, number] {
  if (time <= frames[0]!.at) return [frames[0]!, frames[0]!, 0]
  const last = frames[frames.length - 1]!
  if (time >= last.at) return [last, last, 0]
  for (let index = 0; index < frames.length - 1; index += 1) {
    const a = frames[index]!
    const b = frames[index + 1]!
    if (time >= a.at && time <= b.at) {
      const span = b.at - a.at
      return [a, b, span <= 0 ? 0 : (time - a.at) / span]
    }
  }
  return [last, last, 0]
}

function lerpField<T>(
  frames: CanvasStageKeyframe[],
  time: number,
  pick: (frame: CanvasStageKeyframe) => T | undefined,
): T | undefined {
  const usable = frames.filter(frame => pick(frame) !== undefined)
  if (usable.length === 0) return undefined
  if (usable.length === 1) return pick(usable[0]!)
  const [a, b, k] = bracket(usable, time)
  const from = pick(a)!
  const to = pick(b)!
  if (a === b) return from
  if (Array.isArray(from) && Array.isArray(to)) {
    return from.map((value, index) => mix(value as number, (to as number[])[index] ?? (value as number), k)) as unknown as T
  }
  if (typeof from === 'number' && typeof to === 'number') return mix(from, to, k) as unknown as T
  return k < 0.5 ? from : to
}

function mix(a: number, b: number, k: number): number {
  return a + (b - a) * k
}

/**
 * 逐关节插值两份姿势。
 *
 * 欧拉角直接线性插值，但跨 ±180 时走最短路径：`170° → -170°` 应当是继续
 * 往同方向转 20°，而不是倒回 340°。任一关节缺失时按 0 度参与插值（与
 * `pose-rig.ts` 的「缺项 = 0 度」一致）。
 */
export function lerpRig(a: CanvasPoseRig, b: CanvasPoseRig, k: number): CanvasPoseRig {
  const keys = new Set([...Object.keys(a.joints), ...Object.keys(b.joints)])
  const joints: CanvasPoseRig['joints'] = {}
  for (const key of keys) {
    const from = (a.joints as Record<string, CanvasPoseAngles | undefined>)[key] ?? { x: 0, y: 0, z: 0 }
    const to = (b.joints as Record<string, CanvasPoseAngles | undefined>)[key] ?? { x: 0, y: 0, z: 0 }
    ;(joints as Record<string, CanvasPoseAngles>)[key] = {
      x: lerpAngle(from.x, to.x, k),
      y: lerpAngle(from.y, to.y, k),
      z: lerpAngle(from.z, to.z, k),
    }
  }
  const turn = lerpAngle(a.facing, b.facing, k)
  return { joints, facing: turn }
}

function lerpAngle(from: number, to: number, k: number): number {
  let delta = to - from
  while (delta > 180) delta -= 360
  while (delta < -180) delta += 360
  return from + delta * k
}

/**
 * 路径在 u∈[0,1] 上的点。
 *
 * 四条形状：
 * - `line`：首尾两点线性。
 * - `rect`：前两点当对角，沿四条边走周长。
 * - `circle`：第一个点是圆心，第二个点定半径与起始角；`y` 取圆心的高度。
 * - `free`：折线，按**弧长**推进（不是按顶点序号，否则点密的地方走得慢）。
 *
 * 点不足时返回已有的那个点或原点，不抛异常——用户正在画的过程中，
 * 半条路径是常态。
 */
export function pathPointAt(path: CanvasStagePath, u: number): [number, number, number] {
  const points = path.points
  const first = points[0]
  if (first === undefined) return [0, 0, 0]
  const clamped = Math.min(1, Math.max(0, Number.isFinite(u) ? u : 0))
  if (points.length === 1) return [first[0], first[1], first[2]]

  if (path.shape === 'line') {
    const last = points[points.length - 1]!
    return [mix(first[0], last[0], clamped), mix(first[1], last[1], clamped), mix(first[2], last[2], clamped)]
  }

  if (path.shape === 'circle') {
    const second = points[1]!
    const radius = Math.hypot(second[0] - first[0], second[2] - first[2])
    const startAngle = Math.atan2(second[2] - first[2], second[0] - first[0])
    const angle = startAngle + clamped * Math.PI * 2
    return [first[0] + Math.cos(angle) * radius, first[1], first[2] + Math.sin(angle) * radius]
  }

  if (path.shape === 'rect') {
    const opposite = points[1]!
    const corners: Array<[number, number, number]> = [
      [first[0], first[1], first[2]],
      [opposite[0], first[1], first[2]],
      [opposite[0], first[1], opposite[2]],
      [first[0], first[1], opposite[2]],
      [first[0], first[1], first[2]],
    ]
    return alongPolyline(corners, clamped)
  }

  return alongPolyline(points, clamped)
}

function alongPolyline(points: Array<[number, number, number]>, u: number): [number, number, number] {
  if (points.length === 1) return points[0]!
  const lengths: number[] = []
  let total = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index]!
    const b = points[index + 1]!
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    lengths.push(length)
    total += length
  }
  if (total <= 0) return points[0]!
  let target = total * u
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!
    if (target > length) {
      target -= length
      continue
    }
    const a = points[index]!
    const b = points[index + 1]!
    const k = length <= 0 ? 0 : target / length
    return [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)]
  }
  return points[points.length - 1]!
}

/**
 * 导出用的帧时间表：从 0 到 `duration - 1/fps`，共 `duration * fps` 个时刻。
 *
 * 不含终点那一帧：5 秒 30fps 导出 150 帧，而不是 151——最后一帧若取 t=duration，
 * 它就等于下一段的第一帧，循环播放时会看到重复的一帧。
 */
export function frameTimes(timeline: CanvasStageTimeline): number[] {
  const total = Math.max(1, Math.round(timeline.duration * STAGE_FPS))
  const times: number[] = []
  for (let index = 0; index < total; index += 1) times.push(index / STAGE_FPS)
  return times
}

/** 时长对应多少帧。 */
export function frameCount(timeline: CanvasStageTimeline): number {
  return Math.max(1, Math.round(timeline.duration * STAGE_FPS))
}
