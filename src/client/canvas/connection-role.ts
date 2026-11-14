/**
 * 连线角色的唯一解析处：老文档没有 `role` 字段，从这里往后一律按 `'input'`
 * 处理，别处的代码不要自己写 `connection.role ?? 'input'`。
 *
 * 为什么要有这一层：首尾帧以前是「connections 数组里前两张图」，删一条边再
 * 重连就会把首帧尾帧对调，而画布上看不出任何区别。角色把这件事变成显式数据。
 *
 * 硬约束（别在别处破坏）：
 *  - 缺省不写盘。`role: 'input'` 与「没有 role」必须是同一个意思，且回写时
 *    要把字段删掉——否则老画布被打开一次就多出一个从没被设置过的字段。
 *  - 只读 fromNodeId / toNodeId 的纯函数（workflow 分层、技能输入解析）不受
 *    影响。角色只决定「谁当首帧、谁当尾帧、谁只是素材」，不改变图的结构，
 *    也不改变哪条边存在。
 *  - 本模块只做判断与选择，不碰 React、不碰 DOM、不发请求，Node 可直接
 *    strip-types 跑（见 scripts/smoke-canvas-connection-role.mjs）。
 */

import type { CanvasConnection, CanvasConnectionRole, CanvasNode } from '../../protocol.ts'

/** 全部合法角色，供菜单与校验共用；顺序即菜单顺序。 */
export const CONNECTION_ROLES: readonly CanvasConnectionRole[] = ['input', 'first', 'last', 'reference']

export const CONNECTION_ROLE_LABELS: Record<CanvasConnectionRole, 'canvas.connection.role.input' | 'canvas.connection.role.first' | 'canvas.connection.role.last' | 'canvas.connection.role.reference'> = {
  input: 'canvas.connection.role.input',
  first: 'canvas.connection.role.first',
  last: 'canvas.connection.role.last',
  reference: 'canvas.connection.role.reference',
}

/**
 * 这条连线实际的角色。
 *
 * 认不出的值（手改过的 JSON、将来加过的角色）退回 `'input'`：一个画布因为
 * 某个边上的字符串不认识就整份读不出来，比角色失效严重得多。
 */
export function roleOf(connection: Pick<CanvasConnection, 'role'>): CanvasConnectionRole {
  const role = connection.role
  return role !== undefined && (CONNECTION_ROLES as readonly string[]).includes(role)
    ? role as CanvasConnectionRole
    : 'input'
}

/**
 * 设置角色后的连线对象。
 *
 * `'input'` 会**删掉**字段而不是写成 `'input'`：磁盘上「没有这个字段」是大量
 * 老画布的唯一形态，让它继续是唯一形态，往返保存才真正无损。
 */
export function withRole(connection: CanvasConnection, role: CanvasConnectionRole): CanvasConnection {
  if (role === 'input') {
    if (connection.role === undefined) return connection
    const { role: _dropped, ...rest } = connection
    return rest
  }
  return connection.role === role ? connection : { ...connection, role }
}

/** 文档里每条连线都按角色归位；未标注的保持原样（含字段缺失这一点）。 */
export function normalizeRoles(connections: readonly CanvasConnection[]): CanvasConnection[] {
  return connections.map(connection => roleOf(connection) === 'input' ? withRole(connection, 'input') : connection)
}

/**
 * 一个目标节点的上游连线，按「首帧 → 尾帧 → 其余」排序。
 *
 * 只在**都设了角色**的那几条之间重排，剩下的保持文档顺序——今天的行为就是
 * 文档顺序，没有任何一条连线被标过角色的画布，排序结果必须与今天逐条相同。
 * 这是兼容老画布的关键：迁移不是把顺序改对，而是让没设角色的画布**一点都
 * 不变**。
 */
export function orderedUpstream(connections: readonly CanvasConnection[], targetId: string): CanvasConnection[] {
  const upstream = connections.filter(connection => connection.toNodeId === targetId)
  const ranked = upstream.flatMap((connection, index) => {
    const role = roleOf(connection)
    const rank = role === 'first' ? 0 : role === 'last' ? 1 : 2
    return [{ connection, index, rank }]
  })
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return ranked.map(entry => entry.connection)
}

/** 指定角色的上游连线；同一角色有多条时取文档顺序第一条。 */
export function upstreamWithRole(connections: readonly CanvasConnection[], targetId: string, role: CanvasConnectionRole): CanvasConnection | undefined {
  return connections.find(connection => connection.toNodeId === targetId && roleOf(connection) === role)
}

/**
 * 首尾帧要用的两张上游节点，各带它来自哪条连线。
 *
 * 判定顺序：
 *  1. 显式标了 `first` / `last` 的连线优先，与数组顺序无关；
 *  2. 没有标注时**完整退回**今天的取法（前两张可用的图片节点），所以没设过
 *     角色的画布生成的视频逐帧不变；
 *  3. 只标了 `first` 不标 `last` 时，尾帧继续按老规则从剩下的图里取——半套
 *     标注不该让整条链路失效。
 */
export function framePair(
  connections: readonly CanvasConnection[],
  nodeById: (id: string) => CanvasNode | undefined,
  targetId: string,
  usable: (node: CanvasNode) => boolean,
): { first?: CanvasNode; last?: CanvasNode } {
  // 排序已经把 first 顶到最前、last 排第二，所以这里只要按序取可用的图。
  // 别再额外判断一次「哪条标了 first」——两套判断结果恒等，删掉其中一套也
  // 不会变红，等于给自己留了一个改坏也发现不了的地方。
  const images = orderedUpstream(connections, targetId)
    .map(connection => nodeById(connection.fromNodeId))
    .filter((node): node is CanvasNode => node !== undefined && usable(node))
  const first = images[0]
  const last = images.find(node => node.id !== first?.id)
  return {
    ...first === undefined ? {} : { first },
    ...last === undefined ? {} : { last },
  }
}

/**
 * 连线上该显示的角色徽标文案键；`input` 不显示（它是默认，标出来只是噪音）。
 */
export function roleBadgeKey(role: CanvasConnectionRole): 'canvas.connection.role.first' | 'canvas.connection.role.last' | 'canvas.connection.role.reference' | undefined {
  switch (role) {
    case 'first': return 'canvas.connection.role.first'
    case 'last': return 'canvas.connection.role.last'
    case 'reference': return 'canvas.connection.role.reference'
    default: return undefined
  }
}
