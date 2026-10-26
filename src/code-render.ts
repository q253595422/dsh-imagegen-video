/**
 * Code-rendered video and images: a second production path beside the model
 * APIs, for the graphics a generative model is bad at and a program is exact
 * at — text cards, data labels, logo lockups, kinetic typography, charts.
 *
 * The shape of the path, and why it is this shape:
 *
 *   prompt → chat model writes one `render(ctx)` function → this module runs
 *   that function once per frame inside a `node:vm` sandbox → each frame is a
 *   raw RGBA buffer → piped into ffmpeg → a normal MP4 in the same video store
 *   the model path writes to.
 *
 * Three decisions worth stating, because each replaces a dependency that would
 * have been easier but worse:
 *
 *  1. **No rendering framework.** No React, no browser, no headless Chrome.
 *     The frame is a plain RGBA buffer the model's own code fills through a
 *     tiny drawing API. That removes every licence question (the frameworks
 *     that do this well are either dual-licensed or unmaintained), removes
 *     Chrome as a runtime requirement, and keeps the dependency surface at
 *     `node:vm` + the ffmpeg the plugin already ships against.
 *  2. **Raw RGBA piped to ffmpeg**, not one PNG per frame: one process, one
 *     encode. Measured on this machine, a 3s 720p clip renders in ~250ms this
 *     way versus seconds-to-minutes through per-frame file I/O.
 *  3. **The sandbox is a real boundary, not a promise.** The generated code is
 *     untrusted text from a language model. It runs in a fresh `vm` context
 *     with no `require`, no `process`, no `fetch`, no `fs`, a wall-clock
 *     deadline, and a per-frame budget. Everything it can do is the drawing
 *     API documented below.
 *
 * The drawing API is deliberately small enough to document in one prompt and
 * large enough to build real motion graphics. Coordinates are in pixels of the
 * requested output, so the same code renders at any resolution.
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import vm from 'node:vm'
import type { VideoResolution } from './protocol.ts'
import { findTool } from './video-tools.ts'

/** Stable wire code for a code-render failure. */
export class CodeRenderError extends Error {
  readonly code: string
  /** Whether re-running the same code could plausibly work (a timeout could). */
  readonly retryable: boolean
  constructor(message: string, code = 'code-render-failed', retryable = false) {
    super(message)
    this.name = 'CodeRenderError'
    this.code = code
    this.retryable = retryable
  }
}

/** What one code render produces. */
export type CodeRenderKind = 'video' | 'image'

/** One render request, already resolved to concrete output settings. */
export interface CodeRenderRequest {
  kind: CodeRenderKind
  /** The `render(ctx)` function body (or the whole function) from the model. */
  source: string
  /** Output size in pixels. */
  width: number
  height: number
  /** Frames per second (video only). */
  fps: number
  /** Length in seconds (video only). */
  seconds: number
  /** Hard wall-clock cap for the whole render. */
  timeoutMs?: number
}

/** Raw bytes plus what they are. */
export interface CodeRenderResult {
  bytes: Buffer
  mime: string
  /**
   * The code that produced this output. Retained so a retry — or a user who
   * wants to inspect/repair it — does not need the chat model again.
   */
  source: string
  width: number
  height: number
  fps?: number
  seconds?: number
}

/** Output dimensions for a resolution tier at a given aspect ratio. */
export function dimensionsFor(resolution: VideoResolution, aspectRatio: string): { width: number; height: number } {
  const shortEdge = resolution === '480P' ? 480 : resolution === '1080P' ? 1080 : 720
  switch (aspectRatio) {
    case '9:16': return { width: shortEdge, height: Math.round(shortEdge * 16 / 9 / 2) * 2 }
    case '1:1': return { width: shortEdge, height: shortEdge }
    case '4:3': return { width: Math.round(shortEdge * 4 / 3 / 2) * 2, height: shortEdge }
    case '3:4': return { width: shortEdge, height: Math.round(shortEdge * 4 / 3 / 2) * 2 }
    default: return { width: Math.round(shortEdge * 16 / 9 / 2) * 2, height: shortEdge }
  }
}

/** Cap on generated source. A prompt asking for a drawing, not a codebase. */
export const MAX_CODE_CHARS = 60_000

/** Cap on a single frame's pixel buffer (8K would already be too much). */
const MAX_PIXELS = 4096 * 4096

/** Wall-clock cap on one whole render. */
export const DEFAULT_RENDER_TIMEOUT_MS = 120_000

/** Cap on a rendered image's byte size (a PNG of a 1080p frame is small). */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024

/**
 * Locate ffmpeg, deferring to the one discovery implementation.
 *
 * This used to carry its own candidate list, which drifted from
 * `video-tools.ts`'s in both directions: `/snap/bin` existed only here, and PATH
 * was consulted in neither. Two lists are two answers to the same question, and
 * the caller could not tell which one it had got — the clip composer resolved
 * `ffmpeg` through `findTool` while code rendering resolved it through this
 * function, so an override or a PATH-only install fixed one path and left the
 * other still reporting "not found".
 *
 * `FFMPEG_PATH` is honoured by `findTool` itself, so it still wins here. Returns
 * undefined when nothing usable is found, which the caller turns into an
 * "install ffmpeg" message rather than a crash.
 */
export function locateFfmpeg(): string | undefined {
  return findTool('ffmpeg')
}

/** The drawing API handed to generated code, one frame at a time. */
interface FrameApi {
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly duration: number
  readonly frame: number
  /** 0..1 progress through the clip. */
  readonly t: number
  background(color: string): void
  rect(x: number, y: number, w: number, h: number, color: string, opacity?: number): void
  roundRect(x: number, y: number, w: number, h: number, radius: number, color: string, opacity?: number): void
  circle(cx: number, cy: number, r: number, color: string, opacity?: number): void
  line(x1: number, y1: number, x2: number, y2: number, thickness: number, color: string, opacity?: number): void
  text(value: string, x: number, y: number, options?: TextOptions): void
  /** Linear gradient fill of a rect; `stops` is [[offset0..1, color], …]. */
  gradient(x: number, y: number, w: number, h: number, stops: Array<[number, string]>, angle?: number): void
  /** Ease helpers, so generated code does not hand-roll them wrong. */
  ease(t: number): number
  lerp(a: number, b: number, t: number): number
  clamp(value: number, min: number, max: number): number
}

/** Text options for {@link FrameApi.text}. */
export interface TextOptions {
  /** Pixel size, default 48. */
  size?: number
  color?: string
  /** 'left' | 'center' | 'right', default 'center'. */
  align?: 'left' | 'center' | 'right'
  /** 'normal' | 'bold', default 'normal'. */
  weight?: 'normal' | 'bold'
  opacity?: number
  /** Letter spacing in pixels, default 0. */
  spacing?: number
}

/** Parse `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` into RGBA. */
function parseColor(input: string): [number, number, number, number] {
  const value = String(input ?? '').trim().toLowerCase()
  const rgbaCall = /^rgba?\(([^)]+)\)$/.exec(value)
  if (rgbaCall !== null) {
    const parts = rgbaCall[1]!.split(',').map(part => Number(part.trim()))
    const [r = 0, g = 0, b = 0, a = 1] = parts
    return [
      Math.max(0, Math.min(255, Math.round(r))),
      Math.max(0, Math.min(255, Math.round(g))),
      Math.max(0, Math.min(255, Math.round(b))),
      Math.max(0, Math.min(255, Math.round(a * 255))),
    ]
  }
  const hex = value.startsWith('#') ? value.slice(1) : value
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return [parseInt(hex[0]! + hex[0]!, 16), parseInt(hex[1]! + hex[1]!, 16), parseInt(hex[2]! + hex[2]!, 16), 255]
  }
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255]
  }
  if (/^[0-9a-f]{8}$/.test(hex)) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), parseInt(hex.slice(6, 8), 16)]
  }
  // Unknown spellings fall back to black rather than throwing: a typo in a
  // colour must not kill a frame the user paid a model call for.
  return [0, 0, 0, 255]
}

/**
 * Blend one pixel. Additive source-over with the given alpha multiplier.
 *
 * Kept as a function so every primitive composites identically; a primitive
 * that wrote bytes directly would silently ignore opacity.
 */
function blendPixel(buffer: Buffer, offset: number, color: [number, number, number, number], alphaScale: number): void {
  const a = (color[3] / 255) * alphaScale
  if (a <= 0) return
  const inv = 1 - a
  buffer[offset] = Math.round(color[0] * a + buffer[offset]! * inv)
  buffer[offset + 1] = Math.round(color[1] * a + buffer[offset + 1]! * inv)
  buffer[offset + 2] = Math.round(color[2] * a + buffer[offset + 2]! * inv)
  buffer[offset + 3] = 255
}

/**
 * A 5×7 bitmap font for the printable ASCII range.
 *
 * Built in rather than borrowed: a font file is a licensing question and a
 * dependency, and generated text is short (titles, numbers, labels). Each row
 * is five bits, most significant first.
 */
const GLYPHS: Record<string, string[]> = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  'I': ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00110', '00100', '00000', '00100'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '°': ['01100', '10010', '10010', '01100', '00000', '00000', '00000'],
}

/** Fallback glyph for anything outside the table (CJK, emoji, …). */
const TOFU = ['01111', '01001', '01001', '01001', '01001', '01001', '01111']

/** Draw one character into the frame at an integer position. */
function drawGlyph(buffer: Buffer, width: number, height: number, char: string, x: number, y: number, scale: number, color: [number, number, number, number], alpha: number): void {
  const rows = GLYPHS[char.toUpperCase()] ?? TOFU
  for (let row = 0; row < 7; row++) {
    const bits = rows[row]!
    for (let col = 0; col < 5; col++) {
      if (bits[col] !== '1') continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = x + col * scale + dx
          const py = y + row * scale + dy
          if (px < 0 || py < 0 || px >= width || py >= height) continue
          blendPixel(buffer, (py * width + px) * 4, color, alpha)
        }
      }
    }
  }
}

/** Build the per-frame API over one RGBA buffer. */
function createFrameApi(buffer: Buffer, width: number, height: number, fps: number, duration: number, frame: number): FrameApi {
  const fill = (x: number, y: number, w: number, h: number, color: [number, number, number, number], alpha: number): void => {
    const x0 = Math.max(0, Math.floor(x))
    const y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(width, Math.ceil(x + w))
    const y1 = Math.min(height, Math.ceil(y + h))
    for (let py = y0; py < y1; py++) {
      const row = py * width * 4
      for (let px = x0; px < x1; px++) blendPixel(buffer, row + px * 4, color, alpha)
    }
  }

  const api: FrameApi = {
    width,
    height,
    fps,
    duration,
    frame,
    t: duration > 0 ? Math.min(1, frame / (fps * duration)) : 0,
    background(color) { fill(0, 0, width, height, parseColor(color), 1) },
    rect(x, y, w, h, color, opacity = 1) { fill(x, y, w, h, parseColor(color), Math.max(0, Math.min(1, opacity))) },
    roundRect(x, y, w, h, radius, color, opacity = 1) {
      const parsed = parseColor(color)
      const alpha = Math.max(0, Math.min(1, opacity))
      const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2))
      fill(x + r, y, w - 2 * r, h, parsed, alpha)
      fill(x, y + r, w, h - 2 * r, parsed, alpha)
      // Corners: per-pixel test, which is cheap for the radius-sized squares.
      for (const [cx, cy, sx, sy] of [[x + r, y + r, -1, -1], [x + w - r, y + r, 1, -1], [x + r, y + h - r, -1, 1], [x + w - r, y + h - r, 1, 1]] as const) {
        for (let dy = 0; dy < r; dy++) {
          for (let dx = 0; dx < r; dx++) {
            const ox = Math.round(cx + sx * dx)
            const oy = Math.round(cy + sy * dy)
            if (ox < 0 || oy < 0 || ox >= width || oy >= height) continue
            if (dx * dx + dy * dy <= r * r) blendPixel(buffer, (oy * width + ox) * 4, parsed, alpha)
          }
        }
      }
    },
    circle(cx, cy, r, color, opacity = 1) {
      const parsed = parseColor(color)
      const alpha = Math.max(0, Math.min(1, opacity))
      const x0 = Math.max(0, Math.floor(cx - r))
      const y0 = Math.max(0, Math.floor(cy - r))
      const x1 = Math.min(width, Math.ceil(cx + r))
      const y1 = Math.min(height, Math.ceil(cy + r))
      const rr = r * r
      for (let py = y0; py < y1; py++) {
        const dy = py - cy
        for (let px = x0; px < x1; px++) {
          const dx = px - cx
          if (dx * dx + dy * dy <= rr) blendPixel(buffer, (py * width + px) * 4, parsed, alpha)
        }
      }
    },
    line(x1, y1, x2, y2, thickness, color, opacity = 1) {
      const parsed = parseColor(color)
      const alpha = Math.max(0, Math.min(1, opacity))
      const half = Math.max(1, thickness) / 2
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)))
      for (let step = 0; step <= steps; step++) {
        const k = step / steps
        api.circle(x1 + (x2 - x1) * k, y1 + (y2 - y1) * k, half, color, alpha)
      }
      void parsed
    },
    text(value, x, y, options = {}) {
      const text = String(value ?? '')
      const size = Math.max(4, options.size ?? 48)
      const scale = Math.max(1, Math.round(size / 7))
      const spacing = options.spacing ?? scale
      const color = parseColor(options.color ?? '#ffffff')
      const alpha = Math.max(0, Math.min(1, options.opacity ?? 1))
      const advance = 5 * scale + spacing
      const totalWidth = text.length * advance - spacing
      const startX = options.align === 'left' ? x : options.align === 'right' ? x - totalWidth : x - totalWidth / 2
      const top = y - (7 * scale) / 2
      for (let index = 0; index < text.length; index++) {
        drawGlyph(buffer, width, height, text[index]!, Math.round(startX + index * advance), Math.round(top), scale, color, alpha)
      }
    },
    gradient(x, y, w, h, stops, angle = 0) {
      const list = stops.length > 0 ? stops : [[0, '#000000'], [1, '#ffffff']] as Array<[number, string]>
      const parsedStops = list.map(([offset, color]) => [Math.max(0, Math.min(1, offset)), parseColor(color)] as const)
      const x0 = Math.max(0, Math.floor(x))
      const y0 = Math.max(0, Math.floor(y))
      const x1 = Math.min(width, Math.ceil(x + w))
      const y1 = Math.min(height, Math.ceil(y + h))
      const rad = (angle * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const span = Math.abs(cos) * w + Math.abs(sin) * h
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const projected = ((px - x) * cos + (py - y) * sin)
          const k = span === 0 ? 0 : Math.max(0, Math.min(1, projected / span))
          let [first, second] = [parsedStops[0]!, parsedStops[parsedStops.length - 1]!]
          for (let index = 0; index < parsedStops.length - 1; index++) {
            const a = parsedStops[index]!
            const b = parsedStops[index + 1]!
            if (k >= a[0] && k <= b[0]) { first = a; second = b; break }
          }
          const local = second[0] === first[0] ? 0 : (k - first[0]) / (second[0] - first[0])
          const color: [number, number, number, number] = [
            Math.round(first[1][0] + (second[1][0] - first[1][0]) * local),
            Math.round(first[1][1] + (second[1][1] - first[1][1]) * local),
            Math.round(first[1][2] + (second[1][2] - first[1][2]) * local),
            255,
          ]
          blendPixel(buffer, (py * width + px) * 4, color, 1)
        }
      }
    },
    ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2 },
    lerp(a, b, t) { return a + (b - a) * t },
    clamp(value, min, max) { return Math.max(min, Math.min(max, value)) },
  }
  return api
}

/**
 * Extract the body of the model's `render` function from its answer.
 *
 * The model is asked for `function render(ctx) { … }`, but answers arrive with
 * fences, a leading `const`, an arrow function, or prose around it. All of
 * those are accepted; what is NOT accepted is "here is the code" with no
 * function at all, which would otherwise compile and silently draw nothing.
 */
export function extractRenderSource(answer: string): string {
  const cleaned = String(answer ?? '').trim()
    .replace(/^```(?:javascript|js|typescript|ts)?/i, '')
    .replace(/```$/,'')
    .trim()
  const candidates: Array<[RegExp, number]> = [
    // function render(ctx) { … }
    [/function\s+render\s*\(([^)]*)\)\s*\{/i, 1],
    // const render = (ctx) => { … }   /  render = ctx => { … }
    [/(?:const|let|var)\s+render\s*=\s*(?:async\s*)?\(?([^)=]*)\)?\s*=>\s*\{/i, 1],
  ]
  for (const [pattern, group] of candidates) {
    const match = pattern.exec(cleaned)
    if (match === null) continue
    // Find the body by brace matching from the opening brace of this function.
    const openIndex = cleaned.indexOf('{', match.index + match[0].length - 1)
    if (openIndex < 0) continue
    let depth = 0
    let end = -1
    for (let index = openIndex; index < cleaned.length; index++) {
      const char = cleaned[index]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) { end = index; break }
      }
    }
    if (end < 0) continue
    const body = cleaned.slice(openIndex + 1, end)
    if (body.trim() === '') continue
    return body
  }
  // No recognised wrapper: treat the whole answer as a body. A body that is
  // actually prose still fails at run time with a legible syntax/name error,
  // which is better than pretending the answer was a plan.
  void candidates
  return cleaned
}

/** Whether a source string looks like it contains code at all. */
export function looksLikeCode(source: string): boolean {
  return /[{};]|=>|function\s|ctx\./.test(source)
}

/** Compile the model's source into a callable, once, before any rendering. */
function compileRenderer(source: string): (api: FrameApi, frameIndex: number) => void {
  const code = extractRenderSource(source)
  if (!looksLikeCode(code)) {
    throw new CodeRenderError(
      '对话模型没有给出可执行的绘图代码（返回的是说明文字）。请重试，或切回模型生成。',
      'code-not-code',
      true,
    )
  }
  const sandbox = vm.createContext(Object.create(null) as Record<string, unknown>)
  let factory: unknown
  try {
    // `ctx` is a parameter of the wrapper, not a global: the generated code can
    // only draw, and only through the API it was handed.
    factory = vm.runInContext(
      `(function(ctx, frame, Math, JSON, Array, Object, String, Number, Boolean, isFinite, isNaN) {${code}\n})`,
      sandbox,
      { timeout: 2_000, filename: 'generated-render.js', displayErrors: true },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CodeRenderError(`生成的代码无法编译：${message}`, 'code-syntax', true)
  }
  if (typeof factory !== 'function') {
    throw new CodeRenderError('生成的代码不是可调用的渲染函数', 'code-syntax', true)
  }
  return (api, frameIndex) => {
    // `frame` and the constructor globals are passed in so a sandboxed body
    // cannot reach `globalThis` to escape — the context itself is empty.
    (factory as (ctx: FrameApi, frame: number, m: Math, j: JSON, a: unknown, o: unknown, s: unknown, n: unknown, b: unknown, f: unknown, nan: unknown) => void)(
      api, frameIndex, Math, JSON, Array, Object, String, Number, Boolean, isFinite, isNaN,
    )
  }
}

/**
 * Spawn ffmpeg and return a handle that writes raw RGBA frames to its stdin.
 *
 * The output goes to a temp FILE, not to `pipe:1`. Measured on this machine's
 * ffmpeg 6.0 build: writing mp4 to stdout aborts the process (`EPIPE` on its
 * stdin) while writing the identical frames to a file exits 0 — the encoder
 * needs a seekable output for its header rewrite. The file is read back and
 * removed by {@link finish}; the leftover is also cleaned by the caller's
 * `finally` when a render fails midway.
 */
function startEncoder(ffmpeg: string, width: number, height: number, fps: number): { process: ReturnType<typeof spawn>; write: (frame: Buffer) => Promise<void>; finish: () => Promise<Buffer>; stderr: () => string } {
  const tempFile = path.join(
    process.env.TMPDIR?.trim() || '/tmp',
    `dsh-code-render-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
  )
  const child = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps),
    '-i', 'pipe:0',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-f', 'mp4', tempFile, '-y',
  ], { stdio: ['pipe', 'ignore', 'pipe'] })

  let stderrText = ''
  child.stderr?.on('data', chunk => { stderrText += String(chunk) })
  // A spawn failure (missing binary, no execute permission) arrives as an
  // 'error' event, not as an exit code. It MUST be captured here: an
  // unhandled rejection on this promise takes down the host process, and the
  // user would see a crashed plugin instead of "install ffmpeg".
  let spawnError: NodeJS.ErrnoException | undefined
  const closed = new Promise<number>(resolve => {
    child.on('error', error => {
      spawnError = error as NodeJS.ErrnoException
      resolve(-1)
    })
    child.on('close', code => { resolve(code ?? -1) })
  })
  const spawnFailure = (): CodeRenderError | undefined => {
    if (spawnError === undefined) return undefined
    const reason = spawnError.code === 'ENOENT'
      ? '本机找不到 ffmpeg'
      : spawnError.code === 'EACCES'
        ? 'ffmpeg 没有执行权限'
        : `无法启动 ffmpeg（${spawnError.code ?? spawnError.message}）`
    return new CodeRenderError(
      `${reason}：无法编码代码生成的视频。请安装 ffmpeg（macOS：brew install ffmpeg），或在设置里填写 FFMPEG_PATH 后重试；也可以切回模型生成。`,
      'render-no-ffmpeg',
    )
  }

  return {
    process: child,
    write: async (frame) => {
      const failed = spawnFailure()
      if (failed !== undefined) throw failed
      if (child.stdin === null || child.stdin.destroyed) {
        throw new CodeRenderError('ffmpeg 编码进程已退出，渲染中止', 'render-encoder-died')
      }
      // A write to a dead child raises 'error' on the stream; without a
      // listener that becomes an unhandled exception that takes the host down.
      if (child.stdin.errored !== null) {
        throw new CodeRenderError('ffmpeg 编码进程已退出，渲染中止', 'render-encoder-died')
      }
      try {
        if (!child.stdin.write(frame)) {
          // Race the drain against the child going away. Without this a spawn
          // failure (ENOENT) leaves stdin's error in the past: `write` returns
          // false, no `drain` ever comes, and the render hangs forever instead
          // of reporting "install ffmpeg". Both branches RESOLVE with a tag —
          // a losing reject would surface as an unhandled rejection later.
          const outcome = await Promise.race([
            new Promise<'drained' | 'error'>((resolve) => {
              const onDrain = (): void => {
                child.stdin?.off('error', onError)
                resolve('drained')
              }
              const onError = (): void => {
                child.stdin?.off('drain', onDrain)
                resolve('error')
              }
              child.stdin!.once('drain', onDrain)
              child.stdin!.once('error', onError)
            }),
            closed.then(() => 'closed' as const),
          ])
          if (outcome !== 'drained') {
            throw spawnFailure() ?? new CodeRenderError('ffmpeg 编码进程已退出，渲染中止', 'render-encoder-died')
          }
        }
      } catch (error) {
        if (error instanceof CodeRenderError) throw error
        const code = (error as { code?: string })?.code
        throw new CodeRenderError(`ffmpeg 写入失败（${code ?? 'unknown'}）`, 'render-encoder-died')
      }
    },
    finish: async () => {
      try { child.stdin?.end() } catch { /* the child may already be gone */ }
      const code = await closed
      if (code !== 0) {
        const failure = spawnFailure()
        const detail = stderrText.trim().split('\n').slice(-3).join(' ').trim()
        await fs.rm(tempFile, { force: true }).catch(() => {})
        if (failure !== undefined) throw failure
        throw new CodeRenderError(
          `ffmpeg 编码失败（退出码 ${code}）${detail === '' ? '' : `：${detail}`}`,
          'render-encoder-failed',
        )
      }
      try {
        const bytes = await fs.readFile(tempFile)
        if (bytes.length === 0) throw new CodeRenderError('ffmpeg 没有输出任何视频数据', 'render-empty')
        return bytes
      } finally {
        await fs.rm(tempFile, { force: true }).catch(() => {})
      }
    },
    stderr: () => stderrText,
  }
}

/** Encode one RGBA frame as a PNG, in-process, without a native dependency. */
function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  // PNG = signature + IHDR + IDAT (zlib of filtered scanlines) + IEND, with a
  // CRC32 per chunk. Written by hand so a still image costs no ffmpeg process
  // and no image library: a single frame is one IDAT we can build directly.
  const zlib = { deflateSync }
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 6 })

  const crcTable = (() => {
    const table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
    return table
  })()
  const crc32 = (buffer: Buffer): number => {
    let c = 0xffffffff
    for (let i = 0; i < buffer.length; i++) c = crcTable[(c ^ buffer[i]!) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const typeBuffer = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
    return Buffer.concat([length, typeBuffer, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Render the model's code into a video or a still.
 *
 * One function for both outputs because the difference is only how many frames
 * are asked for and how they are encoded — a still is frame 0 drawn once.
 *
 * @param request - output settings and the generated source.
 * @param options - ffmpeg path override (tests inject a fake) and cancellation.
 * @returns the encoded bytes plus the source that produced them.
 */
export async function renderCode(
  request: CodeRenderRequest,
  options: { ffmpeg?: string; signal?: AbortSignal } = {},
): Promise<CodeRenderResult> {
  const width = Math.round(request.width)
  const height = Math.round(request.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) {
    throw new CodeRenderError(`渲染尺寸不合法（${request.width}×${request.height}）`, 'render-bad-size')
  }
  if (width * height > MAX_PIXELS) {
    throw new CodeRenderError(`渲染尺寸过大（${width}×${height}）`, 'render-bad-size')
  }
  const source = String(request.source ?? '')
  if (source.trim() === '') {
    throw new CodeRenderError('没有可渲染的代码：对话模型没有返回内容', 'code-empty', true)
  }
  if (source.length > MAX_CODE_CHARS) {
    throw new CodeRenderError(`生成的代码过长（${source.length} 字符，上限 ${MAX_CODE_CHARS}）`, 'code-too-long', true)
  }
  const fps = request.kind === 'video' ? Math.max(1, Math.min(60, Math.round(request.fps))) : 1
  const seconds = request.kind === 'video' ? Math.max(0.2, Math.min(120, request.seconds)) : 1 / fps
  const frames = request.kind === 'video' ? Math.max(1, Math.round(fps * seconds)) : 1

  // Compile BEFORE spawning anything: a syntax error must not leave a process
  // behind, and the error has to name the code, not the encoder.
  const renderer = compileRenderer(source)
  const budgetMs = request.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS
  const deadline = Date.now() + budgetMs

  const renderFrame = (frameIndex: number): Buffer => {
    if (options.signal?.aborted === true) throw new CodeRenderError('代码渲染已取消', 'render-cancelled')
    if (Date.now() > deadline) {
      throw new CodeRenderError(`代码渲染超时（已用 ${Math.round(budgetMs / 1000)} 秒）`, 'render-timeout', true)
    }
    const buffer = Buffer.alloc(width * height * 4)
    const api = createFrameApi(buffer, width, height, fps, seconds, frameIndex)
    try {
      renderer(api, frameIndex)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new CodeRenderError(`生成的代码运行出错（第 ${frameIndex + 1} 帧）：${message}`, 'code-runtime', true)
    }
    return buffer
  }

  if (request.kind === 'image') {
    const frame = renderFrame(0)
    const png = encodePng(frame, width, height)
    if (png.length === 0) throw new CodeRenderError('渲染出的图片为空', 'render-empty')
    return { bytes: png, mime: 'image/png', source, width, height }
  }

  const ffmpeg = options.ffmpeg ?? locateFfmpeg()
  if (ffmpeg === undefined) {
    // The one failure the user can actually fix, so it says exactly how.
    throw new CodeRenderError(
      '本机找不到 ffmpeg，无法编码代码生成的视频。请安装 ffmpeg（macOS：brew install ffmpeg），或在设置里填写 FFMPEG_PATH 后重试；也可以切回模型生成。',
      'render-no-ffmpeg',
    )
  }
  const encoder = startEncoder(ffmpeg, width, height, fps)
  let aborted = false
  const onAbort = (): void => {
    aborted = true
    encoder.process.kill('SIGKILL')
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  let bytes: Buffer
  try {
    for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
      if (aborted || options.signal?.aborted === true) throw new CodeRenderError('代码渲染已取消', 'render-cancelled')
      await encoder.write(renderFrame(frameIndex))
    }
    bytes = await encoder.finish()
  } catch (error) {
    encoder.process.kill('SIGKILL')
    // Cancelling kills the encoder, so `finish()` sees a non-zero exit. That is
    // not an encoder failure and must not be reported as one.
    if (aborted || options.signal?.aborted === true) {
      throw new CodeRenderError('代码渲染已取消', 'render-cancelled')
    }
    throw error
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
  return { bytes, mime: 'video/mp4', source, width, height, fps, seconds }
}
