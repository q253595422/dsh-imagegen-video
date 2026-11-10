/**
 * 画布几何：拖拽吸附与「节点被完全盖住」的判定。
 *
 * 从 CanvasWorkspace.tsx 原样搬出：纯函数，只吃节点坐标，不碰视图状态、
 * 不碰 DOM，所以能单独验证。逻辑与注释一字未改。
 */

import type { CanvasNode } from '../../protocol.ts'

export type Point = { x: number; y: number }

/** How close (in screen pixels) an edge must come before a drag snaps to it. */
export const SNAP_SCREEN_PX = 8

/**
 * Snap correction for a drag in progress.
 *
 * Tests the moved node's left/centre/right (and top/middle/bottom) against the
 * same three lines of every node that is not being dragged, and returns the
 * smallest shift that brings a pair within `threshold` world pixels. Edges
 * against edges covers both alignment and edge-to-edge adjacency.
 */
export function snapOffset(
  primary: CanvasNode,
  others: readonly CanvasNode[],
  dx: number,
  dy: number,
  threshold: number,
): Point {
  const left = primary.x + dx
  const top = primary.y + dy
  const xs = [left, left + primary.width / 2, left + primary.width]
  const ys = [top, top + primary.height / 2, top + primary.height]
  let bestX = 0
  let bestY = 0
  let nearestX = threshold + 1
  let nearestY = threshold + 1
  for (const other of others) {
    for (const target of [other.x, other.x + other.width / 2, other.x + other.width]) {
      for (const edge of xs) {
        const delta = target - edge
        if (Math.abs(delta) <= nearestX) { nearestX = Math.abs(delta); bestX = delta }
      }
    }
    for (const target of [other.y, other.y + other.height / 2, other.y + other.height]) {
      for (const edge of ys) {
        const delta = target - edge
        if (Math.abs(delta) <= nearestY) { nearestY = Math.abs(delta); bestY = delta }
      }
    }
  }
  return { x: Math.abs(bestX) > threshold ? 0 : bestX, y: Math.abs(bestY) > threshold ? 0 : bestY }
}

/** 一个被完全盖住的节点，以及盖住它的那个节点。 */
export interface OverlapPair {
  coveredId: string
  coverId: string
}

/**
 * 找出被另一个节点完全盖住的节点，只在涉及 `moving` 时报告。
 *
 * WHY 只报「完全被盖住」：部分重叠在画布上是常态（节点挨着摆、标注卡片压住图片
 * 边缘），提示它只会变成噪音。真正让人卡住的是被完全罩住的那一个——屏幕上看不见
 * 它，框选也选不到，用户会以为节点丢了。
 *
 * WHY 要求涉及 `moving`：两块静止的节点重叠是历史数据，每次载入都描红会变成甩不
 * 掉的报错；而用户正拖着的那一个，才是他此刻需要知道的。
 *
 * 面积相同时用 id 定唯一方向，否则同一对节点会互为主从、提示来回闪。
 */
export function coveredNodes(nodes: readonly CanvasNode[], moving: ReadonlySet<string>): OverlapPair[] {
  const pairs: OverlapPair[] = []
  for (const node of nodes) {
    for (const cover of nodes) {
      if (cover.id === node.id) continue
      const inside = cover.x <= node.x
        && cover.y <= node.y
        && cover.x + cover.width >= node.x + node.width
        && cover.y + cover.height >= node.y + node.height
      if (!inside) continue
      if (cover.width === node.width && cover.height === node.height && cover.id < node.id) continue
      if (!moving.has(node.id) && !moving.has(cover.id)) continue
      pairs.push({ coveredId: node.id, coverId: cover.id })
    }
  }
  return pairs
}
