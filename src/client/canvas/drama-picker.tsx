/**
 * 「从短剧文档铺板」的目录选择卡。
 *
 * WHY 有一张卡而不是直接读当前工作区：宿主没有「当前会话」这个概念
 * （`SessionListState` 里没有 `current`，见 `host-directory.ts` 的说明）。
 * 读哪一部剧是用户的意图，让他指一次比插件去猜准——猜错会把另一集铺到
 * 这张画布上，而且没有任何提示。
 *
 * 两条路径都给：宿主装了 workspace UI 就能用系统目录框；没装（headless、
 * 精简外壳）就手输绝对路径。两条都通，功能不在精简外壳上失效。
 */

import { useMemo, useRef, useState } from 'react'
import { tt } from '../helpers.ts'
import { normalizeDirectoryChoice } from '../host-directory.ts'
import css from './capability-catalog.module.css'
import { useModalFocus } from './capability-catalog.tsx'

export interface DramaPickerProps {
  /** 宿主目录选择器；undefined 表示这个外壳没装载它。 */
  pickDirectory?: () => Promise<string | null>
  /** 上一次用过的目录，作为初始值——同一部剧通常要反复铺。 */
  initialDirectory?: string
  /** 正在读文档；按钮切到「读取中」并全部禁用。 */
  busy: boolean
  onConfirm: (directory: string) => void
  onClose: () => void
}

export function DramaDirectoryPicker (props: DramaPickerProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [directory, setDirectory] = useState(props.initialDirectory ?? '')
  const [picking, setPicking] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  useModalFocus(dialogRef, props.onClose, '[data-drama-picker-input]')

  const trimmed = useMemo(() => normalizeDirectoryChoice(directory), [directory])
  // 只判断「看起来像绝对路径吗」这一件本地能确定的事；目录存不存在、
  // 里面有没有《分镜.md》，交给宿主读的时候回答——在这里猜等于第二份判断。
  const plausible = trimmed.startsWith('/') || /^[A-Za-z]:[/\\]/.test(trimmed)

  const pick = async (): Promise<void> => {
    if (props.pickDirectory === undefined || picking) return
    setPicking(true)
    setPickError(null)
    try {
      const chosen = await props.pickDirectory()
      if (chosen !== null && chosen !== '') setDirectory(chosen)
    } catch (error) {
      setPickError(error instanceof Error ? error.message : String(error))
    } finally {
      setPicking(false)
    }
  }

  const submit = (): void => {
    if (props.busy || !plausible) return
    props.onConfirm(trimmed)
  }

  return <div className={css.backdrop} data-canvas-no-zoom="" onPointerDown={event => event.stopPropagation()}>
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={css.dialog}
      role="dialog"
      aria-modal="true"
      aria-label={tt('canvas.drama.pickTitle')}
      data-drama-picker=""
      style={{ minWidth: 520 }}
    >
      <header className={css.header}>
        <h2>{tt('canvas.drama.pickTitle')}</h2>
        <p>{tt('canvas.drama.pickHint')}</p>
      </header>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0 12px' }}>
        <input
          value={directory}
          onChange={event => setDirectory(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
          placeholder={tt('canvas.drama.pickPlaceholder')}
          aria-label={tt('canvas.drama.pickPlaceholder')}
          style={{ flex: 1, minWidth: 0 }}
          data-drama-picker-input=""
        />
        {props.pickDirectory !== undefined
          ? <button type="button" onClick={() => { void pick() }} disabled={picking || props.busy} data-drama-picker-browse="">
            {picking ? tt('canvas.drama.picking') : tt('canvas.drama.browse')}
          </button>
          : null}
      </div>
      {pickError !== null ? <p role="alert">{pickError}</p> : null}
      {/* 不是绝对路径时把原因说出来，而不是让「铺板」按钮灰着不解释。 */}
      {trimmed !== '' && !plausible ? <p role="alert">{tt('canvas.drama.pickNotAbsolute')}</p> : null}
      <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 12 }}>
        <button type="button" onClick={props.onClose} disabled={props.busy}>{tt('canvas.drama.cancel')}</button>
        <button type="button" onClick={submit} disabled={props.busy || !plausible} data-drama-picker-confirm="">
          {props.busy ? tt('canvas.drama.reading') : tt('canvas.drama.confirm')}
        </button>
      </footer>
    </div>
  </div>
}
