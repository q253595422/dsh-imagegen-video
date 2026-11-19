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

import { useId, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconCloseOutlineRegular,
  IconFolderOpenOutlineRegular,
  Input,
  useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { tt } from '../helpers.ts'
import { normalizeDirectoryChoice } from '../host-directory.ts'
import css from './drama-picker.module.css'

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
  const inputId = useId()
  const [directory, setDirectory] = useState(props.initialDirectory ?? '')
  const [picking, setPicking] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)

  const trimmed = useMemo(() => normalizeDirectoryChoice(directory), [directory])
  // 只判断「看起来像绝对路径吗」这一件本地能确定的事；目录存不存在、
  // 里面有没有《分镜.md》，交给宿主读的时候回答——在这里猜等于第二份判断。
  const plausible = trimmed.startsWith('/') || /^[A-Za-z]:[/\\]/.test(trimmed)
  const problem = pickError ?? (trimmed !== '' && !plausible ? tt('canvas.drama.pickNotAbsolute') : null)

  const close = (): void => {
    if (!props.busy) props.onClose()
  }
  useModalLayer(dialogRef, true, close)

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

  return <div
    className={css.root}
    data-canvas-no-zoom=""
    onPointerDown={event => event.stopPropagation()}
  >
    <div className={css.mask} aria-hidden="true" onClick={close} />
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={css.dialog}
      role="dialog"
      aria-modal="true"
      aria-label={tt('canvas.drama.pickTitle')}
      data-drama-picker=""
    >
      <div className={css.content}>
        <div className={css.header}>
          <h2 className={css.title}>{tt('canvas.drama.pickTitle')}</h2>
          <button
            type="button"
            className={css.close}
            aria-label={tt('canvas.drama.close')}
            onClick={close}
          >
            <IconCloseOutlineRegular size={14} />
          </button>
        </div>
        <p className={css.description}>{tt('canvas.drama.pickHint')}</p>
        <div className={css.body}>
          <div className={css.form}>
            <label className={css.label} htmlFor={inputId}>{tt('canvas.drama.pickFieldLabel')}</label>
            <div className={css.field}>
              <Input
                id={inputId}
                className={css.input}
                icon={<IconFolderOpenOutlineRegular size={16} />}
                value={directory}
                onChange={event => { setDirectory(event.target.value); setPickError(null) }}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
                placeholder={tt('canvas.drama.pickPlaceholder')}
                disabled={props.busy}
                data-modal-autofocus=""
                data-drama-picker-input=""
              />
              {props.pickDirectory !== undefined
                ? <Button
                    variant="outline"
                    className={css.browse}
                    onClick={() => { void pick() }}
                    disabled={picking || props.busy}
                    data-drama-picker-browse=""
                  >
                    {picking ? tt('canvas.drama.picking') : tt('canvas.drama.browse')}
                  </Button>
                : null}
            </div>
            {/* 不是绝对路径时把原因说出来，而不是让「铺板」按钮灰着不解释。 */}
            {problem !== null ? <p className={css.error} role="alert">{problem}</p> : null}
          </div>
        </div>
      </div>
      <div className={css.footer}>
        <Button variant="outline" onClick={close} disabled={props.busy}>{tt('canvas.drama.cancel')}</Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={props.busy || !plausible}
          data-drama-picker-confirm=""
        >
          {props.busy ? tt('canvas.drama.reading') : tt('canvas.drama.confirm')}
        </Button>
      </div>
    </div>
  </div>
}
