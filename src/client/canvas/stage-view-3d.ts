/**
 * 把 three.js 的 {@link StageScene} 接到面板的 {@link StageViewRenderer} 上。
 *
 * 为什么需要这一层：面板与渲染器之间只认 `paint(input)` / `pick(input)` 两个
 * 方法（见 `pose-stage-panel.tsx` 的 `StageViewRenderer`），而 three 版场景是
 * 「先建一次、之后每帧只更新变换」的长生命周期对象。两者的形状不一样，中间
 * 必须有东西记住「这块 canvas 已经建过场景了」，否则每次 React 重绘都会新建
 * 一个 WebGL 上下文，几帧之后浏览器就把旧的丢掉——表现为面板打开一会儿变白。
 *
 * 这个文件与 `stage-scene-3d.ts` 一样是 three 渲染层的入口：面板自己只 import
 * 它（换实现只改这里），但「生成参考图」与导出视频都直接调
 * `renderStageToDataUrl`——导出必须和视口是同一份渲染，绕一层反而会分叉。
 */

// 显式 `.tsx`：目标是 TSX 文件，写成 `.ts` 时打包器与 `verify-tracked` 都会
// 去找一个不存在的 `pose-stage-panel.ts`（那里只有一个 `.tsx`）。
import type { StageViewInput, StageViewRenderer, StagePickInput, StageHit } from './pose-stage-panel.tsx'
import type { CanvasPoseStage } from '../../protocol.ts'
import type { StageScene } from './stage-scene-3d.ts'
import { createStageScene } from './stage-scene-3d.ts'

/**
 * 一块 canvas 对应一个场景。
 *
 * 用 `WeakMap` 而不是挂在 DOM 元素的自定义属性上：面板卸载后 canvas 会被回收，
 * 这个条目跟着消失，不需要谁记得来清。挂在元素上则会在「关掉面板、再打开」
 * 的路径里留下一个指向上一个上下文的引用。
 */
const scenes = new WeakMap<HTMLCanvasElement, StageScene>()

/** 已经报警过的 canvas，避免 60fps 每帧刷一条同样的 console。 */
const warned = new WeakSet<HTMLCanvasElement>()

function sceneFor(canvas: HTMLCanvasElement): StageScene | null {
  const existing = scenes.get(canvas)
  if (existing !== undefined) return existing
  try {
    const scene = createStageScene(canvas)
    scenes.set(canvas, scene)
    return scene
  } catch (error) {
    // 没有 WebGL 的机器（老 GPU、被策略禁掉、远程桌面）不该连面板一起白掉。
    // 报一次，然后让面板退回 2D——那个渲染器不依赖 GPU。
    if (!warned.has(canvas)) {
      warned.add(canvas)
      console.warn('[stage] 3D 视口不可用，退回 2D 渲染：', error)
    }
    return null
  }
}

export interface Stage3DRenderer {
  /** 面板用的渲染器。3D 建不起来时它会**转发给** `fallback`。 */
  renderer: StageViewRenderer
  /** 面板卸载时调用，释放 WebGL 上下文。 */
  dispose(): void
}

/**
 * 造一个 3D 渲染器。
 *
 * @param fallback 这台机器没有 WebGL 时用的渲染器；通常是面板内置的 2D 实现。
 */
export function createStage3DRenderer(fallback: StageViewRenderer): Stage3DRenderer {
  // 已经建好、并且成功过的那块 canvas：`paint` 里靠它判断「这次要不要走 2D」。
  // 存成变量而不是查 `scenes`，是因为失败过的 canvas 也在 `warned` 里但不在
  // `scenes` 里，两者要区分开。
  let live: HTMLCanvasElement | null = null

  const renderer: StageViewRenderer = {
    paint(input: StageViewInput): void {
      const scene = sceneFor(input.canvas)
      if (scene === null) {
        fallback.paint(input)
        return
      }
      live = input.canvas
      // 尺寸可能每帧都不同（面板展开、侧栏收起、窗口 resize），而 `setSize`
      // 内部只在不相等时才重建缓冲区，所以无条件调是安全的。
      scene.setSize({ width: Math.round(input.size), height: Math.round(input.size) })
      scene.setMode(input.mode)
      scene.setPanorama(input.pano)
      // `stage` 已经过 `sampleStage()`，渲染器不认识时间轴——这个边界和导出
      // 路径共用，两条路画出来的才是同一帧。
      scene.render(input.stage)

      // 辅助线（关节标记、视锥）现在只有 2D 版画。3D 里这些是场景中的实体
      // 对象，开关它们要动渲染层；在补上之前，导出（guides=false）与预览
      // （guides=true）在 3D 下看起来一样——这里如实留着这个差别，不假装。
      void input.guides
      void input.draft
    },
    pick(input: StagePickInput): StageHit | null {
      // 用 `live` 而不是 `sceneFor`：鼠标事件可能在场景还没画过一帧时到达
      // （面板刚挂载），那条路径该交给 fallback，而不是在这里又建一个上下文。
      const canvas = live
      if (canvas === null) return fallback.pick(input)
      const scene = scenes.get(canvas)
      if (scene === undefined) return fallback.pick(input)
      const hit = scene.pick(input.x, input.y)
      if (hit === null) return null
      // 面板的命中类型只有三种；three 那边多一个 `object`（地面/网格等）。
      // 多出来的那种对面板没有意义——它不参与选择，直接当没点中。
      return hit.target === 'object' ? null : { kind: hit.target, id: hit.id }
    },
    /**
     * 拖动、滚轮、重置这三个手势必须转发给场景。
     *
     * 面板只认 `paint` / `pick` 时，拖动改的是面板自己的 `view` state，而
     * 那份 state 没有任何消费方——**拖动在 3D 下什么都不做**。场景那边
     * `orbit()` / `zoom()` / `resetView()` 早就写好了，缺的只是这层转发。
     */
    orbit(deltaX: number, deltaY: number): void {
      if (live === null) return
      scenes.get(live)?.orbit(deltaX, deltaY)
    },
    zoom(factor: number): void {
      if (live === null) return
      scenes.get(live)?.zoom(factor)
    },
    resetView(stage: CanvasPoseStage): void {
      if (live === null) return
      scenes.get(live)?.resetView(stage)
    },
  }

  return {
    renderer,
    dispose(): void {
      if (live !== null) {
        scenes.get(live)?.dispose()
        scenes.delete(live)
      }
      live = null
    },
  }
}
