/** Configuration is owned by the installed skill's declaration/recipe. */
import { useEffect, useState, type ReactNode } from 'react'
import { ImageGenApi } from './api.ts'
import type { CanvasSkillConfigView, PptRuntimeStatus } from '../protocol.ts'
import { errorMessage, tt } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import css from './ppt-workspace.module.css'

export const PPT_SKILL_NAME = 'image-to-editable-ppt'
export const PPT_SKILL_URL = 'https://github.com/ningzimu/image-to-editable-ppt-skill'
const settingsApi = new ImageGenApi()

/**
 * One numbered setup step. The badge is the point of this dialog: a step that
 * is already satisfied says so, and a step that still needs work names what is
 * missing — the panel used to be three buttons whose disabled state explained
 * nothing, and a form that silently did not render when the skill declared no
 * fields.
 */
function SetupStep({ step, index, title, badge, tone, children }: {
  step: 'skill' | 'runtime' | 'config'
  index: string
  title: string
  badge?: string
  tone?: 'done' | 'todo'
  children: ReactNode
}) {
  return <section className={css.setupStep} data-ppt-step={step} data-ppt-step-state={tone ?? 'pending'}>
    <header className={css.stepHead}>
      <span className={css.stepIndex} aria-hidden="true">{index}</span>
      <strong>{title}</strong>
      {badge ? <span className={css.stepBadge} data-tone={tone ?? 'pending'}>{badge}</span> : null}
    </header>
    {children}
  </section>
}

export function PptSetup() {
  useImageGenLanguageTick()
  const [config, setConfig] = useState<CanvasSkillConfigView>()
  const [loaded, setLoaded] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [runtime, setRuntime] = useState<PptRuntimeStatus>()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const load = async (): Promise<void> => {
    const library = await settingsApi.canvasSkillLibrary()
    const entry = library.entries.find(entry => entry.name === PPT_SKILL_NAME)
    setInstalled(entry !== undefined)
    setConfig(entry?.config)
    setLoaded(true)
  }
  useEffect(() => { void load().catch(error => setMessage(errorMessage(error))) }, [])
  const act = (action: () => Promise<string>): void => {
    if (busy) return
    setBusy(true); setMessage('')
    void action().then(setMessage, error => {
      setMessage(errorMessage(error))
      // A failed install usually means the state the badges show is already
      // stale (a half-installed bundle, a runtime removed behind our back), so
      // re-read it instead of leaving the dialog claiming the old verdict.
      void load().catch(() => { /* the message above already carries the cause */ })
    }).finally(() => setBusy(false))
  }
  // Probing the runtime spawns a process on the host, so it happens only when
  // the user asks — never as a mount effect.
  const probe = (install: boolean): void => act(async () => {
    const result = await settingsApi.pptRuntime(install)
    setRuntime(result)
    return ''
  })
  const fields = config?.fields ?? []
  // Step three is optional by design: only a skill that declares fields has
  // anything to configure, and saying so beats a card that renders nothing.
  const configReason = configReasonOf()
  function configReasonOf(): string | undefined {
    if (fields.length > 0 || !loaded) return undefined
    return installed ? tt('ppt.setupNoConfig' as never) : `${tt('canvas.skills.needsInstall')} · ${PPT_SKILL_NAME}`
  }
  const form = config === undefined || config.fields.length === 0 ? null : <form onSubmit={event => {
    event.preventDefault(); act(async () => {
      await settingsApi.canvasSkillConfigSave({ name: PPT_SKILL_NAME, values: Object.entries(draft).filter(([id, value]) => value !== '' || config.fields.find(field => field.id === id)?.type !== 'secret').map(([id, value]) => ({ id, value })) })
      setDraft({}); await load()
      const applied = await settingsApi.canvasSkillConfigApply({ name: PPT_SKILL_NAME })
      if (!applied.ok) throw new Error(applied.message || applied.steps.filter(step => !step.ok).map(step => step.output || step.detail).join('\n'))
      return tt('ppt.configSaved')
    })
  }}>
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
  </form>
  return <div className={css.setup} data-ppt-setup="">
    <p>{tt('ppt.setupHint')} <a href={PPT_SKILL_URL} target="_blank" rel="noreferrer">image-to-editable-ppt ↗</a></p>
    <SetupStep step="skill" index="1" title={PPT_SKILL_NAME}
      tone={!loaded ? undefined : installed ? 'done' : 'todo'}
      badge={!loaded ? undefined : tt(installed ? 'ppt.installed' : 'canvas.skills.needsInstall')}>
      <div className={css.actions}>
        <button type="button" disabled={busy || !loaded} onClick={() => act(async () => {
          const result = await settingsApi.canvasSkillInstall({ sources: [PPT_SKILL_URL], force: installed })
          // A fresh bundle invalidates whatever we knew about its runtime.
          setRuntime(undefined)
          await load()
          return result.message || tt('ppt.installed')
        })}>{installed ? tt('ppt.updateSkill') : tt('ppt.installSkill')}</button>
      </div>
    </SetupStep>
    <SetupStep step="runtime" index="2" title="editppt"
      tone={runtime === undefined ? undefined : runtime.available ? 'done' : 'todo'}
      badge={runtime === undefined ? undefined : tt(runtime.available ? 'ppt.runtimeReady' : 'ppt.runtimeMissing')}>
      <small className={css.stepHint}>{tt('ppt.runtimeHint')}</small>
      <div className={css.actions}>
        <button type="button" disabled={busy || !installed} onClick={() => probe(true)}>{tt('ppt.installRuntime')}</button>
        <button type="button" disabled={busy} onClick={() => probe(false)}>{tt('ppt.checkRuntime')}</button>
      </div>
      {/* A disabled button has to say why: installing the runtime without the
          bundle would only produce a second, less useful failure. */}
      {installed ? null : <small className={css.reason}>{tt('canvas.skills.needsInstall')} · {PPT_SKILL_NAME}</small>}
      {runtime ? <small className={css.reason} data-ppt-runtime-status="" role="status">{runtime.message}</small> : null}
    </SetupStep>
    <SetupStep step="config" index="3" title={tt('ppt.settingsTitle')}
      tone={fields.length === 0 ? undefined : config?.missing.length ? 'todo' : 'done'}
      badge={fields.length === 0 ? undefined : config?.missing.length ? config.missing.join(' · ') : tt('ppt.configured')}>
      {configReason ? <small className={css.reason}>{configReason}</small> : null}
      {form}
    </SetupStep>
    {busy ? <p role="status">{tt('ppt.setupWorking')}</p> : null}
    {message ? <pre className={css.message} role="status">{message}</pre> : null}
  </div>
}
