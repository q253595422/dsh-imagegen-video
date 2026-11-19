/**
 * 人偶材质的唯一色表。
 *
 * 3D（three.js）与 2D 回退（距离场）必须从同一份颜色取，否则同一台机器
 * 在有没有 WebGL 时会看到两种人偶——那是这个项目以前已经踩过一次的坑。
 *
 * `clay` 不是纯白：纯白在浅色天空/地面上会丢轮廓，也抹平关节。这里用
 * 一档暖灰做身体、再深半档做关节；近景里仍读成白膜，但髋、膝、肘的形体
 * 还在。
 */

import type { CanvasFigureMaterial } from '../../protocol.ts'

export interface FigurePalette {
  /** 身体、四肢、头。 */
  body: string
  /** 关节、铰链——比身体深半档，白膜下也不会糊成一块。 */
  joint: string
  /** 2D 距离场用的 RGB，避免每次从十六进制串里再解析一遍。 */
  bodyRgb: readonly [number, number, number]
}

export const FIGURE_PALETTES: Readonly<Record<CanvasFigureMaterial, FigurePalette>> = {
  clay: {
    body: '#cfd6e2',
    joint: '#b4bdca',
    bodyRgb: [0xcf, 0xd6, 0xe2],
  },
  wood: {
    body: '#d9b483',
    joint: '#a7814f',
    bodyRgb: [0xd9, 0xb4, 0x83],
  },
}

/** 缺省按灰白膜读；只有显式 `wood` 才走木色。 */
export function figureMaterialOf(value: CanvasFigureMaterial | undefined): CanvasFigureMaterial {
  return value === 'wood' ? 'wood' : 'clay'
}

export function figurePaletteOf(value: CanvasFigureMaterial | undefined): FigurePalette {
  return FIGURE_PALETTES[figureMaterialOf(value)]
}
