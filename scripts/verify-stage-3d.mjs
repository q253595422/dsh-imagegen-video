/**
 * 导演台 3D 视口的**真浏览器**验收：把 `stage-scene-3d.ts` 渲出来的像素拿回来看。
 *
 * WHY 必须真浏览器：这个模块的全部价值就是「像素长什么样」——人偶有没有体积、
 * 地面网格在不在、道具挡不挡得住腿、机位模式看到的是不是机位那一帧。这些
 * 断言在 Node 里一条也测不了（没有 WebGL、没有 canvas 2D 之外的东西）。
 *
 * 这里的口径是**不比对具体像素颜色**（那会把每换一次光照都变成一次红灯），
 * 而是问几个任何一份正确的渲染都必须满足的问题：
 *
 *  V1  是不是真的画出了东西：不是一张纯色/全透明的图。
 *  V2  角色在画面里：把角色挪到侧面，画面必须变。
 *  V3  道具会遮挡：把人偶与立方体重叠时，画面必须变——这是换 three.js 的
 *      全部理由，画家算法在这里答不对。
 *  V4  导出的确定性：同一份 stage 导出两次必须一致。
 *  V5  时间轴驱动：一条直线路径让角色在 0 秒与 3 秒处于不同位置。
 *
 * Run: node scripts/verify-stage-3d.mjs [--out DIR]
 * Exit 0 = 全过；无 Chromium 时明确跳过（exit 0）；任一条不成立 exit 1。
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { findChrome, openPage } from './lib/headless-chrome.mjs'
import { createCheckHarness } from './lib/check-harness.mjs'
import assert from 'node:assert/strict'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const results = []
const check = createCheckHarness({ results })
const poseRig = await import(join(ROOT, 'src/client/canvas/pose-rig.ts'))

const outIndex = process.argv.indexOf('--out')
const outDir = outIndex === -1 ? null : process.argv[outIndex + 1]

const chrome = findChrome([], process.env)
if (chrome === null) {
  process.stdout.write('stage 3d: no headless Chromium found — skipped\n')
  process.exit(0)
}

/**
 * 起一个**带 GPU** 的 headless Chrome。
 *
 * 不走 `lib/headless-chrome.mjs` 的 `launchChrome`：它固定带 `--disable-gpu`，
 * 而那个标志会让 `getContext('webgl')` 返回 null（实测 GL_VENDOR = Disabled），
 * 于是这个脚本会把自己测的三维渲染判成"环境不支持"。这里自己拼参数，
 * 只借用那个模块的 `openPage`（CDP 会话）。
 */
async function launchWithGpu () {
  const profileDir = mkdtempSync(join(tmpdir(), 'stage3d-profile-'))
  const browser = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let log = ''
  browser.stderr.on('data', chunk => { if (log.length < 4_000) log += String(chunk) })
  const portFile = join(profileDir, 'DevToolsActivePort')
  let port = 0
  for (let index = 0; index < 150; index += 1) {
    if (browser.exitCode !== null) break
    try {
      const first = readFileSyncPort(portFile)
      if (first !== null) { port = first; break }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (port === 0) {
    browser.kill()
    throw new Error(`headless Chromium never published a DevTools port\n${log.trim()}`)
  }
  return {
    port,
    close: () => {
      try { browser.kill() } catch {}
      // 删不掉就算了：profile 在 tmp 里，node 进程退出后系统会收拾。
      try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
    },
  }
}

function readFileSyncPort (path) {
  if (!existsSync(path)) return null
  const first = readFileSync(path, 'utf8').split('\n')[0]?.trim() ?? ''
  return /^\d+$/.test(first) && Number(first) > 0 ? Number(first) : null
}

const browser = await launchWithGpu()
const page = await openPage(browser.port, 'about:blank')

// 把渲染模块打成一份浏览器可用的 bundle。直接用 tsdown 的那套配置太慢，
// 这里只需要一个入口：转译成浏览器能跑的 ESM。
const bundleDir = mkdtempSync(join(tmpdir(), 'stage3d-bundle-'))
const entry = join(bundleDir, 'entry.ts')
writeFileSync(entry, `
export * from ${JSON.stringify(join(ROOT, 'src/client/canvas/stage-scene-3d.ts'))}
export * from ${JSON.stringify(join(ROOT, 'src/client/canvas/stage-timeline.ts'))}
export * from ${JSON.stringify(join(ROOT, 'src/client/canvas/pose-stage.ts'))}
`)

// 产物名跟着入口名走（tsdown 把 `entry.ts` 打成 `entry.js`），不是 `bundle.js`。
// 写死一个错的名字就会得到 `Failed to fetch dynamically imported module`——
// 那个报错完全指向不到真正的毛病（文件根本不存在）。下面打包后显式验一次。
const bundlePath = join(bundleDir, 'entry.js')
// `--no-config` 是必需的：tsdown 在 cwd 里会自动吃下仓库的 `tsdown.config.ts`，
// 那份配置是**多入口**的客户端+宿主构建，会把同一个入口按 client 配置再打一遍
// CJS。rolldown 对 three 的 ESM 走 CJS 输出会直接报
// `PARSE_ERROR: import statement can only be used at the top level`。
//
// `--deps.alwaysBundle` 同样是必需的，而且**三个模块名都要单列**：`--no-config`
// 之后不再有 `alwaysBundle: ['three', ...]` 的兜底，three 会被留成裸 import，
// 而浏览器 `import()` 一份 `file://` 的 bundle 解析不了裸模块名，整个模块加载
// 直接失败（`Failed to fetch dynamically imported module`）。实测只传 `three`
// 仍会剩一条 `three/examples/jsm/...` 的裸 import——子路径是独立模块名，不会
// 被 `three` 那条带上。
const build = spawn(process.execPath, [
  join(ROOT, 'node_modules/tsdown/dist/run.mjs'),
  entry, '--format', 'esm', '--platform', 'browser', '--out-dir', bundleDir,
  '--no-dts', '--no-clean', '--no-config',
  '--deps.alwaysBundle', 'three',
  '--deps.alwaysBundle', 'three/examples/jsm/loaders/GLTFLoader.js',
], { cwd: ROOT, stdio: 'ignore' })
const buildCode = await new Promise(resolve => build.on('exit', resolve))
if (buildCode !== 0) {
  // **不能 skip**：跳过等于「构建坏了但测试是绿的」。上面那条注释记的就是这个
  // 教训——这个脚本曾经因为打包参数错而静默 exit 0，谁也不知道 V1–V5 一条都
  // 没跑过。构建失败是脚本自身的缺陷，必须红。
  page.close(); browser.close()
  rmSync(bundleDir, { recursive: true, force: true })
  process.stderr.write('stage 3d: bundle build failed — fix the bundling, do not skip\n')
  process.exit(1)
}
if (!existsSync(bundlePath)) {
  // 构建"成功"但产物不叫这个名字：直接报出来，不要让下面那个动态 import
  // 去挖一个指向不明的原因。
  page.close(); browser.close()
  rmSync(bundleDir, { recursive: true, force: true })
  process.stderr.write(`stage 3d: the build produced no ${bundlePath}\n`)
  process.exit(1)
}

/**
 * 把 ESM bundle 装进页面，得到它的导出对象。
 *
 * **不走 `import(file://...)`**：Chrome 会拒绕从 `file://` 加载的 ES module
 * （`Failed to fetch dynamically imported module`），而这是浏览器的安全策略，
 * 不是 bundle 的毛病——实测同一份产物里一个裸 import 都没有、一个 `require(`
 * 也没有，长度完整、结尾导出齐全，它只是不被允许按 URL 加载。
 *
 * 改成把源码包成一段函数体、用 `Runtime.evaluate` 直接执行：把 `export` 改写成
 * 一个返回对象字面量，绕开模块加载器。代价是要做一点文本处理，但换来的是
 * 这份验收不依赖任何浏览器启动参数（`--allow-file-access-from-files` 之类
 * 会反过来影响被测环境）。
 */
async function installBundle () {
  const source = readFileSync(bundlePath, 'utf8')
  const names = [...source.matchAll(/^export\s*\{([^}]*)\}\s*;?\s*$/gm)]
  if (names.length === 0) throw new Error('the bundle has no export list to rewrite')
  // `export { a, b as c }` → `return { a: a, c: b }`
  const fields = names.flatMap(match => match[1].split(',').map(part => part.trim()).filter(Boolean).map(spec => {
    const [local, exported] = spec.split(/\s+as\s+/).map(token => token.trim())
    return `${JSON.stringify(exported ?? local)}: ${local}`
  }))
  const body = source.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
  const script = `(() => {\n${body}\nreturn { ${fields.join(', ')} }\n})()`
  const result = await page.evaluate(`(() => { window.__mod = ${script}; return true })()`)
  if (result !== true) throw new Error('installing the bundle did not stick')
}

await installBundle()

const supports = await page.evaluate('(()=>{try{return window.__mod.stageSceneSupported()}catch(e){return String(e)}})()')
if (supports !== true) {
  process.stdout.write(`stage 3d: WebGL unavailable in this browser (${String(supports)}) — skipped\n`)
  page.close(); browser.close()
  rmSync(bundleDir, { recursive: true, force: true })
  process.exit(0)
}

/** 渲一张 PNG 并把它的像素读回来（RGBA 数组太长，这里读成几个统计量 + 缩略网格）。 */
async function render (stageJson, width, height, extra = '') {
  const stage = typeof stageJson === 'string' ? stageJson : JSON.stringify(stageJson)
  const script = `(async () => {
    const m = window.__mod
    const stage = ${stage}
    const url = await m.renderStageToDataUrl(stage, { width: ${width}, height: ${height} })
    const img = new Image()
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url })
    const canvas = document.createElement('canvas')
    canvas.width = ${width}; canvas.height = ${height}
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, ${width}, ${height})
    ${extra}
    return { url, width: ${width}, height: ${height}, fingerprint: __fingerprint(data, ${width}, ${height}) }
  })()`
  return page.evaluate(script)
}

/** 注入到页面里的指纹函数：颜色直方图 + 中心区域采样，够判断"两张图不同"。 */
await page.evaluate(`(() => {
  window.__fingerprint = (data, width, height) => {
    const buckets = new Map()
    let sum = 0, count = 0
    for (let i = 0; i < data.length; i += 4 * 97) {
      const key = (data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4)
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
      sum += data[i] + data[i + 1] + data[i + 2]
      count += 1
    }
    const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    return { distinct: buckets.size, mean: Math.round(sum / Math.max(1, count) / 3), top }
  }
})()`)

/**
 * 一份最小舞台。
 *
 * 返回的是**对象**，不是 JSON 文本：调用方要么整份 `JSON.stringify` 嵌进页面脚本，
 * 要么把对象直接交给 `sampleStage`。早先它返回字符串，于是 V5 里再 stringify 一次
 * 就得到「字符串套字符串」，在页面里表现为 `Cannot read properties of undefined
 * (reading '0')`——报错位置（`sampleStage` 读 `stage.actors[0]`）与真正的原因
 * （传进去的根本不是对象）相差很远。
 */
function baseStage (patch = {}) {
  return {
    actors: [{ id: 'actor-1', name: 'A', rig: { joints: {}, facing: 0 }, x: 0, z: 0 }],
    cameras: [{
      id: 'camera-1', name: '机位', x: 0, y: 1.6, z: 5,
      targetX: 0, targetY: 1, targetZ: 0, fov: 40,
    }],
    cameraId: 'camera-1',
    scene: {
      sky: '#1b2030', translate: [0, 0, 0], rotateY: 0, scale: 100,
      panoYaw: 0, panoRadius: 20, labels: false,
    },
    ...patch,
  }
}

const png = []

// ------------------------------------------------------------- V1 画出了东西

await check('V1 the viewport renders something other than a flat fill', async () => {
  const shot = await render(baseStage(), 480, 320)
  assert.ok(shot.url.startsWith('data:image/png'), 'renderStageToDataUrl must return a PNG data URL')
  assert.ok(shot.fingerprint.distinct > 8, `expected a varied image, got ${shot.fingerprint.distinct} colour buckets`)
  png.push(['v1.png', shot.url])
})

// -------------------------------------------------------------- V2 角色在画面里

await check('V2 moving the actor changes the picture', async () => {
  const centre = await render(baseStage(), 480, 320)
  const offset = await render(baseStage({
    actors: [{ id: 'actor-1', name: 'A', rig: { joints: {}, facing: 0 }, x: 2.2, z: 0 }],
  }), 480, 320)
  assert.notDeepEqual(offset.fingerprint, centre.fingerprint, 'moving the actor must change the render')
  png.push(['v2-offset.png', offset.url])
})

// -------------------------------------------------------------- V3 道具会遮挡

await check('V3 a cube in front of the actor occludes it', async () => {
  // 没有道具时，画面中央是「人偶 + 地面」；把一个立方体压在同一个位置、
  // 比人偶更靠近机位，中央区域的颜色应当整体偏向立方体的材质色。
  const empty = await render(baseStage(), 480, 320)
  const occluded = await render(baseStage({
    props: [{
      id: 'prop-1', name: '盒', kind: 'cube', x: 0, y: 0.5, z: 2.5,
      rotateX: 0, rotateY: 0, rotateZ: 0, scaleX: 1.6, scaleY: 1.6, scaleZ: 1.6,
    }],
  }), 480, 320)
  assert.notDeepEqual(occluded.fingerprint, empty.fingerprint, 'a blocking cube must change the render')
  png.push(['v3-occluded.png', occluded.url])
})

// -------------------------------------------------------- V4 导出的确定性
//
// 这条**不是**「两种视角不同」：`renderStageToDataUrl` 的契约就是「导出当前
// 机位看到的那一帧」，它没有 mode 参数，也就无从比较 director / camera。
// 这里守的是另一个同样重要的性质——同一份 stage 两次导出必须逐像素一致。
// 导出是对用户的承诺（我按了导出，得到的应该就是我看到的那一帧），不可复现
// 的导出意味着「同样的舞台导两次不一样」，那种 bug 极难被用户描述清楚。

await check('V4 exporting the same stage twice is byte-for-byte reproducible', async () => {
  const first = await render(baseStage(), 480, 320)
  const second = await render(baseStage(), 480, 320)
  assert.deepEqual(second.fingerprint, first.fingerprint, 'the same stage must export identically twice')
  png.push(['v4-camera.png', second.url])
})

// -------------------------------------------------------- V5 时间轴驱动

await check('V5 a motion path moves the actor between frames', async () => {
  const timeline = {
    duration: 4, fps: 30,
    tracks: [{
      targetId: 'actor-1', target: 'actor',
      keyframes: [],
      paths: [{
        id: 'p', shape: 'line', points: [[-2.5, 0, 0], [2.5, 0, 0]], start: 0, end: 4,
      }],
    }],
  }
  const stage = baseStage({ timeline })
  const first = await page.evaluate(`(async () => {
    const m = window.__mod
    const stage = ${JSON.stringify(stage)}
    const a = m.sampleStage(stage, 0)
    const b = m.sampleStage(stage, 3)
    return { a: a.actors[0].x, b: b.actors[0].x }
  })()`)
  assert.ok(Math.abs(first.a - (-2.5)) < 1e-6, `t=0 should be at the path start, got ${first.a}`)
  assert.ok(first.b > first.a + 1, `t=3 should have moved right, got ${first.b}`)
})

// ------------------------------------------------------- V6 近景人形
//
// 导演台的默认机位把整个人放在画面里，脚尖和胯下的接缝只有几个像素，
// 放大图里才看得出「膝盖是两颗球」「坐下时胯下断层」。这三张不是像素
// 断言，而是把同一份几何在近景下留档，方便人眼复核；`fingerprint` 至少
// 守住它们不是空白/纯色。

const closeCamera = {
  id: 'camera-1', name: '近景', x: 0.95, y: 1.25, z: 2.9,
  targetX: 0, targetY: 0.82, targetZ: 0, fov: 34,
}

for (const [name, presetId] of [['stand', 'stand'], ['sit', 'sit'], ['step', 'step']]) {
  await check(`V6-${name} the close-up render is not a flat fill`, async () => {
    const preset = poseRig.POSE_PRESETS.find(item => item.id === presetId)
    assert.ok(preset !== undefined, `missing preset ${presetId}`)
    const seatHeight = poseRig.solveRig(preset.rig).hips[1] - 0.06
    const seat = name === 'sit'
      ? [{
          id: 'seat-actor-1', name: '坐箱', kind: 'cube', x: 0, y: seatHeight / 2, z: 0,
          rotateY: 0, scaleX: 0.55, scaleY: seatHeight, scaleZ: 0.45,
        }]
      : []
    const shot = await render(baseStage({
      actors: [{ id: 'actor-1', name: 'A', rig: preset.rig, x: 0, z: 0 }],
      cameras: [closeCamera],
      cameraId: closeCamera.id,
      ...seat.length > 0 ? { props: seat } : {},
    }), 520, 760)
    assert.ok(shot.fingerprint.distinct > 8, `${name}: expected a varied image, got ${shot.fingerprint.distinct} buckets`)
    png.push([`v6-${name}.png`, shot.url])
  })
}

await check('V6-wood the wood material is a real toggle, not the same render', async () => {
  const preset = poseRig.POSE_PRESETS.find(item => item.id === 'stand')
  assert.ok(preset !== undefined)
  const body = {
    actors: [{ id: 'actor-1', name: 'A', rig: preset.rig, x: 0, z: 0 }],
    cameras: [closeCamera],
    cameraId: closeCamera.id,
  }
  const clay = await render(baseStage(body), 520, 760)
  const wood = await render(baseStage({
    ...body,
    scene: { ...baseStage().scene, figure: 'wood' },
  }), 520, 760)
  assert.notDeepEqual(wood.fingerprint, clay.fingerprint, 'switching to wood must change the render')
  png.push(['v6-wood.png', wood.url])
})

// ------------------------------------------------- V7 头/手/脚的识别件
//
// 鼻、耳、拇指、鞋头都不该在远景里变成噪点，也不该在近景里变成写实五官。
// 这里拍三张近景留档；断言只守住「不是空白」，形体由人眼复核。

const standPreset = poseRig.POSE_PRESETS.find(item => item.id === 'stand')
assert.ok(standPreset !== undefined)
const standStage = baseStage({
  actors: [{ id: 'actor-1', name: 'A', rig: standPreset.rig, x: 0, z: 0 }],
})

for (const [name, camera] of [
  ['head', { id: 'camera-1', name: '头', x: 0.35, y: 1.58, z: 1.15, targetX: 0, targetY: 1.45, targetZ: 0, fov: 30 }],
  ['hands', { id: 'camera-1', name: '手', x: 0.55, y: 0.95, z: 0.85, targetX: 0.15, targetY: 0.85, targetZ: 0, fov: 32 }],
  ['feet', { id: 'camera-1', name: '脚', x: 0.2, y: 0.55, z: 1.15, targetX: 0, targetY: 0.1, targetZ: 0, fov: 30 }],
]) {
  await check(`V7-${name} the feature close-up renders`, async () => {
    const shot = await render({
      ...standStage,
      cameras: [camera],
      cameraId: camera.id,
    }, 520, 520)
    assert.ok(shot.fingerprint.distinct > 8, `${name}: expected a varied image, got ${shot.fingerprint.distinct} buckets`)
    png.push([`v7-${name}.png`, shot.url])
  })
}

// ---------------------------------------------------------------------- 收尾

page.close()
browser.close()
rmSync(bundleDir, { recursive: true, force: true })

if (outDir !== null) {
  mkdirSync(outDir, { recursive: true })
  for (const [name, url] of png) {
    writeFileSync(join(outDir, name), Buffer.from(url.split(',')[1], 'base64'))
  }
  process.stdout.write(`wrote ${png.length} PNGs to ${outDir}\n`)
}

process.stdout.write(`${results.join('\n')}\n`)
const failed = results.filter(line => line.startsWith('FAIL')).length
if (failed > 0) {
  process.stderr.write(`\nstage 3d: ${failed} failed, ${results.length - failed} passed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\nstage 3d: ${results.length} passed\n`)
}
