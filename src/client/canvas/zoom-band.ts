/**
 * 缩放分档：画布在不同缩放下「该长什么样」的判定。
 *
 * WHY 需要这个模块，而不是在 CSS 里写个 `@media`：CSS 看不到 `viewport.k`。
 * 画布的缩放是 react-flow 打在 `.world` 上的一条 `transform`，媒体查询对它
 * 一无所知，所以「缩到 17% 时节点几乎看不见」这件事在样式表里根本无法表达。
 * 判定必须是一个能脱离 DOM 被单测的数字问题，于是抽成这里三个纯函数：
 * 分档、网格步长、描边补偿。
 *
 * 为什么是这三件事，而不是「整体放大」：把整块内容等比放大等于用户自己按
 * 了缩放键，那不是渲染问题。真正在低缩放下坏掉的是三样**不该跟着内容一起
 * 缩小**的东西——节点的边界（1.5px 乘 0.17 只剩 0.26px，等于没有）、
 * 网格（48×0.17≈8px，变成一层噪点纱）、以及主次对比（浅色主题下白卡片
 * 摞在白画布上，100% 时靠内容区分，17% 时内容糊成一片，卡片就凭空了）。
 *
 * 这个文件不 import React、不碰 DOM，可以直接被 `smoke-canvas-geometry.mjs`
 * 跑。
 */

/** 低缩放下节点相对于画布的填充量（用于分档阈值与网格下限）。 */
export const GRID_MIN_SCREEN_PX = 16

/**
 * 分档阈值。
 *
 * `FAR` 取 0.25：这是「一张 240px 的图节点在屏幕上不足 60px，缩略图开始
 * 比它本身更可读」的位置。`NEAR` 取 0.6：240px 的卡片在 144px 时细节仍在，
 * 只是字变小，还不需要为概览让位。
 */
export const ZOOM_NEAR = 0.6
export const ZOOM_FAR = 0.25

/** `near` 看细节，`mid` 看结构，`far` 看版图。 */
export type ZoomBand = 'near' | 'mid' | 'far'

export function zoomBandOf(scale: number): ZoomBand {
  // 非有限值、0、负数都当 near：宁可不动样式，也不要在一次异常的视野写入后
  // 把整块画布切成「概览模式」且再也切不回来。0 尤其要挡——它是一次除法的
  // 典型残留，而 `scale < ZOOM_FAR` 对 0 成立，会把画布锁进 far 档。
  if (!Number.isFinite(scale) || scale <= 0 || scale >= ZOOM_NEAR) return 'near'
  return scale < ZOOM_FAR ? 'far' : 'mid'
}

/**
 * 网格步长（世界像素）。
 *
 * 基准是 `GRID_SIZE`；缩得越小，世界步长翻倍再翻倍，直到屏幕上的格距不低于
 * `GRID_MIN_SCREEN_PX`。这就是地图软件画经纬网的做法：世界尺子不变，取一个
 * 跟当前缩放匹配的刻度，而不是让刻度本身缩到看不见。
 *
 * 返回的 `size` 是**屏幕**像素（`step * k`），调用方直接拿去当
 * `background-size`；`step` 是它在世界里的等价值，留给断言和需要世界坐标的
 * 地方。
 */
export function gridStepFor(scale: number, base: number): { step: number; size: number } {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1
  let step = base
  // 上限 64 级别（48 → 3072）：再往上一次翻倍就要让格线消失，那不叫网格了。
  for (let guard = 0; guard < 6 && step * k < GRID_MIN_SCREEN_PX; guard += 1) step *= 2
  return { step, size: step * k }
}

/**
 * 描边补偿系数：让卡片轮廓在屏幕上恒定 1.5px。
 *
 * 世界里的 1px 经过 `scale(k)` 之后只剩 k 个屏幕像素，所以要除以 k。
 *
 * ⚠️ 补偿只能作用在**不进布局**的属性上（`box-shadow` / `outline`），绝不能
 * 拿去放大 `border-width`：卡片外框尺寸是文档里的 `node.width`，而连线锚点、
 * 吸附、缩略图投影全部按它算。把边框按 1/k 加粗会让卡片的世界外框在低缩放下
 * 每边涨几个像素，这些几何就静默错位——看得见的是「线没接上」，看不见的是
 * 几何算错了。
 *
 * 上限 8：k=0.125 时补偿后的轮廓已是 12 个世界像素宽，再往下两张相邻卡片的
 * 轮廓会互相咬住，读起来是一块而不是两张。
 */
export function invScaleFor(scale: number): number {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1
  return Math.min(1 / k, 8)
}
