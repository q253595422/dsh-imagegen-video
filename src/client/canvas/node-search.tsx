/**
 * 「找节点」弹窗：搜标题/正文/提示词/模型，回车跳过去并选中它。
 *
 * 搜索与视野计算全在 `node-search.ts`（纯函数、有单测）；这个文件只做三件事：
 * 把查询串交出去、把结果画出来、把方向键和回车接到行上。
 *
 * WHY 结果行里给出「命中在哪一段」而不是只给标题：用户搜的词经常不在标题里
 * （搜「樱花」命中一张叫「街景」的图）。只显示标题的话，这一行解释不了自己
 * 为什么出现在结果里，用户会怀疑搜错了。
 */

import { useMemo, useRef, useState } from 'react'
import type { CanvasNode } from '../../protocol.ts'
import type { ImageGenKey } from '../locales.ts'
import { tt } from '../helpers.ts'
import { isHidden } from './node-flags.ts'
import { searchNodes, type NodeHit, type NodeHitField } from './node-search.ts'
import { usePickerFocus } from './modal-focus.ts'
import css from './node-search.module.css'

/**
 * 卡片类型名。与节点标题用的文案不同：这里说的是「这是哪一种卡」，
 * 标题说的是「这一张卡叫什么」。混用会让结果行读成两遍标题。
 */
const KIND_LABELS: Record<CanvasNode['type'], ImageGenKey> = {
  image: 'canvas.imageNode',
  text: 'canvas.textNode',
  config: 'canvas.configNode',
  video: 'canvas.videoNode',
  storyboard: 'canvas.storyboardNode',
  file: 'canvas.skills.addFileNode',
}

const FIELD_LABELS: Record<NodeHitField, ImageGenKey> = {
  title: 'canvas.search.field.title',
  text: 'canvas.search.field.text',
  prompt: 'canvas.search.field.prompt',
  model: 'canvas.search.field.model',
}

export function NodeSearchDialog (props: {
  nodes: readonly CanvasNode[]
  onPick: (hit: NodeHit) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  usePickerFocus(dialogRef, props.onClose, '[data-node-search-input]')

  const hits = useMemo(() => searchNodes(props.nodes, query), [props.nodes, query])
  // 查询一变，高亮回到第一条：上一轮指的那条可能已经被过滤掉，留着高亮等于
  // 按回车跳到一条用户看不见的行上。
  const index = hits.length === 0 ? -1 : Math.min(activeIndex, hits.length - 1)

  const move = (delta: number): void => {
    if (hits.length === 0) return
    const next = (index + delta + hits.length) % hits.length
    setActiveIndex(next)
    // 用查询+滚动而不是 `scrollIntoView`：后者在某些浏览器里会连带滚动背后
    // 那张已经滚动的页面，看起来像画布自己跳了一下。
    const row = listRef.current?.querySelector<HTMLElement>(`[data-node-hit="${hits[next]!.nodeId}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }

  const pick = (hit: NodeHit | undefined): void => {
    if (hit === undefined) return
    props.onPick(hit)
  }

  return <div className={css.backdrop} data-canvas-no-zoom="" onPointerDown={event => event.stopPropagation()}>
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={css.dialog}
      role="dialog"
      aria-modal="true"
      aria-label={tt('canvas.search.title')}
      data-node-search=""
      onKeyDown={event => {
        // 在这里认领而不是挂在 window 上：画布的键盘处理会把方向键读成画布
        // 手势，而弹窗开着时它们的意思是「在这一列里上下走」。
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          move(event.key === 'ArrowDown' ? 1 : -1)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          pick(hits[index])
        }
      }}
    >
      <header className={css.header}>
        <input
          data-node-search-input=""
          className={css.search}
          value={query}
          placeholder={tt('canvas.search.placeholder')}
          aria-label={tt('canvas.search.placeholder')}
          onChange={event => { setQuery(event.target.value); setActiveIndex(0) }}
        />
        <button type="button" className={css.close} aria-label={tt('canvas.search.close')} title={tt('canvas.search.close')} onClick={props.onClose}>×</button>
      </header>
      <div ref={listRef} className={css.body} data-node-search-list="">
        {props.nodes.length === 0
          ? <p className={css.empty}>{tt('canvas.search.noNodes')}</p>
          : hits.length === 0
            ? <p className={css.empty}>{query.trim() === '' ? tt('canvas.search.placeholder') : tt('canvas.search.empty', { query })}</p>
            : hits.map((hit, at) => {
                const node = props.nodes.find(candidate => candidate.id === hit.nodeId)
                return <button
                  key={hit.nodeId}
                  type="button"
                  className={css.row}
                  data-node-hit={hit.nodeId}
                  data-active={at === index ? '' : undefined}
                  onClick={() => pick(hit)}
                  onMouseEnter={() => setActiveIndex(at)}
                >
                  <span className={css.kind}>{tt(KIND_LABELS[hit.nodeType])}</span>
                  {/* 藏起来的卡也在结果里——这是把它们找回来的唯一入口之一。
                      但必须标出来：不然用户点了回车，画布平移过去、卡被自动
                      放回来，看起来像「搜索把一张我以为删掉的卡变出来了」。 */}
                  {node !== undefined && isHidden(node) ? <span className={css.hiddenBadge} data-node-hit-hidden={hit.nodeId}>{tt('canvas.search.hiddenBadge')}</span> : null}
                  <span className={css.text}>
                    <strong>{node?.title ?? hit.nodeId}</strong>
                    <small>{hit.snippet}</small>
                  </span>
                  <span className={css.field}>{tt(FIELD_LABELS[hit.field])}</span>
                </button>
              })}
      </div>
      <footer className={css.footer}>{tt('canvas.search.footer')}</footer>
    </div>
  </div>
}
