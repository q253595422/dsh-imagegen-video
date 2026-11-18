/**
 * 「全部功能」目录：把画布散落在四处的能力收进一张可搜索的清单。
 *
 * WHY 需要它：画布现在同时开三条口——底栏 14 格、节点悬停工具条、右键菜单，
 * 每条口只放得下它自己那一类动作。于是「拼接视频」只有先选中两段视频才看得见
 * （多选条冒出来），「整理画布」只在左下角，「AI 润色」只在文本节点的右键里。
 * 一个用户想不起来某个功能在哪个入口时，没有任何地方能回答「这个画布一共能
 * 做什么」。LibTV 用一张分组 + 搜索的弹窗解决这件事；这里照它的形状做，但
 * **只列我们真的有的动作**：目录里每一行都必须能直接点到一段已经接好的代码，
 * 不做「敬请期待」的占位。
 *
 * WHY 纯数据 + 纯函数：搜索、分组顺序、可用性判定是这条功能里唯一会被改坏的
 * 部分（加一行就得决定它属于哪组、缺什么条件下不可用）。它们能脱开 React 被
 * 单测钉住，所以放在这里；`capability-catalog.tsx` 只负责画。
 *
 * 与界面的约定：这里**不 import 任何组件**，只借 `ToolbarIconName` 的**类型**
 * （`import type` 在编译期被擦除，`smoke-canvas-geometry.mjs` 才能直接加载这个
 * 文件）。一旦这里出现运行时 import 一个 `.tsx`，那条单测就再也跑不起来。
 */

import type { ImageGenKey } from '../locales.ts'
import type { ToolbarIconName } from './dock-controls.tsx'

/**
 * 六个分组，按「先造、再跑、再改、再看」排。
 *
 * 顺序不是随意的：用户打开这张表时最常带着一个动词（我要加一张图 / 我要把
 * 这条流程跑起来 / 我要撤销），把「造」放最上面是因为空画布是唯一必然经过的
 * 状态。帮助放最后：它是查资料，不是做事。
 */
export type CapabilityGroup = 'create' | 'run' | 'edit' | 'view' | 'canvas' | 'help'

export const CAPABILITY_GROUP_ORDER: readonly CapabilityGroup[] = ['create', 'run', 'edit', 'view', 'canvas', 'help']

export const CAPABILITY_GROUP_LABELS: Record<CapabilityGroup, ImageGenKey> = {
  create: 'canvas.catalog.groupCreate',
  run: 'canvas.catalog.groupRun',
  edit: 'canvas.catalog.groupEdit',
  view: 'canvas.catalog.groupView',
  canvas: 'canvas.catalog.groupCanvas',
  help: 'canvas.catalog.groupHelp',
}

/**
 * 目录里每一行的 id。
 *
 * 写成显式联合而不是从数组里推导：调用方要按 id 建一张 `Record`，这份联合就是
 * 「漏接一个动作」的唯一编译期防线——数组里加了一行而这里没加，`id` 立刻报错；
 * 这里加了而数组里没有，`Record` 会要求一个永远不会被调用的处理器，写的人当场
 * 会发现。推导出来的类型两样都做不到。
 */
export type CapabilityId =
  | 'create.image'
  | 'create.video'
  | 'create.text'
  | 'create.sketch'
  | 'create.pose'
  | 'create.storyboard'
  | 'create.file'
  | 'create.config'
  | 'run.workflow'
  | 'run.health'
  | 'run.compose'
  | 'run.timeline'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.history'
  | 'edit.duplicate'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.group'
  | 'edit.arrange'
  | 'edit.layerFront'
  | 'edit.layerBack'
  | 'edit.layerForward'
  | 'edit.layerBackward'
  | 'edit.lock'
  | 'edit.hide'
  | 'edit.alignLeft'
  | 'edit.alignCenterH'
  | 'edit.alignRight'
  | 'edit.alignTop'
  | 'edit.alignCenterV'
  | 'edit.alignBottom'
  | 'edit.distributeH'
  | 'edit.distributeV'
  | 'edit.delete'
  | 'view.search'
  | 'view.fit'
  | 'view.minimap'
  | 'view.connections'
  | 'view.snap'
  | 'view.fullscreen'
  | 'canvas.new'
  | 'canvas.favorite'
  | 'canvas.export'
  | 'canvas.import'
  | 'help.shortcuts'
  | 'help.skills'

/**
 * 判定「这一项现在能不能用」需要的全部事实。
 *
 * 每一项都是画布已经算出来的东西，不是新状态：`canUndo` 就是
 * `pastRef.current.length > 0`，`composeClips` 就是 `composeIds.length`。
 * 目录不自己维护一份「能不能用」的记忆——两份记忆必然分叉成「按钮亮着但
 * 按下去没反应」，那正是这个文件要消灭的东西。
 */
export interface CapabilityContext {
  /** 画布上的节点数。 */
  nodeCount: number
  /** 当前选中的节点数。 */
  selectedCount: number
  /** 内部剪贴板里有没有东西。 */
  clipboardFilled: boolean
  canUndo: boolean
  canRedo: boolean
  /** 画布已经落盘（有 id）。草稿上的导出/收藏只会 404。 */
  savedCanvas: boolean
  /** 多选里的视频数：拼接至少要用两段。 */
  composeClips: number
}

export interface CapabilityEntry {
  id: CapabilityId
  group: CapabilityGroup
  /** 行标题。复用底栏/菜单的现有文案，同一件事在画布上只有一个名字。 */
  labelKey: ImageGenKey
  /** 一句话说明「什么时候用它」。既是副标题，也是搜索的第二语料。 */
  hintKey: ImageGenKey
  icon: ToolbarIconName
  /**
   * 搜索同义词，中英混排。
   *
   * 只写「用户会打、而标题里没有」的词：把标题再抄一遍没有意义。比如「移除
   * 背景」要能被「抠图」「去背」「matting」找到，而「移除背景」四个字已经在
   * 标题里了。
   */
  keywords: readonly string[]
  /** 返回不可用的原因；不写 = 永远可用。 */
  blocked?: (context: CapabilityContext) => ImageGenKey | null
}

const needsNodes = (context: CapabilityContext): ImageGenKey | null =>
  context.nodeCount === 0 ? 'canvas.catalog.blockedNoNodes' : null
const needsSelection = (context: CapabilityContext): ImageGenKey | null =>
  context.selectedCount === 0 ? 'canvas.catalog.blockedNoSelection' : null

/**
 * 目录的全集。顺序即同一分组内的显示顺序。
 *
 * 分组内的顺序也有讲究：越常用的越靠前（「添加图片」在「添加配置卡」之前），
 * 因为一屏放不下时用户先看到的那几行决定他会不会继续往下翻。
 */
export const CAPABILITIES = [
  {
    id: 'create.image',
    group: 'create',
    labelKey: 'canvas.addImage',
    hintKey: 'canvas.catalog.hintCreateImage',
    icon: 'image',
    keywords: ['图片', 'image', 'picture', 'photo', '上传', 'upload', '素材', 'gallery', '生成', 'generate'],
  },
  {
    id: 'create.video',
    group: 'create',
    labelKey: 'canvas.addVideo',
    hintKey: 'canvas.catalog.hintCreateVideo',
    icon: 'video',
    keywords: ['视频', 'video', '片段', 'clip', '素材', 'gallery'],
  },
  {
    id: 'create.text',
    group: 'create',
    labelKey: 'canvas.addTextNode',
    hintKey: 'canvas.catalog.hintCreateText',
    icon: 'text',
    keywords: ['文本', 'text', '提示词', 'prompt', '文案', 'copy'],
  },
  {
    id: 'create.sketch',
    group: 'create',
    labelKey: 'canvas.addSketchNode',
    hintKey: 'canvas.catalog.hintCreateSketch',
    icon: 'sketch',
    keywords: ['画板', 'sketch', '涂鸦', 'doodle', '手绘', 'draw'],
  },
  {
    id: 'create.pose',
    group: 'create',
    labelKey: 'canvas.addPoseNode',
    hintKey: 'canvas.catalog.hintCreatePose',
    icon: 'expand',
    keywords: ['姿势', 'pose', '人偶', 'mannequin', '动作', '骨骼', 'rig'],
  },
  {
    id: 'create.storyboard',
    group: 'create',
    labelKey: 'canvas.storyboardNode',
    hintKey: 'canvas.catalog.hintCreateStoryboard',
    icon: 'layers',
    keywords: ['分镜', 'storyboard', '镜头', 'shot', '连续', 'sequence'],
  },
  {
    id: 'create.file',
    group: 'create',
    labelKey: 'canvas.skills.addFileNode',
    hintKey: 'canvas.catalog.hintCreateFile',
    icon: 'file',
    keywords: ['文件', 'file', 'pdf', '文档', 'document', '表格'],
  },
  {
    id: 'create.config',
    group: 'create',
    labelKey: 'canvas.addConfigNode',
    hintKey: 'canvas.catalog.hintCreateConfig',
    icon: 'sparkle',
    keywords: ['配置', 'config', '生成', 'generate', '模型', 'model', '设置'],
  },
  {
    id: 'run.workflow',
    group: 'run',
    labelKey: 'canvas.workflow.run',
    hintKey: 'canvas.catalog.hintRunWorkflow',
    icon: 'workflow',
    keywords: ['运行', 'run', '执行', 'execute', '跑', '批量', 'batch'],
    blocked: needsNodes,
  },
  {
    id: 'run.health',
    group: 'run',
    labelKey: 'canvas.health.title',
    hintKey: 'canvas.catalog.hintHealth',
    icon: 'health',
    keywords: ['体检', '检查', 'check', 'lint', 'validate', '诊断', 'diagnose', '问题', 'issue', '环', 'cycle'],
    blocked: needsNodes,
  },
  {
    id: 'run.compose',
    group: 'run',
    labelKey: 'canvas.skills.compose',
    hintKey: 'canvas.catalog.hintCompose',
    icon: 'timeline',
    keywords: ['拼接', 'stitch', '合并', 'merge', 'ffmpeg', '接片', '连起来'],
    blocked: context => context.composeClips < 2 ? 'canvas.catalog.blockedNeedTwoClips' : null,
  },
  {
    id: 'run.timeline',
    group: 'run',
    labelKey: 'timeline.open',
    hintKey: 'canvas.catalog.hintTimeline',
    icon: 'layers',
    keywords: ['时间线', 'timeline', '剪辑', 'edit', '转场', 'transition'],
    blocked: needsNodes,
  },
  {
    id: 'edit.undo',
    group: 'edit',
    labelKey: 'canvas.undo',
    hintKey: 'canvas.catalog.hintUndo',
    icon: 'undo',
    keywords: ['撤销', 'undo', '回退'],
    blocked: context => context.canUndo ? null : 'canvas.catalog.blockedNoUndo',
  },
  {
    id: 'edit.redo',
    group: 'edit',
    labelKey: 'canvas.redo',
    hintKey: 'canvas.catalog.hintRedo',
    icon: 'redo',
    keywords: ['重做', 'redo', '恢复'],
    blocked: context => context.canRedo ? null : 'canvas.catalog.blockedNoRedo',
  },
  {
    id: 'edit.history',
    group: 'edit',
    // 撤销按钮一下退一步，退第五步就要按五次而且不知道自己在第几步。历史面板
    // 是同一个能力的「一次退到底」，所以归在撤销旁边而不是另起一组。
    labelKey: 'canvas.history.title',
    hintKey: 'canvas.catalog.hintHistory',
    icon: 'history',
    keywords: ['历史', 'history', '版本', 'version', '时间线', 'timeline', '回退', 'revert'],
    blocked: context => context.canUndo ? null : 'canvas.catalog.blockedNoUndo',
  },
  {
    id: 'edit.duplicate',
    group: 'edit',
    labelKey: 'canvas.duplicate',
    hintKey: 'canvas.catalog.hintDuplicate',
    icon: 'duplicate',
    keywords: ['复制', 'duplicate', '副本', 'clone', '再来一份'],
    blocked: needsSelection,
  },
  {
    id: 'edit.copy',
    group: 'edit',
    labelKey: 'canvas.shortcuts.copy',
    hintKey: 'canvas.catalog.hintCopy',
    icon: 'duplicate',
    keywords: ['拷贝', 'copy', '拷贝到', 'clipboard', '剪贴板'],
    blocked: needsSelection,
  },
  {
    id: 'edit.paste',
    group: 'edit',
    labelKey: 'canvas.paste',
    hintKey: 'canvas.catalog.hintPaste',
    icon: 'new',
    keywords: ['粘贴', 'paste', '剪贴板', 'clipboard'],
    blocked: context => context.clipboardFilled ? null : 'canvas.catalog.blockedClipboard',
  },
  {
    id: 'edit.group',
    group: 'edit',
    labelKey: 'canvas.group.create',
    hintKey: 'canvas.catalog.hintGroup',
    icon: 'connections',
    keywords: ['成组', 'group', '分组', '框住', '一起移动'],
    blocked: context => context.selectedCount < 2 ? 'canvas.catalog.blockedNeedTwo' : null,
  },
  {
    id: 'edit.arrange',
    group: 'edit',
    labelKey: 'canvas.arrange',
    hintKey: 'canvas.catalog.hintArrange',
    icon: 'arrange',
    keywords: ['整理', 'arrange', '排版', 'layout', '自动', 'auto'],
    blocked: needsNodes,
  },
  {
    id: 'edit.layerFront',
    group: 'edit',
    labelKey: 'canvas.layer.front',
    hintKey: 'canvas.catalog.hintLayerFront',
    icon: 'layerFront',
    keywords: ['置顶', 'front', 'top', '最上层', '层级', 'layer', 'order'],
    blocked: needsSelection,
  },
  {
    id: 'edit.layerBack',
    group: 'edit',
    labelKey: 'canvas.layer.back',
    hintKey: 'canvas.catalog.hintLayerBack',
    icon: 'layerBack',
    keywords: ['置底', 'back', 'bottom', '最下层', '层级', 'layer', 'order'],
    blocked: needsSelection,
  },
  {
    id: 'edit.layerForward',
    group: 'edit',
    labelKey: 'canvas.layer.forward',
    hintKey: 'canvas.catalog.hintLayerForward',
    icon: 'layerForward',
    keywords: ['上移一层', 'forward', 'up', '层级', 'layer', 'order', 'raise'],
    blocked: needsSelection,
  },
  {
    id: 'edit.layerBackward',
    group: 'edit',
    labelKey: 'canvas.layer.backward',
    hintKey: 'canvas.catalog.hintLayerBackward',
    icon: 'layerBackward',
    keywords: ['下移一层', 'backward', 'down', '层级', 'layer', 'order', 'lower'],
    blocked: needsSelection,
  },
  {
    id: 'edit.lock',
    group: 'edit',
    labelKey: 'canvas.lock.lock',
    hintKey: 'canvas.catalog.hintLock',
    icon: 'lock',
    keywords: ['锁定', 'lock', '固定', 'pin', '钉住', '只读'],
    blocked: needsSelection,
  },
  {
    id: 'edit.hide',
    group: 'edit',
    labelKey: 'canvas.lock.hide',
    hintKey: 'canvas.catalog.hintHide',
    icon: 'hide',
    keywords: ['隐藏', 'hide', '收起', '看不见', '显示'],
    blocked: needsSelection,
  },
  {
    id: 'edit.alignLeft',
    group: 'edit',
    labelKey: 'canvas.align.left',
    hintKey: 'canvas.catalog.hintAlignLeft',
    icon: 'alignLeft',
    keywords: ['左对齐', 'align left', '靠左', '左缘'],
    blocked: context => context.selectedCount < 2 ? 'canvas.catalog.blockedNeedTwo' : null,
  },
  {
    id: 'edit.alignCenterH',
    group: 'edit',
    labelKey: 'canvas.align.centerH',
    hintKey: 'canvas.catalog.hintAlignCenterH',
    icon: 'alignCenterH',
    keywords: ['水平居中', 'center', '竖中线', '垂直中轴'],
    blocked: context => context.selectedCount < 2 ? 'canvas.catalog.blockedNeedTwo' : null,
  },
  {
    id: 'edit.alignRight',
    group: 'edit',
    labelKey: 'canvas.align.right',
    hintKey: 'canvas.catalog.hintAlignRight',
    icon: 'alignRight',
    keywords: ['右对齐', 'align right', '靠右', '右缘'],
    blocked: context => context.selectedCount < 2 ? 'canvas.catalog.blockedNeedTwo' : null,
  },
  {
    id: 'edit.alignTop',
    group: 'edit',
    labelKey: 'canvas.align.top',
    hintKey: 'canvas.catalog.hintAlignTop',
    icon: 'alignTop',
    keywords: ['顶对齐', 'align top', '靠上', '上缘'],
    blocked: context => context.selectedCount < 2 ? 'canvas.catalog.blockedNeedTwo' : null,
  },
  {
    id: 'edit.alignCenterV',
    group: 'edit',
    labelKey: 'canvas.align.centerV',
    hintKey: 'canvas.catalog.hintAlignCenterV',
    icon: 'alignCenterV',
    keywords: ['垂直居中', 'middle', '横中线', '水平中轴'],
    blocked: context => context.selectedCount < 2 ? 'canvas.catalog.blockedNeedTwo' : null,
  },
  {
    id: 'edit.alignBottom',
    group: 'edit',
    labelKey: 'canvas.align.bottom',
    hintKey: 'canvas.catalog.hintAlignBottom',
    icon: 'alignBottom',
    keywords: ['底对齐', 'align bottom', '靠下', '下缘'],
    blocked: context => context.selectedCount < 2 ? 'canvas.catalog.blockedNeedTwo' : null,
  },
  {
    id: 'edit.distributeH',
    group: 'edit',
    labelKey: 'canvas.align.distributeH',
    hintKey: 'canvas.catalog.hintDistributeH',
    icon: 'distributeH',
    keywords: ['对齐', '等距', '间距', 'gap', 'spacing', '均分', '水平分布'],
    blocked: context => context.selectedCount < 3 ? 'canvas.align.distributeTooFew' : null,
  },
  {
    id: 'edit.distributeV',
    group: 'edit',
    labelKey: 'canvas.align.distributeV',
    hintKey: 'canvas.catalog.hintDistributeV',
    icon: 'distributeV',
    keywords: ['对齐', '等距', '间距', 'gap', 'spacing', '均分', '垂直分布'],
    blocked: context => context.selectedCount < 3 ? 'canvas.align.distributeTooFew' : null,
  },
  {
    id: 'edit.delete',
    group: 'edit',
    labelKey: 'canvas.delete',
    hintKey: 'canvas.catalog.hintDelete',
    icon: 'trash',
    keywords: ['删除', 'delete', '移除', 'remove'],
    blocked: needsSelection,
  },
  {
    id: 'view.search',
    group: 'view',
    labelKey: 'canvas.search.open',
    hintKey: 'canvas.catalog.hintSearch',
    icon: 'search',
    // 「找那张写着…的卡」是用户的原话；「定位」「goto」是别家工具的词汇。
    keywords: ['搜索', 'search', 'find', '查找', '定位', '跳到', 'navigate', '那张'],
    blocked: needsNodes,
  },
  {
    id: 'view.fit',
    group: 'view',
    labelKey: 'canvas.fitView',
    hintKey: 'canvas.catalog.hintFit',
    icon: 'fit',
    keywords: ['适应', 'fit', '缩放', 'zoom', '全部', '围住'],
  },
  {
    id: 'view.minimap',
    group: 'view',
    labelKey: 'canvas.minimapOpen',
    hintKey: 'canvas.catalog.hintMinimap',
    icon: 'minimap',
    keywords: ['缩略图', 'minimap', '导航', '全图', 'overview'],
  },
  {
    id: 'view.connections',
    group: 'view',
    labelKey: 'canvas.showConnections',
    hintKey: 'canvas.catalog.hintConnections',
    icon: 'connections',
    keywords: ['连线', 'connections', '线', 'wire', '依赖', 'dependency'],
  },
  {
    id: 'view.snap',
    group: 'view',
    labelKey: 'canvas.snapAlign',
    hintKey: 'canvas.catalog.hintSnap',
    icon: 'snap',
    keywords: ['吸附', 'snap', '对齐', 'align', '网格', 'grid'],
  },
  {
    id: 'view.fullscreen',
    group: 'view',
    labelKey: 'canvas.fullscreen.enter',
    hintKey: 'canvas.catalog.hintFullscreen',
    icon: 'fullscreen',
    keywords: ['全屏', 'fullscreen', '沉浸'],
  },
  {
    id: 'canvas.new',
    group: 'canvas',
    labelKey: 'canvas.newCanvas',
    hintKey: 'canvas.catalog.hintNewCanvas',
    icon: 'new',
    keywords: ['新建', 'new', '新画布', 'create'],
  },
  {
    id: 'canvas.favorite',
    group: 'canvas',
    labelKey: 'canvas.favoriteCanvas',
    hintKey: 'canvas.catalog.hintFavorite',
    icon: 'favorite',
    keywords: ['收藏', 'favorite', '星标', 'star', '置顶'],
    blocked: context => context.savedCanvas ? null : 'canvas.catalog.blockedDraft',
  },
  {
    id: 'canvas.export',
    group: 'canvas',
    labelKey: 'canvas.bundle.export',
    hintKey: 'canvas.catalog.hintExport',
    icon: 'download',
    keywords: ['导出', 'export', '打包', 'bundle', '备份', 'backup', 'json'],
    blocked: context => context.savedCanvas ? null : 'canvas.catalog.blockedDraft',
  },
  {
    id: 'canvas.import',
    group: 'canvas',
    labelKey: 'canvas.bundle.import',
    hintKey: 'canvas.catalog.hintImport',
    icon: 'upload',
    keywords: ['导入', 'import', '恢复', 'restore', 'json'],
  },
  {
    id: 'help.shortcuts',
    group: 'help',
    labelKey: 'canvas.shortcuts.button',
    hintKey: 'canvas.catalog.hintShortcuts',
    icon: 'help',
    keywords: ['快捷键', 'shortcut', '键位', 'key', '帮助', 'help'],
  },
  {
    id: 'help.skills',
    group: 'help',
    labelKey: 'canvas.skills.libraryButton',
    hintKey: 'canvas.catalog.hintSkills',
    icon: 'skill',
    keywords: ['技能', 'skill', '插件', 'install', '安装', '能力'],
  },
] satisfies readonly CapabilityEntry[]

/** 一行在某个时刻的样子：条目本身，加上「现在为什么不能用」。 */
export interface CapabilityItem {
  entry: CapabilityEntry
  /** null = 现在可以点。非 null 时是给用户看的原因。 */
  blockedBy: ImageGenKey | null
}

export interface CapabilitySection {
  group: CapabilityGroup
  items: CapabilityItem[]
}

/**
 * 把一句查询切成词。
 *
 * 按空白切而不是整串匹配：用户会打「删除 节点」或「video clip」，要求连着
 * 出现等于逼他记住我们拼文案的顺序。全角空格也切——中文输入法下混进来一个
 * 是常事，不切就只能算「没有结果」。
 */
function termsOf(query: string): string[] {
  return query.trim().toLowerCase().split(/[\s\u3000]+/).filter(term => term !== '')
}

/**
 * 按查询过滤、按分组归拢。
 *
 * 「不可用」的项**照样出现在结果里**，只是排在可用项后面并标出原因。藏起来是
 * 更省事的做法，但它把「这个功能存在，只是你现在没选中东西」变成「这个功能
 * 不存在」——用户会去找别的工具。技能选择器早就按这个规矩做了，这里保持一致。
 *
 * @param entries - 目录全集（测试里可以传子集）。
 * @param context - 判定可用性的事实。
 * @param query - 用户的输入；空串 = 不过滤。
 * @param translate - 文案解析。注入而不是直接读 `tt`：这个文件必须在没有
 *   界面环境（也没有 CSS）的 Node 单测里跑得起来。
 * @returns 按 {@link CAPABILITY_GROUP_ORDER} 排好的分组；空组不出现。
 */
export function capabilitySections(
  entries: readonly CapabilityEntry[],
  context: CapabilityContext,
  query: string,
  translate: (key: ImageGenKey) => string,
): CapabilitySection[] {
  const terms = termsOf(query)
  const matched: CapabilityItem[] = []
  for (const entry of entries) {
    if (terms.length > 0) {
      // 标题 + 说明 + 同义词一起搜：用户打的词很可能只在说明里（「把几段接成
      // 一条」里有「接」，标题「拼接视频」里没有）。只搜标题会让半数的直觉
      // 输入落空，而落空的人不会去猜第二个词，他会认为这个功能不存在。
      const haystack = [translate(entry.labelKey), translate(entry.hintKey), ...entry.keywords]
        .join(' ')
        .toLowerCase()
      if (!terms.every(term => haystack.includes(term))) continue
    }
    matched.push({ entry, blockedBy: entry.blocked?.(context) ?? null })
  }

  const sections: CapabilitySection[] = []
  for (const group of CAPABILITY_GROUP_ORDER) {
    const items = matched.filter(item => item.entry.group === group)
    if (items.length === 0) continue
    // 可用项在前。稳定排序：`sort` 在 V8 上稳定，声明顺序在同等条件下保留，
    // 所以同一组里「能用的」永远按作者排的常用度出现，而不是随机的。
    items.sort((a, b) => Number(a.blockedBy !== null) - Number(b.blockedBy !== null))
    sections.push({ group, items })
  }
  return sections
}

/**
 * 目录里所有**现在就能点**的行，按显示顺序摊平。
 *
 * 给键盘导航用：↑↓ 只在可用项之间走。让方向键停在一条按下去没反应的灰行上，
 * 是把「这里有个东西」和「这里什么都没有」说成同一句话。
 */
export function runnableItems(sections: readonly CapabilitySection[]): CapabilityItem[] {
  return sections.flatMap(section => section.items).filter(item => item.blockedBy === null)
}
