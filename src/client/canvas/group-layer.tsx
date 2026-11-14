/**
 * 分组层：把「哪几个节点是一伙的」画成一个框。
 *
 * 与 `connection-layer.tsx` 同一约定——只吃 props，不读画布状态、不查 DOM、
 * 不发请求。框的位置完全由 `group-model.ts` 从成员节点算出来，这里只负责
 * 让它看起来像一个框。
 *
 * 两件这里必须交代清楚的事：
 *
 *  1. **框体不吃指针。** 框是给眼睛看的，不是给手点的：它盖在节点上面
 *     （这一层画在 `.world` 里，比节点晚），一旦吃指针，框内节点的拖拽、
 *     画布的平移、框选就全被它吞掉，而这些动作恰恰是成组之后天天要做的。
 *     能点是标题条——那是一条明确的小目标，不覆盖任何东西。
 *
 *  2. **填充只能极淡。** 同样因为它画在节点**上面**：这不是给节点垫底的
 *     背景，而是盖在图片上的一层薄色。透明度高一点点，用户的照片就整体
 *     偏色，而且他找不到关掉它的地方。4% 是「看得出这块被圈起来了、又
 *     认不出图片颜色变了」的量级。
 */

import type { CanvasGroup, CanvasNode } from '../../protocol.ts'
import type { Point } from './geometry.ts'
import { groupFrame } from './group-model.ts'
import { tt } from '../helpers.ts'
import css from '../canvas-workspace.module.css'

export interface GroupLayerProps {
  /** 文档里的分组。老文档没有这个字段，调用方传 `groupsOf(document)` 即可。 */
  groups: readonly CanvasGroup[]
  /** 节点索引：框的位置靠它算成员包围盒。 */
  nodeById: ReadonlyMap<string, CanvasNode>
  /** 当前整组被选中/悬停的组 id，用于描边加强；没有就是 null。 */
  activeGroupId: string | null
  /** 双击组标题 → 交给调用方开重命名。 */
  onRename: (groupId: string) => void
  /** 右键标题 → 交给调用方开菜单。 */
  onContextMenu: (groupId: string, screen: Point) => void
}

/**
 * 分组层。
 *
 * 成员的节点一个都解析不到的组直接不画（`groupFrame` 返回 null）：
 * 这时画出来的是一个点不中、也拖不动的空框，看起来像坏了。组本身等下一次
 * 删除操作被 `pruneGroups` 收走，不必在这里替它操心。
 */
export function GroupLayer({
  groups,
  nodeById,
  activeGroupId,
  onRename,
  onContextMenu,
}: GroupLayerProps): React.JSX.Element | null {
  const visible = groups
    .map(group => ({ group, frame: groupFrame(group, nodeById) }))
    .filter((entry): entry is { group: CanvasGroup; frame: NonNullable<ReturnType<typeof groupFrame>> } => entry.frame !== null)

  // 没有可画的框时返回 null 而不是一个空容器：这个组件挂在 `.world` 里，
  // 而 `.world` 有 transform，多一层空壳就是多一个合成层。
  if (visible.length === 0) return null

  return <div className={css.groupLayer}>
    {visible.map(({ group, frame }) => {
      const active = group.id === activeGroupId
      return <div
        key={group.id}
        className={`${css.groupFrame} ${active ? css.groupFrameActive : ''}`}
        style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
        role="group"
        aria-label={group.title}
        data-canvas-group={group.id}
      >
        {/* 标题条压在框线上（见下方 translateY(-50%) 的样式）：框内每一寸
            都可能是节点，把标题塞进去会盖住内容，而框线外的那 20px 留白
            本来就是空的。 */}
        <div
          className={css.groupTitleBar}
          // 三个都拦：画布把「空白处按下/点击」当成取消选择与开始框选，
          // 而标题条在结构上确实落在空白处。少拦一个，用户点一下组名就会
          // 把整组的选择清掉。
          onPointerDown={event => { event.stopPropagation() }}
          onClick={event => { event.stopPropagation() }}
          onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); onRename(group.id) }}
          onContextMenu={event => {
            event.preventDefault(); event.stopPropagation()
            onContextMenu(group.id, { x: event.clientX, y: event.clientY })
          }}
        >
          <span className={css.groupTitleText}>{group.title}</span>
          <span className={css.groupCount}>{tt('canvas.group.memberCount', { count: group.nodeIds.length })}</span>
        </div>
      </div>
    })}
  </div>
}
