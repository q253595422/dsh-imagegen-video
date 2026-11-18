/**
 * 多选时的对齐条：一条浮在底栏上方的 8 枚按钮。
 *
 * WHY 单独一条、而不是塞进底栏：底栏已经 14 格，再加 8 格在任何面板宽度下都
 * 放不下；而且对齐只在**选中两个以上**时才是一个动作——没有选择的时候它是
 * 八枚按不出效果的灰按钮。跟着选择出现、选择变了就消失，比一个常驻入口更
 * 诚实：它出现本身就说明「你现在对齐的是这几张」。
 *
 * 两种按钮的 disabled 语义不同，文案也不同：
 *
 *  - 六个对齐（左/中/右/上/中/下）在选中 ≥2 时永远可点；
 *  - 两个分布要求 ≥3。两个节点之间只有一段空隙，「等间距」没有任何可调的
 *    自由度——放行它会让用户点一个看不出任何变化的按钮，以为功能坏了。
 *
 * 不在这里算坐标：规则全在 `align-model.ts`（有 21 条单测），这里只把点击
 * 转成 `AlignMode` 交出去。算一遍在这里、算一遍在那里，是两个会走散的地方。
 */

import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical,
  AlignHorizontalSpaceAround, AlignStartHorizontal, AlignStartVertical, AlignVerticalSpaceAround,
  type LucideIcon,
} from 'lucide-react'
import { tt } from '../helpers.ts'
import type { ImageGenKey } from '../locales.ts'
import { shortcutKeysFor } from '../ShortcutHelp.tsx'
import type { AlignMode } from './align-model.ts'
import css from '../canvas-workspace.module.css'

interface AlignEntry {
  mode: AlignMode
  icon: LucideIcon
  labelKey: ImageGenKey
  /** 与上一枚之间是否画一条竖线：六个对齐是一组，两个分布是另一组。 */
  dividerBefore?: boolean
}

/**
 * 顺序即按钮顺序：左、中、右 / 上、中、下，然后分布。
 *
 * 图标按「线画在哪一侧」取，不是按名字联想：`AlignStartVertical` 是一条竖线
 * 贴着左缘——LTR 下 start 就是左边。用反了的话，用户按「左对齐」会把卡片排到
 * 右边，而按钮的 tooltip 是对的，错的是眼睛，这种错最难被自己发现。
 */
const ENTRIES: readonly AlignEntry[] = [
  { mode: 'left', icon: AlignStartVertical, labelKey: 'canvas.align.left' },
  { mode: 'centerH', icon: AlignCenterVertical, labelKey: 'canvas.align.centerH' },
  { mode: 'right', icon: AlignEndVertical, labelKey: 'canvas.align.right' },
  { mode: 'top', icon: AlignStartHorizontal, labelKey: 'canvas.align.top' },
  { mode: 'centerV', icon: AlignCenterHorizontal, labelKey: 'canvas.align.centerV' },
  { mode: 'bottom', icon: AlignEndHorizontal, labelKey: 'canvas.align.bottom' },
  { mode: 'distributeH', icon: AlignHorizontalSpaceAround, labelKey: 'canvas.align.distributeH', dividerBefore: true },
  { mode: 'distributeV', icon: AlignVerticalSpaceAround, labelKey: 'canvas.align.distributeV' },
]

const DISTRIBUTE_MIN = 3

export function AlignBar (props: {
  /** 画布上真的被选中的张数（调用方已经剔掉不存在的 id）。 */
  count: number
  onAlign: (mode: AlignMode) => void
}): React.JSX.Element {
  return <div className={css.alignRow}>
    <div
      className={css.alignBar}
      data-align-bar=""
      data-canvas-no-zoom=""
      role="toolbar"
      aria-label={tt('canvas.align.bar', { count: props.count })}
    >
      <span className={css.alignBarLabel}>{tt('canvas.align.bar', { count: props.count })}</span>
      {ENTRIES.map(entry => {
        const distributing = entry.mode === 'distributeH' || entry.mode === 'distributeV'
        // 「为什么按不了」必须写出来：一枚只是灰着、不说原因的按钮，用户会以为
        // 是自己的选择方式不对，然后再试着多选几张。
        const blocked = distributing && props.count < DISTRIBUTE_MIN
        const label = blocked
          ? `${tt(entry.labelKey)} — ${tt('canvas.align.distributeTooFew')}`
          : tt(entry.labelKey)
        // 键位也写进 tooltip：对齐条是多选时才出现的，用户很可能就是在这条上
        // 第一次看见「左对齐」，正是他记键位的时刻。键位表缺席时就只是标题，
        // 不会出现一个空括号。
        // 压暗时不写键位：按下去不会有反应，列出快捷键等于告诉用户「这个能用」。
        const keys = shortcutKeysFor(entry.labelKey)
        const title = blocked || keys === '' ? label : `${label} (${keys})`
        return <span key={entry.mode} className={css.alignBarSlot}>
          {entry.dividerBefore === true ? <span className={css.alignBarDivider} aria-hidden="true" /> : null}
          <button
            type="button"
            className={css.alignBarButton}
            data-align-mode={entry.mode}
            aria-label={label}
            title={title}
            disabled={blocked}
            onClick={() => props.onAlign(entry.mode)}
          ><entry.icon size={16} strokeWidth={1.6} aria-hidden /></button>
        </span>
      })}
    </div>
  </div>
}
