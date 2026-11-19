/**
 * 宿主的目录选择器，按能力探测接入，不是硬依赖。
 *
 * WHY 装短剧文档要用户先选目录：宿主**没有**「当前会话是哪一个」这个概念
 * ——`SessionListState` 只有 `ids` / `byId` / `phase` / `projectionsBySession`，
 * 从来没有 `current`；选中态属于导航（`uiWorkspace` 内部），插件拿不到。
 * 于是「从当前会话的工作区里读文档」这条路在真机上永远返回 undefined，
 * 用户看到的是「读不到工作区目录」而侧边栏明明开着工作区。
 *
 * 替代方案是让用户自己指定一次目录：读哪个项目是用户的意图，不该由插件
 * 从「现在选着哪个会话」去猜——猜错会把别人的另一集铺到这张画布上。
 *
 * `ctx.uiWorkspace` 属于宿主 UI 层，不在本插件的 devDependencies 里，所以
 * 这里只用结构化类型拿它：宿主没装载 workspace UI（headless / 精简外壳）时
 * 退化成让用户手输路径，而不是整块功能不可用。
 */

/** 宿主目录选择器的最小面：只要「弹一个选目录的框」。 */
export interface HostDirectoryPicker {
  pickDirectory?: () => Promise<string | null>
}

/** `uiWorkspace` 上本插件会用到的唯一方法。 */
export interface WorkspaceUiLike {
  pickDirectory?: () => Promise<string | null>
}

/**
 * 从宿主 Context 上取目录选择能力。
 *
 * 取不到时返回 `{}`——调用方据此退回「手输路径」，而不是报错。这与本项目
 * 对其他可选宿主能力（`conversation`、`sessions`）的处理一致：外壳版本不同
 * 是常态，缺一项能力只该让一条路降级，不该让整个面板挂掉。
 */
export function hostDirectoryPicker(ctx: { get?: (name: string) => unknown }): HostDirectoryPicker {
  const workspace = ctx.get?.('uiWorkspace') as WorkspaceUiLike | undefined
  if (workspace === undefined || typeof workspace.pickDirectory !== 'function') return {}
  return { pickDirectory: () => workspace.pickDirectory!() }
}

/**
 * 把用户给的路径整理成「铺板要的那个目录」。
 *
 * 用户可能选项目根（含 `剧集/`）、也可能直接选某一集；两种都原样交给宿主
 * 的 `findEpisodeDirectory`，它会自己判断。这里只做两件本地就能做对的事：
 * 去掉首尾空白与末尾斜杠，免得同一个目录因为一个 `/` 被当成两条不同的路径。
 */
export function normalizeDirectoryChoice(raw: string): string {
  const trimmed = raw.trim().replace(/[/\\]+$/, '')
  return trimmed
}
