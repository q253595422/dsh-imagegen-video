/** Configuration is owned by the installed skill's declaration/recipe. */
import { useEffect, useState } from 'react'
import { ImageGenApi } from './api.ts'
import type { CanvasSkillConfigView } from '../protocol.ts'
import { errorMessage, tt } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import css from './ppt-workspace.module.css'

export const PPT_SKILL_NAME = 'image-to-editable-ppt'
export const PPT_SKILL_URL = 'https://github.com/ningzimu/image-to-editable-ppt-skill'
const settingsApi = new ImageGenApi()

export function PptSetup() {
  useImageGenLanguageTick()
  const [config, setConfig] = useState<CanvasSkillConfigView>()
  const [installed, setInstalled] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const load = async (): Promise<void> => {
    const library = await settingsApi.canvasSkillLibrary()
    const entry = library.entries.find(entry => entry.name === PPT_SKILL_NAME)
    setInstalled(entry !== undefined)
    setConfig(entry?.config)
  }
  useEffect(() => { void load().catch(error => setMessage(errorMessage(error))) }, [])
  const act = (action: () => Promise<string>): void => {
    if (busy) return
    setBusy(true); setMessage('')
    void action().then(setMessage, error => setMessage(errorMessage(error))).finally(() => setBusy(false))
  }
  return <div className={css.setup} data-ppt-setup="">
    <p>{tt('ppt.setupHint')} <a href={PPT_SKILL_URL} target="_blank" rel="noreferrer">image-to-editable-ppt ↗</a></p>
    <div className={css.actions}>
      <button type="button" disabled={busy} onClick={() => act(async () => {
        const result = await settingsApi.canvasSkillInstall({ sources: [PPT_SKILL_URL], force: installed })
        await load()
        return result.message || tt('ppt.installed')
      })}>{installed ? tt('ppt.updateSkill') : tt('ppt.installSkill')}</button>
      <button type="button" disabled={busy || !installed} onClick={() => act(async () => {
        const result = await settingsApi.pptRuntime(true)
        return `${tt(result.available ? 'ppt.runtimeReady' : 'ppt.runtimeMissing')}\n${result.message}`
      })}>{tt('ppt.installRuntime')}</button>
      <button type="button" disabled={busy} onClick={() => act(async () => {
        const result = await settingsApi.pptRuntime()
        return `${tt(result.available ? 'ppt.runtimeReady' : 'ppt.runtimeMissing')}\n${result.message}`
      })}>{tt('ppt.checkRuntime')}</button>
    </div>
    <p>{tt('ppt.runtimeHint')}</p>
    {config ? <form onSubmit={event => { event.preventDefault(); act(async () => {
      await settingsApi.canvasSkillConfigSave({ name: PPT_SKILL_NAME, values: Object.entries(draft).filter(([id, value]) => value !== '' || config.fields.find(field => field.id === id)?.type !== 'secret').map(([id, value]) => ({ id, value })) })
      setDraft({}); await load()
      const applied = await settingsApi.canvasSkillConfigApply({ name: PPT_SKILL_NAME })
      if (!applied.ok) throw new Error(applied.message || applied.steps.filter(step => !step.ok).map(step => step.output || step.detail).join('\n'))
      return tt('ppt.configSaved')
    }) }}>
      <p>{config.note}</p>
      {config.fields.map(field => {
        const stored = config.values.find(value => value.id === field.id)
        return <label key={field.id} className={css.field}>
          <span>{field.label}{stored?.set && field.type === 'secret' ? ` · ${tt('ppt.configured')}` : ''}</span>
          {field.type === 'select' ? <select disabled={busy} value={draft[field.id] ?? stored?.value ?? field.default ?? ''} onChange={event => setDraft(previous => ({ ...previous, [field.id]: event.target.value }))}>
            {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select> : <input disabled={busy} type={field.type === 'secret' ? 'password' : 'text'} autoComplete="off" value={draft[field.id] ?? (field.type === 'secret' ? '' : stored?.value ?? field.default ?? '')}
            placeholder={field.type === 'secret' && stored?.set ? tt('ppt.secretUnchanged') : field.default}
            onChange={event => setDraft(previous => ({ ...previous, [field.id]: event.target.value }))} />}
          {field.description ? <small>{field.description}</small> : null}
        </label>
      })}
      <a href="https://aistudio.baidu.com/account/accessToken" target="_blank" rel="noreferrer">{tt('ppt.paddleLink')} ↗</a>
      <div className={css.actions}><button type="submit" disabled={busy}>{tt('ppt.saveConfig')}</button></div>
    </form> : null}
    {busy ? <p role="status">{tt('ppt.setupWorking')}</p> : null}
    {message ? <pre className={css.message} role="status">{message}</pre> : null}
  </div>
}
