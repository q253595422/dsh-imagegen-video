/**
 * 连线层：节点之间的持久边、拖拽中的预览边、技能运行边。
 *
 * 从 CanvasWorkspace.tsx 的 `renderConnections` 搬出（原 101 行内联 JSX）。
 * 搬动不改行为，只把「怎么画一条边」从组件状态里分离出来：这个文件只吃
 * props，不接受任何画布状态，因此连线的样子可以脱离组件推敲。
 *
 * 三条边的区别（别合并——它们的存在条件不同）：
 *
 *  - 持久边 `document.connections`：会存盘。`connectionsHidden` 只藏它。
 *  - 拖拽预览 `connecting`：正在进行的动作，不藏，也不能不画——用户靠它
 *    判断「现在往哪连」。
 *  - 技能运行边 `skillRuns`：任务跑完之前长出来的临时边，指向那张运行卡片。
 *
 * 隐藏连线时仍然画后两种，是刻意的：把正在进行的动作藏起来，用户会以为
 * 拖拽没反应、技能卡跑丢了。
 */

import type {
  CanvasConnection,
  CanvasConnectionRole,
  CanvasNode,
} from '../../protocol.ts'
import type { Point } from './geometry.ts'
import { bezierPath, isAnnotationCard, nodeAnchor } from './node-model.ts'
import { roleBadgeKey, roleOf } from './connection-role.ts'
import { WORLD_PAD } from './constants.ts'
import type { SkillRunTrace } from './run-card.tsx'
import { tt } from '../helpers.ts'
import css from '../canvas-workspace.module.css'

/** 拖拽中的连线状态，与 CanvasWorkspace 里那份 `ConnectState` 同形。 */
export interface ConnectionDraft {
  nodeId: string
  handleType: 'source' | 'target'
  mouse: Point
  targetId: string | null
}

export interface ConnectionLayerProps {
  /** 已存盘的连线。`null` 表示画布还没载入。 */
  connections: readonly CanvasConnection[] | null
  /** 节点索引：连线的两端都靠它解析。缺失的一端直接不画。 */
  nodeById: ReadonlyMap<string, CanvasNode>
  /** 视图开关：只藏持久边。 */
  hidden: boolean
  selectedConnectionId: string | null
  /** 拖拽中的预览边；`null` 表示没有在连。 */
  draft: ConnectionDraft | null
  /** 正在跑的技能任务：每个未开始/进行中的任务一条边。 */
  skillRuns: Readonly<Record<string, SkillRunTrace>>
  onSelect: (connectionId: string) => void
  /** 右键一条边时把菜单位置交回给调用方。 */
  onContextMenu: (connectionId: string, screen: Point) => void
}

/**
 * 连线层。
 *
 * 「哪些边要画」这件事在这里定：两端节点都在、且都不是标注卡。标注卡的
 * 边是历史遗留（早先版本把卡片接进图里），现在卡片附着在图片上、由
 * `AnnotationLinkLayer` 单独画引线，所以这里必须排除它——否则同一根线会画
 * 两遍，一根跟着节点、一根不跟。
 */
export function ConnectionLayer({
  connections,
  nodeById,
  hidden,
  selectedConnectionId,
  draft,
  skillRuns,
  onSelect,
  onContextMenu,
}: ConnectionLayerProps): React.JSX.Element {
  const visible = hidden ? [] : (connections ?? []).filter(connection => {
    const from = nodeById.get(connection.fromNodeId)
    const to = nodeById.get(connection.toNodeId)
    if (from === undefined || to === undefined) return false
    return !isAnnotationCard(from) && !isAnnotationCard(to)
  })

  const gradientOf = (connection: CanvasConnection): React.JSX.Element => {
    const from = nodeById.get(connection.fromNodeId)!
    const to = nodeById.get(connection.toNodeId)!
    const start = nodeAnchor(from, 'right')
    const end = nodeAnchor(to, 'left')
    return <linearGradient
      key={connection.id}
      id={`conn-g-${connection.id}`}
      gradientUnits="userSpaceOnUse"
      x1={start.x} y1={start.y} x2={end.x} y2={end.y}
    >
      <stop offset="0" stopColor="var(--dsw-alias-brand-primary)" stopOpacity="0.08" />
      <stop offset="0.7" stopColor="var(--dsw-alias-brand-primary)" stopOpacity="0.4" />
      <stop offset="1" stopColor="var(--dsw-alias-brand-primary)" stopOpacity="0.85" />
    </linearGradient>
  }

  /**
   * 贝塞尔中点：cubic 在 t=0.5 处就是 (P0 + 3·P1 + 3·P2 + P3) / 8。
   * 控制点与 `bezierPath` 保持同一套算法——两边各算一次比让 bezierPath
   * 多返回一个对象更省事，但改一处必须改另一处，否则徽标会飘离线。
   */
  const midPointOf = (from: CanvasNode, to: CanvasNode): Point => {
    const start = nodeAnchor(from, 'right')
    const end = nodeAnchor(to, 'left')
    const bend = Math.max(Math.abs(end.x - start.x) * 0.5, 50)
    const c1 = { x: start.x + bend, y: start.y }
    const c2 = { x: end.x - bend, y: end.y }
    return {
      x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
      y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
    }
  }

  return <svg
    className={css.connectionLayer}
    width={WORLD_PAD * 2}
    height={WORLD_PAD * 2}
    style={{ left: -WORLD_PAD, top: -WORLD_PAD }}
    aria-hidden="true"
  >
    <defs>
      <marker id="conn-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
        <path d="M 0 1.6 L 8.4 5 L 0 8.4 Z" fill="color-mix(in srgb, var(--dsw-alias-brand-primary) 62%, transparent)" />
      </marker>
      <marker id="conn-arrow-active" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
        <path d="M 0 1.6 L 8.4 5 L 0 8.4 Z" fill="var(--dsw-alias-brand-primary)" />
      </marker>
      {/* 角色边的箭头降一档：它们不是默认路径，抢不过默认连线。 */}
      <marker id="conn-arrow-role" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 1.6 L 8.4 5 L 0 8.4 Z" fill="color-mix(in srgb, var(--dsw-alias-brand-primary) 78%, transparent)" />
      </marker>
      {visible.map(gradientOf)}
    </defs>
    <g transform={`translate(${WORLD_PAD},${WORLD_PAD})`}>
      {visible.map(connection => {
        const from = nodeById.get(connection.fromNodeId)!
        const to = nodeById.get(connection.toNodeId)!
        const path = bezierPath(nodeAnchor(from, 'right'), nodeAnchor(to, 'left'))
        const active = connection.id === selectedConnectionId
        const role: CanvasConnectionRole = roleOf(connection)
        // 未标注角色的连线走原来那三个 path，属性一个都不改：老画布看起来
        // 必须和加这个功能之前**完全一样**，否则等于偷偷改了所有人的画布。
        const decorated = role !== 'input'
        const badge = roleBadgeKey(role)
        const roleClass = role === 'first' ? css.connectionRoleFirst
          : role === 'last' ? css.connectionRoleLast
            : role === 'reference' ? css.connectionRoleReference
              : ''
        const dotAt = role === 'first' ? nodeAnchor(from, 'right')
          : role === 'last' ? nodeAnchor(to, 'left')
            : undefined
        return <g key={connection.id}>
          {/* 透明的粗线只用来接指针：细线上的点击几乎点不中。 */}
          <path
            data-connection-hit={connection.id}
            d={path}
            stroke="transparent"
            strokeWidth={16}
            fill="none"
            style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
            onPointerDown={event => { event.stopPropagation(); onSelect(connection.id) }}
            onContextMenu={event => {
              event.preventDefault(); event.stopPropagation()
              onSelect(connection.id)
              onContextMenu(connection.id, { x: event.clientX, y: event.clientY })
            }}
          />
          <path
            d={path}
            stroke={`url(#conn-g-${connection.id})`}
            className={[css.connectionPath, decorated ? roleClass : '', active ? css.connectionActive : ''].filter(Boolean).join(' ')}
            markerEnd={decorated
              ? active ? 'url(#conn-arrow-active)' : 'url(#conn-arrow-role)'
              : active ? 'url(#conn-arrow-active)' : 'url(#conn-arrow)'}
          />
          {/* 一条柔和的光带沿着路径流动（从源到目标）。参考图只送素材、不占
              帧位，用更弱的一条，一眼能看出它不是决定成片的那条边。 */}
          <path d={path} className={`${css.connectionFlow} ${active ? css.connectionFlowActive : ''} ${role === 'reference' ? css.connectionFlowMuted : ''}`} />
          {/* 首/尾帧在「哪一端进门」处画实心点：箭头说方向，圆点说这一端被
              当成帧用。虚线 + 无圆点 = 参考图。 */}
          {dotAt !== undefined ? <circle cx={dotAt.x} cy={dotAt.y} r={4.5} className={css.connectionRoleDot} /> : null}
          {badge !== undefined ? (() => {
            const mid = midPointOf(from, to)
            // 不做药丸底：底框宽度要靠字体度量去猜，而中文 11px 一个字、西里尔
            // 一个词能差一倍，猜窄了就裁字、猜宽了就成了大枕头。用 `paint-order:
            // stroke` 在文字背后描一圈底色（见 CSS），宽度交给排版决定，任何
            // 语言都不会错位，线从字下穿过也被挡住。
            return <text
              x={mid.x}
              y={mid.y + 4}
              textAnchor="middle"
              className={css.connectionRoleBadgeText}
            >{tt(badge)}</text>
          })() : null}
        </g>
      })}
      {draft !== null ? (() => {
        const node = nodeById.get(draft.nodeId)
        if (node === undefined) return null
        // 指针落在一个合法目标上就吸到它的锚点，否则跟着鼠标。
        const mouse = draft.targetId !== undefined && draft.targetId !== null && nodeById.has(draft.targetId)
          ? nodeAnchor(nodeById.get(draft.targetId)!, draft.handleType === 'source' ? 'left' : 'right')
          : draft.mouse
        const path = draft.handleType === 'source'
          ? bezierPath(nodeAnchor(node, 'right'), mouse)
          : bezierPath(mouse, nodeAnchor(node, 'left'))
        return <path d={path} className={css.connectionPreview} />
      })() : null}
      {/* 正在跑的技能：从源节点长出一条动画边指向那张临时运行卡片
          （等产物接管之后这条边就消失）。 */}
      {Object.entries(skillRuns).map(([taskId, trace]) => {
        const from = nodeById.get(trace.nodeId)
        if (from === undefined || trace.status === 'pending') return null
        const start = nodeAnchor(from, 'right')
        const end = { x: trace.rect.x, y: trace.rect.y + trace.rect.height / 2 }
        return <path key={`skill-run-${taskId}`} d={bezierPath(start, end)} className={css.skillRunEdge} />
      })}
    </g>
  </svg>
}
