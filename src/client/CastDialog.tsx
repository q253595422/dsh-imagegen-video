/**
 * 身份参考的设置：给一张已经生成好的图起个名字、选个角色，钉住它。
 *
 * 面板本身不生成、不保存——它只把一条 `metadata.cast` 交回去。这样「谁是
 * 阿禾」只有一个答案，就在那个节点上，改脸也只需要重拍那个节点。
 */

import { useState } from 'react'
import css from './cast-dialog.module.css'
import { castPromptKey, ROLE_LABELS, ROLE_ORDER, type CastMember } from './cast.ts'
import { tt } from './helpers.ts'
import type { CanvasCastRole } from '../protocol.ts'

export interface CastDialogProps {
  /** 节点标题，作为名字的默认值。 */
  title: string
  /** 已有的钉住状态；`undefined` 表示还没钉。 */
  current?: { role: CanvasCastRole; name?: string }
  onCancel: () => void
  /** 传 `undefined` 表示取消钉住。 */
  onSave: (member: { role: CanvasCastRole; name?: string } | undefined) => void
}

export function CastDialog(props: CastDialogProps): React.JSX.Element {
  const [role, setRole] = useState<CanvasCastRole>(props.current?.role ?? 'character')
  const [name, setName] = useState(props.current?.name ?? props.title)
  const trimmed = name.trim()

  return <div className={css.panel} data-cast-dialog="" role="dialog" aria-label={tt('canvas.cast.pin')}>
    <header className={css.header}>
      <strong>{tt('canvas.cast.pin')}</strong>
      <span className={css.spacer} />
      <button type="button" className={css.ghost} onClick={props.onCancel}>{tt('canvas.close')}</button>
      {props.current === undefined ? null : <button
        type="button"
        className={css.ghost}
        data-cast-unpin=""
        onClick={() => { props.onSave(undefined) }}
      >{tt('canvas.cast.unpin')}</button>}
      <button
        type="button"
        className={css.primary}
        data-cast-save=""
        disabled={trimmed === ''}
        onClick={() => { props.onSave({ role, name: trimmed }) }}
      >{tt('canvas.cast.pin')}</button>
    </header>
    <div className={css.body}>
      <label className={css.field}>
        <span>{tt('canvas.cast.role')}</span>
        <select
          aria-label={tt('canvas.cast.role')}
          value={role}
          onChange={event => { setRole(event.target.value as CanvasCastRole) }}
        >
          {ROLE_ORDER.map(item => <option key={item} value={item}>{tt(ROLE_LABELS[item])}</option>)}
        </select>
      </label>
      <label className={css.field}>
        <span>{tt('canvas.cast.name')}</span>
        <input
          aria-label={tt('canvas.cast.name')}
          value={name}
          placeholder={props.title}
          onChange={event => { setName(event.target.value) }}
        />
      </label>
      {/* 预览真实的提示词那一句：用户按「钉住」之前该看到它到底说了什么。 */}
      <p className={css.preview} data-cast-preview="">{tt(castPromptKey(role), { index: 1, name: trimmed })}</p>
    </div>
  </div>
}

/** 提示词里的一句身份说明，供画布拼进最终 prompt。 */
export function castLine(member: CastMember, index: number): string {
  return tt(castPromptKey(member.role), { index, name: member.name })
}
