/**
 * 画布节点模型：节点上携带的数据怎么读、怎么改。
 *
 * 从 CanvasWorkspace.tsx 原样搬出。这一层只认 CanvasNode 的形状——不读 React
 * 状态、不碰 DOM、不发请求，所以任何用到「节点的资产/视频/标注/克隆/尺寸」
 * 的地方都能直接用它，不必先把画布上下文递进来。
 *
 * 硬约束（注释随原代码搬来，别丢）：图片与文件走 `assetOf`，视频片段走
 * `videoOf`，两者之间不做类型转换——片段住在视频库里、按 URL 引用，从不经过
 * 画布资产上传那条路。
 */

import type { CanvasAnnotation, CanvasAssetRef, CanvasDocument, CanvasLayerInfo, CanvasNode, CanvasRect, CanvasVideoRef } from '../../protocol.ts'
import type { ImageGenApi } from '../api.ts'
import { tt } from '../helpers.ts'
import {
  CONFIG_NODE_SIZE, FILE_NODE_SIZE, IMAGE_NODE_SIZE, LEGACY_CONFIG_NODE_SIZE, MAX_SCALE, MIN_SCALE,
  SKETCH_NODE_SIZE, STORYBOARD_NODE_SIZE, TEXT_NODE_SIZE,
} from './constants.ts'
import type { Point } from './geometry.ts'

type ProjectSummary = Awaited<ReturnType<ImageGenApi['canvasList']>>[number]
interface ResizeState {
  nodeId: string
  corner: 'nw' | 'ne' | 'sw' | 'se'
  startX: number
  startY: number
  width: number
  height: number
  x: number
  y: number
  ratio: number | null
}
/** 节点之间允许的最小间距，`freeColumnX` 摆放新列时用。 */
const NODE_GAP = 48
const MIN_NODE_WIDTH = 60
const MIN_NODE_HEIGHT = 64

export function newId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.()
  return `${prefix}-${random ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

export function imageDataUrl(image: { b64: string; mime: string }): string {
  return `data:${image.mime};base64,${image.b64}`
}

export async function assetToDataUrl(asset: CanvasAssetRef): Promise<string> {
  if (asset.url.startsWith('data:')) return asset.url
  const response = await fetch(asset.url)
  if (!response.ok) throw new Error(tt('image.canvasReadFailed'))
  const blob = await response.blob()
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(tt('image.canvasReadFailed')))
    reader.readAsDataURL(blob)
  })
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export function sizeForAsset(asset: CanvasAssetRef): { width: number; height: number } {
  const ratio = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 1
  if (ratio >= 1) return { width: IMAGE_NODE_SIZE.width, height: Math.max(160, Math.round(IMAGE_NODE_SIZE.width / ratio)) }
  return { width: Math.max(200, Math.round(IMAGE_NODE_SIZE.height * ratio)), height: IMAGE_NODE_SIZE.height }
}

/** Node footprint for a generation size ratio such as '1:1' or '16:9'. */
export function nodeSizeFromRatio(size: string | undefined, spec: { width: number; height: number }): { width: number; height: number } {
  const match = /^(\d+):(\d+)$/.exec(size ?? '')
  if (match === null) return { ...spec }
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { ...spec }
  const ratio = width / height
  return ratio >= 1
    ? { width: spec.width, height: Math.max(160, Math.round(spec.width / ratio)) }
    : { width: Math.max(200, Math.round(spec.height * ratio)), height: spec.height }
}

export function nodesBounds(nodes: CanvasNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
  return nodes.reduce((acc, node) => ({
    minX: Math.min(acc.minX, node.x),
    minY: Math.min(acc.minY, node.y),
    maxX: Math.max(acc.maxX, node.x + node.width),
    maxY: Math.max(acc.maxY, node.y + node.height),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
}

/** Enlarge config nodes still stored at the pre-expansion default so the
 * roomier layout applies to existing canvases too. */
export function normalizeConfigNodeSizes(document: CanvasDocument): CanvasDocument {
  const nodes = document.nodes.map(node => node.type === 'config'
    && node.width === LEGACY_CONFIG_NODE_SIZE.width && node.height === LEGACY_CONFIG_NODE_SIZE.height
    ? { ...node, width: CONFIG_NODE_SIZE.width, height: CONFIG_NODE_SIZE.height }
    : node)
  return nodes === document.nodes ? document : { ...document, nodes }
}

export function nodeMetadata(node: CanvasNode): NonNullable<CanvasNode['metadata']> {
  return node.metadata ?? {}
}

/** The single asset carried by an image or file node. */
export function assetOf(node: CanvasNode): CanvasAssetRef | undefined {
  if (node.type === 'image') return nodeMetadata(node).asset
  return node.type === 'file' ? nodeMetadata(node).asset : undefined
}

/**
 * The clip carried by a video node, or undefined.
 *
 * A clip is not a {@link CanvasAssetRef}: it lives in the video store and is
 * referenced by URL, so it never round-trips through the canvas asset upload
 * path. Everything that reads a node's media goes through `assetOf` (images and
 * files) or `videoOf` (clips), never a cast between the two.
 */
export function videoOf(node: CanvasNode): CanvasVideoRef | undefined {
  return node.type === 'video' ? nodeMetadata(node).video : undefined
}

export function usableAsset(node: CanvasNode): CanvasAssetRef | undefined {
  const asset = assetOf(node)
  return asset !== undefined && asset.url !== '' ? asset : undefined
}

export function bezierPath(from: Point, to: Point): string {
  const distance = Math.abs(to.x - from.x)
  const bend = Math.max(distance * 0.5, 50)
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`
}

export function nodeAnchor(node: CanvasNode, side: 'left' | 'right'): Point {
  return { x: side === 'right' ? node.x + node.width : node.x, y: node.y + node.height / 2 }
}

export function isSketchNode(node: CanvasNode): boolean {
  return node.type === 'image' && nodeMetadata(node).sketch !== undefined
}

/** Letterboxed rect of an `object-fit: contain` image inside its container. */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Annotation boxes whose prompt card still exists. */
export function liveAnnotations(node: CanvasNode, nodes: CanvasNode[]): CanvasAnnotation[] {
  const annotations = nodeMetadata(node).annotations ?? []
  return annotations.filter(annotation => annotation.nodeId === undefined || nodes.some(item => item.id === annotation.nodeId))
}

/** Drop annotation boxes whose prompt card was deleted, so image nodes do not
 *  accumulate invisible orphan boxes. */
export function pruneAnnotations(nodes: CanvasNode[], removed: Set<string>): CanvasNode[] {
  if (removed.size === 0) return nodes
  return nodes.map(node => {
    const annotations = nodeMetadata(node).annotations
    if (annotations === undefined || annotations.length === 0) return node
    const kept = annotations.filter(annotation => annotation.nodeId === undefined || !removed.has(annotation.nodeId))
    return kept.length === annotations.length ? node : { ...node, metadata: { ...nodeMetadata(node), annotations: kept } }
  })
}

/** Expand a deletion to the prompt cards attached to the deleted image nodes,
 *  then remove everything and prune the surviving annotation lists. */
export function removeNodesAndCards(nodes: CanvasNode[], requested: Set<string>): { nodes: CanvasNode[]; removed: Set<string> } {
  const removed = new Set(requested)
  for (const node of nodes) {
    if (node.type !== 'image' || !removed.has(node.id)) continue
    for (const annotation of nodeMetadata(node).annotations ?? []) {
      if (annotation.nodeId !== undefined) removed.add(annotation.nodeId)
    }
  }
  return { nodes: pruneAnnotations(nodes.filter(node => !removed.has(node.id)), removed), removed }
}

/** Prompt cards attached to an image node's annotation boxes, in box order. */
export function attachedCards(image: CanvasNode, nodes: CanvasNode[]): CanvasNode[] {
  if (image.type !== 'image') return []
  return liveAnnotations(image, nodes).flatMap(annotation => {
    if (annotation.nodeId === undefined) return []
    const card = nodes.find(node => node.id === annotation.nodeId)
    return card === undefined ? [] : [card]
  })
}

/** Is this node one of the prompt cards the 标注 tool hangs off an image? */
export function isAnnotationCard(node: CanvasNode): boolean {
  return node.type === 'text' && nodeMetadata(node).annotation !== undefined
}

/** World-space anchor of an annotation box (its right edge, vertically centred). */
export function annotationAnchor(image: CanvasNode, rect: CanvasRect): Point {
  return {
    x: image.x + (rect.x + rect.width) * image.width,
    y: image.y + (rect.y + rect.height / 2) * image.height,
  }
}

/** Clone a set of nodes plus the prompt cards attached to any cloned image
 *  node, remapping every attachment link to the copies. */
export function cloneNodesWithCards(source: CanvasNode[], allNodes: CanvasNode[], dx: number, dy: number): { clones: CanvasNode[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>()
  const clones: CanvasNode[] = []
  const push = (node: CanvasNode, metadata: CanvasNode['metadata']): void => {
    const id = newId('node')
    idMap.set(node.id, id)
    clones.push({ ...node, id, x: Math.round(node.x + dx), y: Math.round(node.y + dy), metadata: metadata ?? { ...nodeMetadata(node) } })
  }
  for (const node of source) push(node, undefined)
  for (const node of source) {
    if (node.type !== 'image') continue
    for (const card of attachedCards(node, allNodes)) {
      if (idMap.has(card.id)) continue
      const metadata = nodeMetadata(card)
      const annotation = metadata.annotation
      push(card, {
        ...metadata,
        ...annotation === undefined ? {} : { annotation: { ...annotation, sourceNodeId: idMap.get(annotation.sourceNodeId) ?? annotation.sourceNodeId } },
      })
    }
  }
  for (const clone of clones) {
    const annotations = clone.type === 'image' ? nodeMetadata(clone).annotations : undefined
    if (annotations === undefined) continue
    clone.metadata = {
      ...nodeMetadata(clone),
      annotations: annotations.map(annotation => annotation.nodeId !== undefined && idMap.has(annotation.nodeId)
        ? { ...annotation, nodeId: idMap.get(annotation.nodeId) }
        : annotation),
    }
  }
  return { clones, idMap }
}

/** New geometry for a corner drag, keeping the opposite corner pinned. */
export function resizedRect(resize: ResizeState, clientDx: number, clientDy: number, scale: number): { x: number; y: number; width: number; height: number } {
  const dx = clientDx / scale
  const dy = clientDy / scale
  const east = resize.corner === 'ne' || resize.corner === 'se'
  const south = resize.corner === 'sw' || resize.corner === 'se'
  let width = Math.max(MIN_NODE_WIDTH, resize.width + (east ? dx : -dx))
  let height = Math.max(MIN_NODE_HEIGHT, resize.height + (south ? dy : -dy))
  if (resize.ratio !== null) {
    // Aspect-locked (images): follow whichever axis the pointer moved further,
    // so dragging sideways or downwards both scale the picture.
    const fromWidth = width
    const fromHeight = height / resize.ratio
    width = Math.abs(fromWidth - resize.width) >= Math.abs(fromHeight - resize.width) ? fromWidth : fromHeight
    width = Math.max(MIN_NODE_WIDTH, width)
    height = Math.max(MIN_NODE_HEIGHT, width * resize.ratio)
  }
  return {
    x: Math.round(east ? resize.x : resize.x + (resize.width - width)),
    y: Math.round(south ? resize.y : resize.y + (resize.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/** Localized layer-kind badge label. */
export function layerKindLabel(kind: CanvasLayerInfo['kind']): string {
  return kind === 'background' ? tt('canvas.layerKindBackground') : kind === 'object' ? tt('canvas.layerKindObject') : tt('canvas.layerKindText')
}

/** Left edge of a free vertical band beside `source`, so a freshly created
 *  column of nodes never lands on top of existing ones. */
export function freeColumnX(source: CanvasNode, nodes: CanvasNode[], columnHeight: number, columnWidth: number): number {
  let x = source.x + source.width + NODE_GAP
  for (let guard = 0; guard < 24; guard += 1) {
    const clash = nodes.filter(node => node.id !== source.id
      && x < node.x + node.width + 24 && x + columnWidth > node.x - 24
      && source.y < node.y + node.height + 24 && source.y + columnHeight > node.y - 24)
    if (clash.length === 0) break
    x = Math.max(...clash.map(node => node.x + node.width)) + 48
  }
  return Math.round(x)
}

/** Inline style for a text node's content, honoring size/color/weight. */
export function textStyleOf(node: CanvasNode): { fontSize: number; color?: string; fontWeight?: number } {
  const metadata = nodeMetadata(node)
  const fontSize = typeof metadata.fontSize === 'number' && metadata.fontSize > 0 ? metadata.fontSize : 13
  return {
    fontSize: Math.min(96, Math.max(8, fontSize)),
    ...metadata.color === undefined || metadata.color === '' ? {} : { color: metadata.color },
    ...metadata.bold === true ? { fontWeight: 700 } : {},
  }
}
