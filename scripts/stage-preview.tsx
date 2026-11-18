/**
 * 导演台全屏面板的视觉验收入口。
 *
 * 渲染的是**真的** `PoseStagePanel`：真时间轴、真关键帧、真轨迹、真 CSS Module、
 * 真主题 token。只有宿主被替换成内存里的一个 state——因为这个入口要回答的唯一
 * 问题是「这块 UI 长什么样、排得对不对」，不是「写盘通不通」。
 *
 * 为什么不并进 `studio-preview.tsx`：那个入口渲染的是生图面板与侧边栏，它的
 * stub 主机回答的是生成请求；导演台需要的是一份带时间轴的舞台文档，两边共用
 * 一个入口只会让彼此都变复杂。两个入口共用同一份 tsdown 客户端配置
 * （`studio-preview.config.ts`），所以 CSS Module 与主题变量的行为一致。
 *
 * Build: `pnpm stage:preview` → `.studio-stage/stage.js`
 * 页面外壳由 `scripts/stage-preview-shot.mjs` 提供。
 */

import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { PoseStagePanel, setStageViewRenderer } from '../src/client/canvas/pose-stage-panel.tsx'
import { emptyStageTimeline, putKeyframe, putPath } from '../src/client/canvas/stage-timeline.ts'
import type { CanvasPoseStage } from '../src/protocol.ts'

/**
 * 一份「已经在用」的舞台：两个角色、两台机位、一条 6 秒时间轴、一条圆形轨迹、
 * 两个关键帧。
 *
 * 空舞台也能渲染，但它验不出这件东西的价值——时间轴上没有轨道、没有关键帧
 * 菱形、轨迹段是空的，看起来就像一个没做完的面板。这份数据是为了让截图里
 * **每一块区域都有内容**。
 */
function demoStage(): CanvasPoseStage {
  const base: CanvasPoseStage = {
    actors: [
      { id: 'actor-a', name: '角色A', rig: { joints: {}, facing: 0 }, x: -1.1, z: 0, scale: 1, rotation: 0 },
      { id: 'actor-b', name: '角色B', rig: { joints: {}, facing: Math.PI }, x: 1.2, z: -0.4, scale: 1, rotation: Math.PI },
    ],
    cameras: [
      { id: 'camera-main', name: '主机位', x: 3.4, y: 1.9, z: 4.2, targetX: 0, targetY: 0.95, targetZ: 0, fov: 38 },
      { id: 'camera-two', name: '机位二', x: -3.8, y: 1.4, z: 2.6, targetX: 0, targetY: 1, targetZ: 0, fov: 46 },
    ],
    cameraId: 'camera-main',
    scene: {
      sky: '#1b2030',
      ground: '#2a3340',
      translate: [0, 0, 0],
      rotate: [0, 0, 0],
      rotateY: 0,
      scale: 100,
      panoYaw: 0,
      panoRadius: 20,
      labels: true,
    },
    props: [
      { id: 'prop-box', name: '箱子', kind: 'cube', x: 1.6, y: 0.35, z: 1.1, rotateX: 0, rotateY: 18, rotateZ: 0, scaleX: 0.7, scaleY: 0.7, scaleZ: 0.7 },
      { id: 'prop-ball', name: '球', kind: 'sphere', x: -1.7, y: 0.3, z: 1.4, rotateX: 0, rotateY: 0, rotateZ: 0, scaleX: 0.6, scaleY: 0.6, scaleZ: 0.6 },
    ],
    timeline: { ...emptyStageTimeline(), duration: 6 },
  }
  // `putKeyframe` / `putPath` 收的是**时间轴**、返回的也是时间轴，不是整份舞台。
  // 早先直接把 stage 传进去，得到 `timeline.tracks` undefined 而报
  // `Cannot read properties of undefined (reading 'find')`——报错行在 `trackOf`
  // 里，看起来像时间轴的错，实际是参数传错了层。
  let timeline = base.timeline ?? emptyStageTimeline()
  // 角色A：0 秒在原位、3 秒走到台前、6 秒转身。
  timeline = putKeyframe(timeline, 'actor', 'actor-a', { at: 0, position: [-1.1, 0, 0], facing: 0 })
  timeline = putKeyframe(timeline, 'actor', 'actor-a', { at: 3, position: [0.2, 0, 0.6], facing: 0.5 })
  timeline = putKeyframe(timeline, 'actor', 'actor-a', { at: 6, position: [0.2, 0, 0.6], facing: 2.6 })
  // 机位：从侧面推过去。
  timeline = putKeyframe(timeline, 'camera', 'camera-main', {
    at: 0,
    camera: { x: 3.4, y: 1.9, z: 4.2, targetX: 0, targetY: 0.95, targetZ: 0, fov: 38 },
  })
  timeline = putKeyframe(timeline, 'camera', 'camera-main', {
    at: 6,
    camera: { x: 1.2, y: 1.6, z: 3.4, targetX: 0, targetY: 1, targetZ: 0, fov: 34 },
  })
  // 角色B 绕一圈。
  timeline = putPath(timeline, 'actor', 'actor-b', {
    id: 'path-orbit',
    shape: 'circle',
    points: [[0, 0, 0], [1.4, 0, 1.4]],
    start: 1,
    end: 5,
    height: 0,
    orient: true,
  })
  return { ...base, timeline }
}

function StagePreview(): React.ReactElement {
  const [stage, setStage] = useState<CanvasPoseStage>(demoStage)
  const [progress, setProgress] = useState<number | null>(null)
  // 预览里没有宿主，导出跑到 100% 就停在进度条上——这正是要看的那个状态。
  const startExport = (): void => {
    if (progress !== null) return
    setProgress(0)
    const timer = window.setInterval(() => {
      setProgress(current => {
        if (current === null) return null
        if (current >= 0.99) { window.clearInterval(timer); return 1 }
        return Math.min(1, current + 0.07)
      })
    }, 90)
  }

  return <PoseStagePanel
    stage={stage}
    onStageChange={setStage}
    pano={null}
    // 截图结果挂到 window 上给验收脚本取：这一步要验的正是「点了机位截图之后
    // 到底交出来一张什么图」，回调丢成空函数的话这条路径在验收里等于不存在。
    onCapture={dataUrl => { (window as unknown as { __stageCapture?: string }).__stageCapture = dataUrl }}
    onPrompt={() => {}}
    videoExportable={stage.timeline !== undefined}
    videoExportProgress={progress}
    onExportVideo={startExport}
    onCancelVideoExport={() => setProgress(null)}
    container={document.body}
    onClose={() => setProgress(null)}
    onError={message => { console.error(message) }}
  />
}

// 3D 渲染层不在这里接：预览页故意用内置 2D 画布，这样这个入口只验布局与控件，
// 不把「这台机器有没有 WebGL」掺进视觉验收里。3D 由 `verify-stage-3d.mjs` 单独验。
setStageViewRenderer(null)

const root = document.getElementById('root')
if (root === null) throw new Error('the preview page is missing #root')
createRoot(root).render(<StagePreview />)
