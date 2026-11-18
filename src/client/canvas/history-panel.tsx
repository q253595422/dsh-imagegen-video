/**
 * 历史面板：一张「这一步做了什么」的清单，点一行就退回到那一步。
 *
 * WHY 单独一个面板而不是只做撤销按钮：撤销一次只退一步，而真实用法是「我
 * 刚才连着做了七八件事，想把画布退回还没乱的那一版」——那时用户不知道要按
 * 几次，也不敢按（按错一次还得重做回来）。一张写着「移动 3 个节点」「删除
 * 图片节点」的清单让他先看见再决定。
 *
 * 行的数据全来自 `history-model.ts` 的 `historyRows`（纯函数，23 条单测）：
 * 这个文件不判断「这一步算什么」，只负责画和把点击交出去。判定规则是会被改
 * 坏的那一半，它必须能在没有 DOM 的地方被钉住。
 *
 * 三条 UI 决定：
 *
 *  - **当前状态也占一行**（最上面，不可点）。一张只有「过去」的清单会让用户
 *    以为最上面那行就是现在；把它写出来，「再往上是过去」才有参照。
 *  - 行里的节点名排在说明**下面**而不是前面。「移动 3 个节点」是动作，
 *    「图片、配置、示例提示词」是细节：先读动作才知道要不要往下看。
 *  - **悬停一行时高亮画布上会动的那几张卡**。清单里写着「移动 3 个节点」，
 *    而一张有几十张卡的画布上，用户点下去之前不知道是哪三张——退错了只能再
 *    重做回来，而重做栈里的那一步与原来未必是同一个状态（中间若又改过别的，
 *    重做回去的是「现在 + 那一步」，不是他离开时的样子）。
 */

import type { ImageGenKey } from '../locales.ts'
import { tt } from '../helpers.ts'
import type { HistoryRow } from './history-model.ts'
import css from './node-search.module.css'

/** 与「找节点」同一套弹窗外壳，多一组行。 */
export function HistoryPanel (props: {
  rows: readonly HistoryRow[]
  /**
   * 点一行：往回退 `stepsBack` 步，并接受这一步涉及的节点 id（退回去之后
   * 由调用方与目标文档求交，再决定选中哪几张）。
   */
  onJump: (stepsBack: number, nodeIds: readonly string[]) => void
  /**
   * 鼠标进入 / 离开一行：把这一步涉及的节点交给画布做临时高亮。
   * `null` = 指针已经不在任何一行上，清掉高亮。
   *
   * WHY 由面板发起而不是面板自己画：要高亮的是画布上的卡片，而卡片在另一个
   * 组件树里。面板唯一能做的诚实的事，是把「现在悬着哪一步」这件事说出去。
   */
  onHover: (nodeIds: readonly string[] | null) => void
  onClose: () => void
}): React.JSX.Element {
  return <div className={css.backdrop} data-canvas-no-zoom="" onPointerDown={event => event.stopPropagation()}>
    <div
      className={css.dialog}
      role="dialog"
      aria-modal="true"
      aria-label={tt('canvas.history.title')}
      data-history-panel=""
      tabIndex={-1}
    >
      <header className={css.header}>
        <strong className={css.panelTitle}>{tt('canvas.history.title')}</strong>
        <button type="button" className={css.close} aria-label={tt('canvas.history.close')} title={tt('canvas.history.close')} onClick={props.onClose}>×</button>
      </header>
      {/* 指针离开整个列表时清掉高亮：只挂行的 onMouseLeave 是不够的——行与行
          之间有一两像素的间隙，指针滑过它会先触发 leave 再触发下一行的 enter，
          高亮会闪一下；而离开列表之后停在最后一行的高亮则永远不会灭。 */}
      <div className={css.body} onMouseLeave={() => props.onHover(null)}>
        {/* 当前状态不可点：它就是用户正在看的东西，点它什么都不该发生——
            而那正是「点了没反应」最容易被误读成坏了的地方。 */}
        <div className={css.row} data-history-current="" aria-current="true">
          <span className={css.kind}>●</span>
          <span className={css.text}><strong>{tt('canvas.history.now')}</strong></span>
        </div>
        {props.rows.length === 0
          ? <p className={css.empty}>{tt('canvas.history.empty')}</p>
          : props.rows.map(row => <button
              key={row.stepsBack}
              type="button"
              className={css.row}
              data-history-step={row.stepsBack}
              data-step-kind={row.kind}
              // 说明直接翻译 `detailKey`：存的是 key 而不是渲染好的句子，所以
              // 用户中途切换界面语言时这张表会跟着变。
              title={tt(row.detailKey as ImageGenKey, row.detailValues)}
              // 悬停预览只对「真的动了某几张卡」的步骤有意义：连线 / 文档字段
              // 的步骤 nodeIds 是空的，传 `[]` 而不是 `null`——`null` 的语义是
              // 「指针离开了」，两者混用会让上一次的高亮永远留在画布上。
              onMouseEnter={() => props.onHover(row.nodeIds)}
              onFocus={() => props.onHover(row.nodeIds)}
              onClick={() => props.onJump(row.stepsBack, row.nodeIds)}
            >
              <span className={css.kind}>{row.stepsBack}</span>
              <span className={css.text}>
                <strong>{tt(row.detailKey as ImageGenKey, row.detailValues)}</strong>
                {row.detailValues?.titles === undefined ? null : <small>{String(row.detailValues.titles)}</small>}
              </span>
            </button>)}
      </div>
      <footer className={css.footer}>{tt('canvas.history.footer')}</footer>
    </div>
  </div>
}
