/**
 * 画布几何常量：视口缩放边界、网格、各节点类型默认尺寸、拖入上限。
 *
 * 从 CanvasWorkspace.tsx 原样搬出，数值与注释一字未改——这些数字直接决定
 * 已有画布上节点的观感与拖入行为，任何变化都是可见回归，不是重构。
 */

/** The image picker's tab order, in one place: the render maps it, the arrows index it. */
export const PICKER_TABS = ['upload', 'history', 'gallery', 'generate'] as const

export const MIN_SCALE = 0.05
// 800% 上限：缩放菜单的最高预设（LibTV 同款），滚轮/捏合同样到此为止。
export const MAX_SCALE = 8
export const GRID_SIZE = 48
export const IMAGE_NODE_SIZE = { width: 240, height: 240 }
export const TEXT_NODE_SIZE = { width: 280, height: 150 }
/** File nodes mirror the host runner's footprint so produced files land in a
 *  column that matches hand-made ones. */
export const FILE_NODE_SIZE = { width: 300, height: 170 }
export const CONFIG_NODE_SIZE = { width: 320, height: 190 }
export const LEGACY_CONFIG_NODE_SIZE = { width: 240, height: 96 }
/** Tall enough to show four shot rows without scrolling the node itself: the
 *  rows are the point of the node, and a board that hides its own list would
 *  make the user resize it before they could use it. */
export const STORYBOARD_NODE_SIZE = { width: 380, height: 420 }
/** Sketch boards keep a fixed frame (header + square-ish board + two tool rows)
 *  so the normalized strokes always map onto the same rect. */
export const SKETCH_NODE_SIZE = { width: 300, height: 396 }
export const SKETCH_EXPORT_WIDTH = 1024
export const SKETCH_COLORS = ['#1f2328', '#e03131', '#1971c2', '#2f9e44', '#f59f00', '#9c36b5', '#0ca678', '#f06595']
export const SKETCH_WIDTHS = [3, 6, 12]
/** 取色点按钮的直径，与 SKETCH_WIDTHS 一一对应。 */
export const SKETCH_WIDTH_DOTS = [5, 8, 12]
/** 橡皮擦的命中半径（世界像素），除以画板缩放后使用。 */
export const SKETCH_ERASER_RADIUS = 16

/**
 * Caps for a canvas drop of images.
 *
 * Images take the base64 data-URL path (they double as generation references),
 * so every file is read fully into memory and then re-encoded ~33% larger for
 * the JSON upload. Reading them all at once on a large drop is what made the
 * page seize: a Finder multi-selection of a dozen 20 MB photos queued a dozen
 * concurrent FileReaders plus their data URLs. Both caps exist in the sibling
 * drop paths already (ecommerce: 10 MB / 4 files; file nodes: 50 MB) — the
 * canvas was the one entry that had neither.
 */
export const DROP_IMAGE_MAX_BYTES = 20 * 1024 * 1024
/** Per-drop cap; anything beyond is reported, not silently discarded. */
export const DROP_IMAGE_MAX_COUNT = 20
