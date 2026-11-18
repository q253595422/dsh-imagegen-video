/**
 * 「团团TV」品牌标：中文「团团」跟随主题前景色 + 品牌橙「TV」，无底板。
 *
 * 字形不是字体排版出来的，而是从品牌稿矢量描下来的（「团」描一次、第二个平移复用，
 * T/V 按量得的直线构造），所以换机器、没装中文字体也长得一样。
 *
 * 底色交给所在容器：中文用 `currentColor`，浅色主题下是深字、深色主题下是浅字；
 * 只有 TV 保留品牌橙。所以顶栏里不需要一块黑色卡片托着。
 */
import { useId } from 'react'

/** 单字字面 295×300；「团」的轮廓原样来自品牌稿。 */
const TUAN =
  'M0 151L0 1L148 1L295 1L295 150L295 300L274 300C253 300 253 300 253 294L253 288' +
  'L148 288L42 288L42 294C42 300 42 300 21 300L-0 300L0 151Z' +
  'M254 247C254 244 254 196 253 140L253 38L148 38L42 38L42 145C42 244 42 251 44 251' +
  'C61 255 254 250 254 247Z' +
  'M133 232C131 224 128 216 125 210C123 206 123 206 142 207C167 207 164 212 164 168' +
  'C163 149 163 133 163 133C163 132 160 136 157 141C140 166 106 200 79 216C74 219 ' +
  '74 219 70 214C67 212 61 206 56 202C52 198 47 194 47 194C47 194 47 194 48 193' +
  'C54 191 83 170 96 157C110 145 132 119 132 116C132 115 116 115 96 115L60 114' +
  'L59 97L59 79L111 79L163 79L163 64L163 50L182 50L201 50L201 64L201 79L220 79' +
  'L238 79L238 97L238 115L220 115L201 115L201 162C201 236 200 238 154 240L135 240' +
  'L133 232Z'

/** T + V：品牌稿里量出的直线，不带描迹噪声。 */
const TV =
  'M2 0L199 0L199 47L126 47L126 272L76 272L76 47L2 47Z' +
  'M217 0L269 0L331 190L389 0L442 0L356 272L306 272Z'

const BRAND_ORANGE = '#F8971A'

const CN2_DX = 721 - 382      // 两字间距
const TV_DX = 1049 - 382      // TV 相对首字的横向位置
const TV_DY = 376 - 365       // TV 相对首字的纵向位置

const INK_W = TV_DX + 442     // 1109：首字左沿到 V 右沿
const INK_H = 300             // 字高（「团」比 TV 高）
/** 留一点余量，免得抗锯齿把边缘削掉半个像素。 */
const PAD = 3

const W = INK_W + PAD * 2
const H = INK_H + PAD * 2

export interface BrandMarkProps {
  /** 渲染高度（CSS px）。宽度按字面比例自动。 */
  height?: number
}

/**
 * 行内品牌标。`aria-label` 提供可读名称，不额外输出文字节点——
 * 顶栏里它和 GitHub 图标并排，旁边不需要再重复一遍产品名。
 */
export function BrandMark({ height = 22 }: BrandMarkProps) {
  const uid = useId()
  const tuanId = `${uid}-tuan`
  const tvId = `${uid}-tv`

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ height, width: 'auto', display: 'block', flex: 'none' }}
      role="img"
      aria-label="团团TV"
    >
      <defs>
        <path id={tuanId} d={TUAN} />
        <path id={tvId} d={TV} />
      </defs>
      {/* 「团」跟随容器文字色；两个「团」是同一个字面，只平移复用 */}
      <g fill="currentColor">
        <use href={`#${tuanId}`} transform={`translate(${PAD} ${PAD})`} />
        <use href={`#${tuanId}`} transform={`translate(${PAD + CN2_DX} ${PAD})`} />
      </g>
      <use
        href={`#${tvId}`}
        fill={BRAND_ORANGE}
        transform={`translate(${PAD + TV_DX} ${PAD + TV_DY})`}
      />
    </svg>
  )
}
