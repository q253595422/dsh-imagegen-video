/**
 * Prompt construction for the "爆款图复刻" (recreate-a-hit-image) workspace.
 *
 * WHY this file exists separately from `ReplicaWorkspace.tsx`: the claim this
 * feature makes is "参考风格 and 高度复刻 produce structurally different
 * prompts", and that claim is only checkable if the two builders are pure
 * functions with no React, no DOM layout and no `tt()` on the inside. The
 * acceptance script imports them directly and diffs the two outputs.
 *
 * WHAT "高度复刻" ACTUALLY IS, stated plainly so nobody has to read the code to
 * find out: it MEASURES the reference image (aspect, palette shares, mean
 * luma, contrast, where the visual mass sits, which band of the frame is
 * low-detail) and writes those measurements into a LABELED, sectioned prompt.
 * It is not a pixel-level reconstruction, and no prompt can be: the model
 * decides what to draw. What it does buy over "参考风格" is that the parts
 * which ARE controllable through text — frame ratio, subject placement, where
 * the quiet band is, the palette relationship — stop being adjectives and
 * become numbers taken from the user's own reference.
 *
 * When the measurement fails (canvas unavailable, unreadable file), the
 * replica prompt says so in the prompt itself rather than inventing plausible
 * numbers. A model told "留白带位于上 1/4" that was never measured would be
 * obeying a lie.
 */

/** 复刻类型 — the six options the task fixes. */
export const REPLICA_KINDS = ['ecommerce', 'apparel', 'poster', 'social', 'creative', 'other'] as const
export type ReplicaKind = typeof REPLICA_KINDS[number]

/** 复刻程度 — the two tiers. These are NOT interchangeable adjectives. */
export const REPLICA_FIDELITIES = ['style', 'replica'] as const
export type ReplicaFidelity = typeof REPLICA_FIDELITIES[number]

/** One measured fact set about a reference image. */
export interface ReferenceFacts {
  /** Frame ratio as a label ('3:4') plus its numeric value (0.75). */
  aspect: string
  aspectValue: number
  /** Top palette entries by share, most common first. */
  palette: { hex: string; share: number }[]
  /** Mean relative luma, 0-1. */
  brightness: number
  /** Luma p90 − p10, 0-1. */
  contrast: number
  /** Mean saturation, 0-1. */
  saturation: number
  /** Visual-mass centroid as fractions of width/height (0-1). */
  subject: { x: number; y: number; spread: number }
  /**
   * The largest contiguous low-detail band, as fractions of the frame. This is
   * where text/logo space already exists in the reference, so the replica
   * prompt can keep that space instead of letting the model fill it.
   */
  quiet: { start: number; end: number; axis: 'rows' | 'columns'; edge: 'top' | 'bottom' | 'left' | 'right' | 'middle' } | null
}

/** Everything the user filled in. */
export interface ReplicaDraft {
  kind: ReplicaKind
  fidelity: ReplicaFidelity
  /** What the product is, in the user's words. Never invented by us. */
  product: string
  /** The user's extra constraints, verbatim. */
  extra: string
}

/** A ratio label for a width/height pair, snapped to the panel's own vocabulary. */
function ratioLabel(width: number, height: number): { label: string; value: number } {
  const value = width > 0 && height > 0 ? width / height : 1
  const named: [string, number][] = [
    ['1:1', 1], ['3:4', 3 / 4], ['4:3', 4 / 3], ['9:16', 9 / 16],
    ['2:3', 2 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9],
  ]
  let best = named[0]!
  for (const entry of named) if (Math.abs(entry[1] - value) < Math.abs(best[1] - value)) best = entry
  // Within 6% of a named ratio it IS that ratio for any practical purpose;
  // outside it, report the measured value rather than mislabeling the frame.
  if (Math.abs(best[1] - value) / best[1] <= 0.06) return { label: best[0], value }
  return { label: `${value.toFixed(2)}:1`, value }
}

function hex(r: number, g: number, b: number): string {
  const part = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/** Luma in the 0-1 range, Rec. 601 weights (what "brightness" means to a human). */
function luma(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

/**
 * Measure one reference image.
 *
 * Sampling is deliberately coarse (64 px on the long side). These numbers end
 * up as prose in a prompt, so a 4K analysis would add seconds of decode time
 * per thumbnail without changing a single digit that reaches the model.
 *
 * @param url - a data URL (or any same-origin URL) the browser can decode.
 */
export async function measureReference(url: string): Promise<ReferenceFacts> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error('reference image could not be decoded'))
    element.src = url
  })
  const naturalWidth = image.naturalWidth || 1
  const naturalHeight = image.naturalHeight || 1
  const scale = Math.min(1, 64 / Math.max(naturalWidth, naturalHeight))
  const width = Math.max(4, Math.round(naturalWidth * scale))
  const height = Math.max(4, Math.round(naturalHeight * scale))

  const canvas = globalThis.document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('canvas 2d is unavailable')
  context.drawImage(image, 0, 0, width, height)
  const { data } = context.getImageData(0, 0, width, height)

  const count = width * height
  const lumas = new Float64Array(count)
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>()
  let saturationSum = 0
  for (let index = 0; index < count; index += 1) {
    const r = data[index * 4] ?? 0
    const g = data[index * 4 + 1] ?? 0
    const b = data[index * 4 + 2] ?? 0
    lumas[index] = luma(r, g, b)
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    saturationSum += max === 0 ? 0 : (max - min) / max
    // 4 bits per channel: 4096 buckets, enough to keep two near-identical
    // brand colours apart while still merging JPEG noise into one entry.
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 }
    bucket.r += r
    bucket.g += g
    bucket.b += b
    bucket.n += 1
    buckets.set(key, bucket)
  }

  const ratio = ratioLabel(naturalWidth, naturalHeight)
  const ordered = [...buckets.values()].sort((left, right) => right.n - left.n).slice(0, 5)
  const palette = ordered.map(bucket => ({
    hex: hex(bucket.r / bucket.n, bucket.g / bucket.n, bucket.b / bucket.n),
    share: bucket.n / count,
  }))

  const sorted = Float64Array.from(lumas).sort()
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))] ?? 0
  const brightness = sorted.reduce((sum, value) => sum + value, 0) / sorted.length

  // Visual mass: pixels that deviate from the mean luma are what the eye lands
  // on. Weighted centroid plus a radius, both as frame fractions.
  let weightSum = 0
  let xSum = 0
  let ySum = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const weight = Math.abs((lumas[y * width + x] ?? 0) - brightness)
      weightSum += weight
      xSum += weight * ((x + 0.5) / width)
      ySum += weight * ((y + 0.5) / height)
    }
  }
  const centroidX = weightSum === 0 ? 0.5 : xSum / weightSum
  const centroidY = weightSum === 0 ? 0.5 : ySum / weightSum
  let spreadSum = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const weight = Math.abs((lumas[y * width + x] ?? 0) - brightness)
      const dx = (x + 0.5) / width - centroidX
      const dy = (y + 0.5) / height - centroidY
      spreadSum += weight * (dx * dx + dy * dy)
    }
  }
  const spread = weightSum === 0 ? 0 : Math.sqrt(spreadSum / weightSum)

  return {
    aspect: ratio.label,
    aspectValue: ratio.value,
    palette,
    brightness,
    contrast: Math.max(0, at(0.9) - at(0.1)),
    saturation: saturationSum / count,
    subject: { x: centroidX, y: centroidY, spread },
    quiet: quietBand(lumas, width, height),
  }
}

/**
 * The largest contiguous band of ROWS (or columns) whose luma barely moves.
 *
 * A flat band is where a designed poster puts its text: keeping it flat is the
 * one structural property of the reference a prompt can actually preserve, so
 * it is worth measuring rather than guessing. Thresholds are on the standard
 * deviation of luma inside the band, and the band must cover at least 8% of the
 * axis to count — anything shorter is noise, not a layout decision.
 */
function quietBand(lumas: Float64Array, width: number, height: number): ReferenceFacts['quiet'] {
  const rowStats = (from: number, to: number): { mean: number; sd: number } => {
    let sum = 0
    let sumSquares = 0
    let n = 0
    for (let y = from; y < to; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = lumas[y * width + x] ?? 0
        sum += value
        sumSquares += value * value
        n += 1
      }
    }
    if (n === 0) return { mean: 0, sd: 0 }
    const mean = sum / n
    return { mean, sd: Math.sqrt(Math.max(0, sumSquares / n - mean * mean)) }
  }
  const columnStats = (from: number, to: number): { mean: number; sd: number } => {
    let sum = 0
    let sumSquares = 0
    let n = 0
    for (let x = from; x < to; x += 1) {
      for (let y = 0; y < height; y += 1) {
        const value = lumas[y * width + x] ?? 0
        sum += value
        sumSquares += value * value
        n += 1
      }
    }
    if (n === 0) return { mean: 0, sd: 0 }
    const mean = sum / n
    return { mean, sd: Math.sqrt(Math.max(0, sumSquares / n - mean * mean)) }
  }

  const THRESHOLD = 0.055
  let best: { axis: 'rows' | 'columns'; start: number; end: number } | null = null
  const scan = (axis: 'rows' | 'columns', length: number, stats: typeof rowStats): void => {
    let runStart = -1
    for (let index = 0; index <= length; index += 1) {
      const flat = index < length && stats(index, index + 1).sd < THRESHOLD
      if (flat && runStart < 0) runStart = index
      if (!flat && runStart >= 0) {
        const candidate = { axis, start: runStart / length, end: index / length }
        const bestLength = best === null ? 0 : best.end - best.start
        if (candidate.end - candidate.start > bestLength && candidate.end - candidate.start >= 0.08) best = candidate
        runStart = -1
      }
    }
  }
  scan('rows', height, rowStats)
  scan('columns', width, columnStats)
  if (best === null) return null
  const range = best as { axis: 'rows' | 'columns'; start: number; end: number }
  const vertical = range.axis === 'rows'
  const atStart = range.start <= 0.02
  const atEnd = range.end >= 0.98
  const edge: NonNullable<ReferenceFacts['quiet']>['edge'] = atStart
    ? vertical ? 'top' : 'left'
    : atEnd
      ? vertical ? 'bottom' : 'right'
      : 'middle'
  return { start: range.start, end: range.end, axis: range.axis, edge }
}

/** One line describing the palette relationship, or an explicit "not measured". */
function paletteLine(facts: ReferenceFacts | null): string {
  if (facts === null || facts.palette.length === 0) return ''
  return facts.palette
    .slice(0, 4)
    .map(entry => `${entry.hex}（约 ${Math.round(entry.share * 100)}%）`)
    .join('、')
}

/** 0-1 → a four-stop word, because a bare 0.42 means nothing to a model. */
function toneWord(value: number): string {
  if (value < 0.25) return '低调（暗）'
  if (value < 0.45) return '中低调'
  if (value < 0.65) return '中间调'
  if (value < 0.82) return '中高调（亮）'
  return '高调（很亮）'
}

function contrastWord(value: number): string {
  if (value < 0.2) return '低反差（柔和过渡）'
  if (value < 0.4) return '中反差'
  if (value < 0.6) return '高反差（硬光硬边）'
  return '极高反差（强明暗分割）'
}

function saturationWord(value: number): string {
  if (value < 0.18) return '低饱和（近乎去色）'
  if (value < 0.34) return '中低饱和'
  if (value < 0.55) return '中饱和'
  return '高饱和'
}

/** A one-word placement for the visual mass, so the reuse reads naturally. */
function placementWord(x: number, y: number): string {
  const horizontal = x < 0.4 ? '偏左' : x > 0.6 ? '偏右' : '居中'
  const vertical = y < 0.4 ? '偏上' : y > 0.6 ? '偏下' : '居中'
  return `${vertical}${horizontal}`
}

const KIND_ZH: Record<ReplicaKind, string> = {
  ecommerce: '电商商品主图：单一商品，干净背景，主体占画面主体位置，信息可读',
  apparel: '服饰电商图：有穿着者或垂挂展示，能看清面料、版型与搭配',
  poster: '营销海报：强主张标题 + 促销信息，视觉冲击优先',
  social: '社媒图文：方形或竖版，适合信息流，主体明确、文字少而大',
  creative: '创意海报：允许超现实构图、隐喻与强美术风格',
  other: '按用户描述执行',
}

/**
 * The 参考风格 prompt: PROSE. One paragraph of transferable style attributes,
 * an explicit list of what must NOT be copied, then the user's own content.
 *
 * Structure is the point: this tier is a *style transfer* instruction. It never
 * contains measured numbers and never contains a 【】 section header, which is
 * exactly what makes it structurally different from the replica prompt below.
 */
export function buildStylePrompt(draft: ReplicaDraft, facts: ReferenceFacts | null): string {
  const lines: string[] = []
  const mood = facts === null
    ? '以参考图的整体调性为准'
    : `${toneWord(facts.brightness)}、${contrastWord(facts.contrast)}、${saturationWord(facts.saturation)}`
  lines.push(`以参考图的视觉语言重新设计一张新图，而不是照搬它的版式。`)
  if (facts !== null) lines.push(`可沿用的调性：${mood}；主色倾向 ${paletteLine(facts)}。`)
  else lines.push(`${mood}。`)
  lines.push(`需要转译的：光质与光影方向、色彩关系、材质质感、镜头语言与渲染风格。`)
  lines.push(`不要照搬的：参考图的具体版式、元素摆放位置、文字内容与品牌标识。`)
  lines.push(`画面类型：${KIND_ZH[draft.kind]}。`)
  if (draft.product.trim() !== '') lines.push(`主体商品：${draft.product.trim()}。`)
  if (draft.extra.trim() !== '') lines.push(`附加要求：${draft.extra.trim()}。`)
  return lines.join('\n')
}

/**
 * The 高度复刻 prompt: LABELED SECTIONS, with the measured facts spelled out.
 *
 * Each 【】 block answers one question the model would otherwise answer by
 * guessing: how tall is the frame, where is the mass, where is the quiet band,
 * what are the colour relationships, what must survive, what must be replaced,
 * what is forbidden. The "禁止" block is load-bearing — without it a
 * layout-faithful model happily reproduces the reference's brand mark.
 */
export function buildReplicaPrompt(draft: ReplicaDraft, facts: ReferenceFacts | null): string {
  const sections: string[] = []

  if (facts === null) {
    // Honest failure: the reference could not be measured, so the layout blocks
    // are absent instead of fabricated. The prompt still differs from the style
    // tier (sectioned, with explicit keep/replace/forbid contracts), but it
    // must SAY the layout was not measured.
    sections.push('【版式】未能读取参考图像素，版式要素未测量。请严格按参考图的可见版式（构图骨架、主体大小与位置、留白区域、文字块位置）复刻，不要自行重排。')
  } else {
    const { aspect, aspectValue, subject, quiet, brightness, contrast, saturation } = facts
    sections.push(`【画幅】${aspect}（宽高比 ${aspectValue.toFixed(2)}），生成时按此比例出图。`)
    sections.push(`【构图骨架】主视觉重心位于画面横向 ${subject.x.toFixed(2)}、纵向 ${subject.y.toFixed(2)}（${placementWord(subject.x, subject.y)}），视觉质量扩散半径约 ${subject.spread.toFixed(2)}（占画面对角线比例）。复刻时保持这一重心，不要居中化或重新平衡。`)
    if (quiet !== null) {
      const from = Math.round(quiet.start * 100)
      const to = Math.round(quiet.end * 100)
      const span = quiet.axis === 'rows'
        ? `画面纵向 ${from}%–${to}%`
        : `画面横向 ${from}%–${to}%`
      const edgeZh = quiet.edge === 'top' ? '上' : quiet.edge === 'bottom' ? '下' : quiet.edge === 'left' ? '左' : quiet.edge === 'right' ? '右' : '中'
      sections.push(`【留白带】${span} 是低细节安全带（位于${edgeZh}部，占该轴 ${to - from}%）。这一段必须保持空、平、无干扰元素，标题与标志只放在这里。`)
    } else {
      sections.push('【留白带】参考图没有明显的低细节带，说明它是满构图。复刻时不要额外加空白区，保持满版。')
    }
    sections.push(`【配色关系】主要色值按占比：${paletteLine(facts)}。整体${toneWord(brightness)}，${contrastWord(contrast)}，${saturationWord(saturation)}。复刻时保持这些颜色的「比例关系」，而不是只挑一个主色。`)
  }

  sections.push(`【光影】沿用参考图的受光方向、阴影硬度与高光形状；不要改成通用的柔和影棚光。`)
  sections.push(`【画面类型】${KIND_ZH[draft.kind]}。`)
  sections.push(draft.product.trim() === ''
    ? '【替换内容】参考图中的商品整体替换为按上述版式重新设计的主体；不得出现参考图原有的文字、品牌名、Logo 或可识别商标。'
    : `【替换内容】把参考图中的商品替换为：${draft.product.trim()}。商品的形状、颜色、材质必须与描述一致，但它在画面中占据的位置、大小比例、朝向要与参考图一致。`)
  sections.push(`【必须保留的结构】画面比例、主视觉重心位置、留白带的位置与宽度、色块之间的相对面积关系。`)
  sections.push(`【禁止】照搬参考图里的文字、品牌名、Logo、水印、可识别商标；禁止把参考图当成底图直接叠加或局部擦改。`)
  if (draft.extra.trim() !== '') sections.push(`【附加要求】${draft.extra.trim()}。`)

  return sections.join('\n')
}

/** Dispatch on the tier. The whole point is that these two never converge. */
export function buildReplicaRequestPrompt(draft: ReplicaDraft, facts: ReferenceFacts | null): string {
  return draft.fidelity === 'replica' ? buildReplicaPrompt(draft, facts) : buildStylePrompt(draft, facts)
}
