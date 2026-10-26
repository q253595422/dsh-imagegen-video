/**
 * 时间线合成的真实验证：真的跑 ffmpeg。
 *
 * 之前只覆盖了「顺序拼接」这一种形态。加入裁剪与转场之后，滤镜图变成
 * 两种分支（全硬切走 concat，任一转场走链式 xfade），而 xfade 的偏移
 * 算错只会得到一个失败或者一段黑屏，类型检查看不出来。
 *
 * 所以这里用本机 ffmpeg 生成三段测试素材，分别跑：
 *   1. 全硬切 + 裁剪
 *   2. 叠化转场
 *   3. 淡入淡出转场 + 关掉音频
 * 每一轮都校验成片时长在预期范围内——时长是唯一能证明「转场真的接上了、
 * 没有多出或少掉一段」的客观量。
 *
 * 缺 ffmpeg 时明确跳过并返回成功（与仓库里其它需要工具的检查一致）。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClipComposer, findTool } from '../src/clip-compose.ts'

// Resolved through the host's own lookup rather than by rebuilding its
// directory list here. The copy this replaces could only ever find a POSIX
// layout, so on Windows it skipped this whole check while the plugin itself was
// perfectly able to encode — a missing-tool skip standing in for a real run.
const ffmpeg = findTool('ffmpeg')

if (ffmpeg === undefined) {
  console.log('timeline compose: SKIPPED (no ffmpeg on this machine)')
  process.exit(0)
}

const dir = await fs.mkdtemp(path.join(tmpdir(), 'dsh-timeline-check-'))
const clip = async (name, seconds, tone, filter) => {
  const file = path.join(dir, name)
  execFileSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`,
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    '-shortest', file,
  ], { stdio: 'ignore' })
  return file
}

/**
 * Run `ffmpeg -i` for its metadata banner.
 *
 * `-i` without an output always exits non-zero, so the banner is taken from
 * stderr instead of relying on the exit code. Using `execFile` with a tolerated
 * exit keeps a probe from looking like a failed render.
 */
const bannerOf = file => {
  try {
    execFileSync(ffmpeg, ['-i', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return String(error.stderr ?? '')
  }
  return ''
}

/** 成片的真实时长，秒。 */
const durationOf = async file => {
  const out = bannerOf(file)
  const match = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(out)
  assert.ok(match !== null, `ffmpeg did not report a duration for ${file}`)
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/** 是否带音轨。 */
const hasAudio = file => /Stream #0:\d+.*Audio:/.test(bannerOf(file))

const composer = createClipComposer()
assert.equal(composer.available(), true, 'ffmpeg/ffprobe pair should be found')

// 三段各 4 秒、颜色不同，转场才看得出来接缝。
const a = await clip('a.mp4', 4, 440, 'hue=h=0')
const b = await clip('b.mp4', 4, 550, 'hue=h=60')
const c = await clip('c.mp4', 4, 660, 'hue=h=120')

// 1) 全硬切 + 裁剪：第一段只取 1.5 秒，第二段从 0.5 秒起取 2 秒。
{
  const result = await composer.stitch({
    sources: [a, b, c],
    trims: [{ start: 0, seconds: 1.5 }, { start: 0.5, seconds: 2 }, { start: 0 }],
  })
  const file = path.join(dir, 'out-cut.mp4')
  await fs.writeFile(file, result.bytes)
  const measured = await durationOf(file)
  // 期望 ≈ 1.5 + 2 + 4 = 7.5 秒；允许 ffmpeg 的帧对齐误差。
  assert.ok(measured > 7.0 && measured < 8.0, `hard cut with trims should be ≈7.5s, got ${measured.toFixed(2)}s`)
  assert.equal(result.width, 1280)
  assert.equal(result.height, 720)
  assert.equal(hasAudio(file), true, 'a plain stitch keeps the audio track')
  console.log(`timeline compose: hard cut with trims -> ${measured.toFixed(2)}s`)
}

// 2) 叠化转场：每条接缝 0.5 秒重叠，总长应短于硬切。
{
  const result = await composer.stitch({
    sources: [a, b, c],
    transitions: [
      { kind: 'dissolve', seconds: 0.5 },
      { kind: 'dissolve', seconds: 0.5 },
    ],
  })
  const file = path.join(dir, 'out-dissolve.mp4')
  await fs.writeFile(file, result.bytes)
  const measured = await durationOf(file)
  // 12 秒素材减去两个 0.5 秒的重叠 ≈ 11 秒。
  assert.ok(measured > 10.4 && measured < 11.6, `two dissolves should be ≈11s, got ${measured.toFixed(2)}s`)
  assert.equal(hasAudio(file), true)
  console.log(`timeline compose: two dissolves -> ${measured.toFixed(2)}s`)
}

// 3) 混合接缝（硬切 + 淡入淡出）且关掉音频。
{
  const result = await composer.stitch({
    sources: [a, b, c],
    transitions: [
      { kind: 'cut', seconds: 0 },
      { kind: 'fade', seconds: 1 },
    ],
    keepAudio: false,
  })
  const file = path.join(dir, 'out-mixed.mp4')
  await fs.writeFile(file, result.bytes)
  const measured = await durationOf(file)
  // 12 秒减去唯一的 1 秒淡入淡出 ≈ 11 秒。
  assert.ok(measured > 10.4 && measured < 11.6, `one fade should be ≈11s, got ${measured.toFixed(2)}s`)
  assert.equal(hasAudio(file), false, 'keepAudio:false must drop the audio track entirely')
  console.log(`timeline compose: mixed seams, silent -> ${measured.toFixed(2)}s`)
}

// 4) 转场不能长过素材：请求 10 秒、素材各 4 秒，必须被夹住而不是让 ffmpeg 报错。
{
  const result = await composer.stitch({
    sources: [a, b],
    transitions: [{ kind: 'dissolve', seconds: 10 }],
  })
  const file = path.join(dir, 'out-clamped.mp4')
  await fs.writeFile(file, result.bytes)
  const measured = await durationOf(file)
  // 夹到 4/2-0.05 = 1.95 秒，总长 ≈ 8 - 1.95 = 6.05 秒。
  assert.ok(measured > 5.5 && measured < 7.0, `an over-long transition should be clamped, got ${measured.toFixed(2)}s`)
  console.log(`timeline compose: over-long transition clamped -> ${measured.toFixed(2)}s`)
}

await fs.rm(dir, { recursive: true, force: true })
console.log('timeline compose: ok')
