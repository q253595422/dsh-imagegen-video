/**
 * 画布技能相关的弹窗与卡片：选择器、配置表单、技能库、润色菜单、确认卡。
 *
 * 从 CanvasWorkspace.tsx 原样搬出。这批组件只接 props、回回调——不读画布
 * document、不发请求、不碰手势，所以搬出来不需要搭上下文。
 *
 * `composeGlyphs` 与 `tierLabel` 是它们私有的小工具（①②③ 序号与三档标签），
 * 一并搬来、不导出：它们只服务于这里的展示。
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type {
  CanvasSkillConfigApplyResult, CanvasSkillConfigField, CanvasSkillConfigSaveResult,
  CanvasSkillConfigStep, CanvasSkillConfigView, CanvasSkillDescriptor, CanvasSkillLibrary,
  CanvasNode, CanvasSkillOutput, CanvasSkillRunRequest, CanvasSkillTask,
} from '../../protocol.ts'
import { fileSizeLabel } from '../CanvasFilePreview.tsx'
import { tt } from '../helpers.ts'
import { Select } from '../Select.tsx'
import { ToolbarIcon } from './dock-controls.tsx'
import type { Point } from './geometry.ts'
import css from '../canvas-workspace.module.css'


/** The clip stitcher: the `local` skill the host runs with ffmpeg. */
export const COMPOSE_SKILL_ID = 'compose.videos'
/** Circled numerals standing in for the clip order in the confirm card. */
const COMPOSE_GLYPHS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']

/** The ①②③ sequence shown in the confirm card, in badge order. */
export function composeGlyphs(count: number): string {
  const shown = COMPOSE_GLYPHS.slice(0, count).join('')
  return count > COMPOSE_GLYPHS.length ? `${shown}…` : shown
}

/** Tier label for the picker row and the run card. Three tiers, not two. */
export function tierLabel(tier: CanvasSkillDescriptor['tier']): string {
  if (tier === 'heavy') return tt('canvas.skills.tierHeavy')
  if (tier === 'local') return tt('canvas.skills.tierLocal')
  return tt('canvas.skills.tierLight')
}

/**
 * Modal picker for the canvas skill catalog. Built-in actions come first, then
 * every host skill; incompatible entries stay visible but disabled so the menu
 * explains itself instead of hiding.
 */
export function SkillPicker(props: {
  anchor: Point
  nodeType: CanvasNode['type']
  /** Title of the node the menu was opened on (shown in the header). */
  targetTitle: string
  catalog: { skills: CanvasSkillDescriptor[]; reason?: string } | null
  loading: boolean
  /** Number of nodes the run will cover (1 = the acting node). */
  batchCount: number
  /** Clips a stitch run would cover right now (0 when the action cannot run). */
  composeCount: number
  /** Host-skill names the registry exposes; undefined = registry unavailable. */
  installed?: ReadonlySet<string>
  onPick: (skill: CanvasSkillDescriptor) => void
  /** Open the library installer prefilled with one entry's upstream. */
  onInstall: (skill: CanvasSkillDescriptor) => void
  /** Open the skill library focused on one skill's configuration form. */
  onConfigure: (skill: CanvasSkillDescriptor) => void
  onClose: () => void
  /** Mount node. Inside the canvas root so fullscreen keeps it on top. */
  container: HTMLElement | null
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const term = query.trim().toLowerCase()
  const skills = (props.catalog?.skills ?? []).filter(skill => term === ''
    || skill.name.toLowerCase().includes(term)
    || skill.description.toLowerCase().includes(term))
  // A node whose type the skill accepts is not always enough: stitching needs
  // at least two clips, and a single selected clip is greyed out rather than
  // offered and then refused by the host.
  const compatible = (skill: CanvasSkillDescriptor): boolean => props.nodeType === 'config'
    ? false
    : !skill.accepts.includes(props.nodeType) ? false
      : skill.id === COMPOSE_SKILL_ID ? props.composeCount >= 2
        : true
  // The skills this node can actually run come first inside every group, so a
  // mis-click never lands on a greyed-out row sitting on top of the menu.
  const byFit = (a: CanvasSkillDescriptor, b: CanvasSkillDescriptor): number =>
    Number(compatible(b)) - Number(compatible(a))
  const builtin = skills.filter(skill => skill.origin === 'builtin').sort(byFit)
  const external = skills.filter(skill => skill.origin === 'external').sort(byFit)
  const missing = (skill: CanvasSkillDescriptor): boolean => props.installed !== undefined
    && skill.skillName !== undefined
    && !props.installed.has(skill.skillName)
  const row = (skill: CanvasSkillDescriptor): React.JSX.Element => {
    const needsInstall = missing(skill)
    const needsConfig = !needsInstall && (skill.configMissing?.length ?? 0) > 0
    const title = needsInstall
      ? tt('canvas.skills.missingHint', { name: skill.skillName ?? skill.name })
      : compatible(skill) ? skill.description : tt('canvas.skills.incompatible')
    return <div key={skill.id} className={css.skillRow} data-disabled={compatible(skill) ? undefined : ''}>
      {/* `light` is one chat call; `heavy` and `local` both run something
          longer than a completion, so they share the wand-that-does-work icon.
          No new ToolbarIconName: the union is closed on purpose. */}
      <span className={css.skillRowIcon}><ToolbarIcon name={skill.tier === 'light' ? 'skill' : 'sparkle'} size={15} /></span>
      <button
        type="button"
        role="menuitem"
        className={css.skillRowText}
        data-plain=""
        disabled={!compatible(skill) || needsInstall}
        title={title}
        onClick={() => props.onPick(skill)}
      >
        <strong>{skill.name}</strong>
        <small>
          {needsInstall
            ? tt('canvas.skills.missingHint', { name: skill.skillName ?? skill.name })
            : needsConfig ? tt('canvas.skills.configMissingHint', { fields: (skill.configMissing ?? []).join('、') })
              : skill.description}
        </small>
      </button>
      {needsInstall
        ? <button type="button" className={css.skillInstall} onClick={() => props.onInstall(skill)}>{tt('canvas.skills.installNow')}</button>
        : needsConfig
          ? <button type="button" className={css.skillInstall} onClick={() => props.onConfigure(skill)}>{tt('canvas.skills.configGo')}</button>
          : <span className={css.skillTier} data-tier={skill.tier}>
              {tierLabel(skill.tier)}
            </span>}
    </div>
  }
  const style: CSSProperties = {
    left: Math.max(8, Math.min(props.anchor.x, (globalThis.innerWidth || 1024) - 380)),
    top: Math.max(8, Math.min(props.anchor.y, (globalThis.innerHeight || 768) - 420)),
  }
  return createPortal(<>
    <div className={css.skillScrim} onPointerDown={props.onClose} />
    <div className={css.skillMenu} style={style} role="menu" aria-label={tt('canvas.skills.pickerTitle')}>
      <header className={css.skillMenuHeader}>
        <span className={css.skillMenuTitleGroup}>
          <span>{tt('canvas.skills.menuTitle')}</span>
          {props.targetTitle !== '' ? <small className={css.skillMenuSubtitle} title={props.targetTitle}>{tt('canvas.skills.runOn', { name: props.targetTitle })}</small> : null}
        </span>
        <button type="button" className={css.skillMenuClose} aria-label={tt('canvas.close')} onClick={props.onClose}><ToolbarIcon name="close" size={14} /></button>
      </header>
      <input
        className={css.skillSearch}
        value={query}
        autoFocus
        placeholder={tt('canvas.skills.searchPlaceholder')}
        onChange={event => setQuery(event.target.value)}
      />
      {props.batchCount > 1 ? <p className={css.skillBatch}>{tt('canvas.skills.batchNote', { count: props.batchCount })}</p> : null}
      <div className={css.skillList}>
        {props.loading && props.catalog === null ? <p className={css.skillHint}>{tt('canvas.skills.loading')}</p> : null}
        {!props.loading && skills.length === 0 ? <p className={css.skillHint}>{tt('canvas.skills.empty')}</p> : null}
        {builtin.length > 0 ? <p className={css.skillGroup}>{tt('canvas.skills.groupBuiltin')}</p> : null}
        {builtin.map(row)}
        {external.length > 0
          ? <p className={css.skillGroup}>{tt('canvas.skills.groupExternal')}</p>
          : props.catalog !== null && builtin.length > 0 ? <p className={css.skillHint}>{tt('canvas.skills.emptyExternal')}</p> : null}
        {external.map(row)}
      </div>
      {props.catalog?.reason !== undefined ? <p className={css.skillHint}>{props.catalog.reason}</p> : null}
    </div>
  </>, props.container ?? globalThis.document.body)
}

/**
 * The per-skill configuration form (see `docs/skill-config.md`).
 *
 * One skill declares its fields and how they take effect; this renders them and
 * offers two actions — save, or save-and-apply (which runs the declaration's own
 * commands / file writes host-side). Secret fields never round-trip: they show
 * only whether a value is stored, and the save request carries just the ones the
 * user touched.
 */
export function SkillConfigForm(props: {
  name: string
  config: CanvasSkillConfigView
  busy: boolean
  onSave: (name: string, values: Array<{ id: string; value: string }>) => Promise<CanvasSkillConfigSaveResult>
  onApply: (name: string) => Promise<CanvasSkillConfigApplyResult>
}): React.JSX.Element {
  const initial = (field: CanvasSkillConfigField): string => {
    if (field.type === 'secret') return ''
    return props.config.values.find(value => value.id === field.id)?.value ?? field.default ?? ''
  }
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(props.config.fields.map(field => [field.id, initial(field)])))
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())
  const [phase, setPhase] = useState<'idle' | 'saving' | 'applying'>('idle')
  const [steps, setSteps] = useState<CanvasSkillConfigStep[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // A reload replaces the entry with a fresh object: re-seed the drafts so the
  // form never shows stale values after a save or an external edit.
  const signature = props.config.fields.map(field => `${field.id}:${initial(field)}`).join('|')
  useEffect(() => {
    setDraft(Object.fromEntries(props.config.fields.map(field => [field.id, initial(field)])))
    setTouched(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
  const payload = (): Array<{ id: string; value: string }> => props.config.fields.flatMap(field => {
    if (field.type === 'secret') return touched.has(field.id) ? [{ id: field.id, value: draft[field.id] ?? '' }] : []
    return [{ id: field.id, value: draft[field.id] ?? '' }]
  })
  const save = async (apply: boolean): Promise<void> => {
    setPhase(apply ? 'applying' : 'saving')
    setMessage(null)
    setSteps(null)
    try {
      const saved = await props.onSave(props.name, payload())
      if (!saved.ok) {
        setMessage(saved.message ?? tt('canvas.skills.configSaveFailed'))
        return
      }
      if (!apply) {
        setMessage(tt('canvas.skills.configSaved'))
        return
      }
      const applied = await props.onApply(props.name)
      setSteps(applied.steps)
      setMessage(applied.ok ? tt('canvas.skills.configApplied') : applied.message ?? tt('canvas.skills.configApplyFailed'))
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPhase('idle')
    }
  }
  return <div className={css.skillConfig}>
    {props.config.note === undefined ? null : <p className={css.skillHint}>{props.config.note}</p>}
    {props.config.issue === undefined ? null : <p className={css.libraryEntryIssue}>{props.config.issue}</p>}
    <p className={css.skillHint}>{props.config.source === 'plugin' ? tt('canvas.skills.configSourcePlugin') : tt('canvas.skills.configSourceSkill')}</p>
    {props.config.fields.length === 0 ? null : <div className={css.skillConfigFields}>
      {props.config.fields.map(field => {
        const stored = props.config.values.find(value => value.id === field.id)
        const set = stored?.set === true && !touched.has(field.id)
        return <label key={field.id} className={css.skillConfigField}>
          <span className={css.skillConfigLabel}>
            {field.label}
            {field.required === true ? <em className={css.skillConfigRequired}>*</em> : null}
          </span>
          {field.type === 'select'
            ? <Select
                className={css.skillDialogInput}
                value={draft[field.id] ?? ''}
                disabled={props.busy || phase !== 'idle'}
                onChange={value => { setDraft(current => ({ ...current, [field.id]: value })); setTouched(current => new Set(current).add(field.id)) }}
              >
                {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            : <input
                className={css.skillDialogInput}
                type={field.type === 'secret' ? 'password' : 'text'}
                value={draft[field.id] ?? ''}
                placeholder={field.type === 'secret'
                  ? (set ? tt('canvas.skills.configSecretSet') : tt('canvas.skills.configSecretUnset'))
                  : field.default ?? ''}
                disabled={props.busy || phase !== 'idle'}
                onChange={event => { setDraft(current => ({ ...current, [field.id]: event.target.value })); setTouched(current => new Set(current).add(field.id)) }}
              />}
          <span className={css.skillConfigHint}>
            {field.description ?? ''}
            {field.type === 'secret' && set
              ? <button
                  type="button"
                  className={css.skillConfigClear}
                  disabled={props.busy || phase !== 'idle'}
                  onClick={() => { setDraft(current => ({ ...current, [field.id]: '' })); setTouched(current => new Set(current).add(field.id)) }}
                >{tt('canvas.skills.configClear')}</button>
              : null}
          </span>
        </label>
      })}
    </div>}
    <div className={css.libraryRow}>
      <button
        type="button"
        className={css.skillGhost}
        disabled={props.busy || phase !== 'idle'}
        onClick={() => { void save(false) }}
      >{phase === 'saving' ? tt('canvas.skills.configSaving') : tt('canvas.skills.configSave')}</button>
      {props.config.applicable
        ? <button
            type="button"
            className={css.skillPrimary}
            disabled={props.busy || phase !== 'idle'}
            onClick={() => { void save(true) }}
          >{phase === 'applying' ? tt('canvas.skills.configApplying') : tt('canvas.skills.configSaveApply')}</button>
        : null}
    </div>
    {message === null ? null : <p className={css.skillHint}>{message}</p>}
    {steps === null || steps.length === 0 ? null : <ul className={css.skillConfigSteps}>
      {steps.map((step, index) => <li key={`${index}-${step.detail}`} data-ok={step.ok ? '' : undefined}>
        <span>{step.kind === 'command' ? '▶' : '▤'} {step.detail}</span>
        {step.output === undefined ? null : <code>{step.output}</code>}
      </li>)}
    </ul>}
  </div>
}

/**
 * Skill library manager (dock entry 「技能库」). One dialog covers the whole
 * lifecycle: what is installed, install from URLs, install from an uploaded
 * archive, per-skill configuration declared by the skill itself, and uninstall.
 * Installs are obviously consequential (they write into the user's
 * `~/.dsh/skills`), so every action reports its own result instead of acting
 * silently.
 */
export function SkillLibraryDialog(props: {
  library: CanvasSkillLibrary | null
  loading: boolean
  busy: boolean
  /** Prefill for the URL field, e.g. the upstream of a skill just clicked. */
  presetUrl: string
  /** Skill whose configuration the user asked to open (from the node picker). */
  focusSkill?: string
  onReload: () => void
  onInstallUrls: (urls: string[], force: boolean) => void
  onInstallArchive: (file: File, force: boolean) => void
  onRemove: (name: string) => void
  onSaveConfig: (name: string, values: Array<{ id: string; value: string }>) => Promise<CanvasSkillConfigSaveResult>
  onApplyConfig: (name: string) => Promise<CanvasSkillConfigApplyResult>
  onClose: () => void
  /** Mount node. Inside the canvas root so fullscreen keeps it on top. */
  container: HTMLElement | null
}): React.JSX.Element {
  const [urls, setUrls] = useState(props.presetUrl)
  const [force, setForce] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [configOpen, setConfigOpen] = useState<string | null>(props.focusSkill ?? null)
  const archiveRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (props.presetUrl !== '') setUrls(props.presetUrl) }, [props.presetUrl])
  useEffect(() => { if (props.focusSkill !== undefined && props.focusSkill !== '') setConfigOpen(props.focusSkill) }, [props.focusSkill])
  const sourceList = urls.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  const entries = props.library?.entries ?? []
  const pickArchive = (file: File | undefined): void => {
    if (file !== undefined) props.onInstallArchive(file, force)
  }
  return createPortal(<>
    <div className={css.skillScrim} onPointerDown={props.onClose} />
    <div className={`${css.skillDialog} ${css.libraryDialog}`} role="dialog" aria-label={tt('canvas.skills.libraryTitle')}>
      <header className={css.skillMenuHeader}>
        <span className={css.skillMenuTitleGroup}>
          <span>{tt('canvas.skills.libraryTitle')}</span>
          {entries.length > 0 ? <small className={css.skillMenuSubtitle}>{tt('canvas.skills.libraryInstalled', { count: entries.length })}</small> : null}
        </span>
        <button type="button" className={css.skillMenuClose} aria-label={tt('canvas.close')} onClick={props.onClose}><ToolbarIcon name="close" size={14} /></button>
      </header>
      <div className={css.libraryBody}>
        <section className={css.librarySection}>
          <span className={css.librarySectionTitle}>{tt('canvas.skills.libraryInstall')}</span>
          <p className={css.skillHint}>{tt('canvas.skills.libraryInstallHint')}</p>
          <textarea
            className={css.skillDialogInput}
            rows={3}
            value={urls}
            placeholder={tt('canvas.skills.libraryUrlPlaceholder')}
            onChange={event => setUrls(event.target.value)}
          />
          <div className={css.libraryRow}>
            <label className={css.libraryCheck}>
              <input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />
              {tt('canvas.skills.libraryForce')}
            </label>
            <span style={{ flex: 1 }} />
            <button type="button" className={css.skillGhost} disabled={props.busy} onClick={props.onReload}>{tt('canvas.skills.libraryReload')}</button>
            <button
              type="button"
              className={css.skillPrimary}
              disabled={props.busy || sourceList.length === 0}
              onClick={() => props.onInstallUrls(sourceList, force)}
            >{props.busy ? tt('canvas.skills.libraryInstalling') : tt('canvas.skills.libraryInstallAction')}</button>
          </div>
          <div
            className={css.libraryDrop}
            data-active={dropActive ? '' : undefined}
            role="button"
            tabIndex={0}
            aria-label={tt('canvas.skills.libraryDropzone')}
            onClick={() => archiveRef.current?.click()}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') archiveRef.current?.click() }}
            onDragOver={event => { event.preventDefault(); setDropActive(true) }}
            onDragLeave={() => setDropActive(false)}
            onDrop={event => {
              event.preventDefault()
              setDropActive(false)
              pickArchive(event.dataTransfer.files?.[0])
            }}
          >
            <ToolbarIcon name="file" size={16} />
            <span>{tt('canvas.skills.libraryDropzone')}</span>
          </div>
          <input
            ref={archiveRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              pickArchive(file)
            }}
          />
        </section>
        <section className={css.librarySection}>
          <span className={css.librarySectionTitle}>{tt('canvas.skills.libraryInstalled', { count: entries.length })}</span>
          {props.library?.root !== undefined && props.library.root !== ''
            ? <p className={css.skillHint}>{tt('canvas.skills.libraryRoot', { root: props.library.root })}</p>
            : null}
          {props.loading && props.library === null ? <p className={css.skillHint}>{tt('canvas.skills.loading')}</p> : null}
          {!props.loading && entries.length === 0 ? <p className={css.skillHint}>{tt('canvas.skills.libraryEmpty')}</p> : null}
          {entries.length > 0 ? <div className={css.libraryList}>
            {entries.map(entry => <div key={entry.name} className={css.libraryEntryGroup}>
              <div className={css.libraryEntry}>
                <span className={css.skillRowIcon}><ToolbarIcon name="skill" size={15} /></span>
                <span className={css.libraryEntryText}>
                  <strong>{entry.name}</strong>
                  <small title={entry.description}>{entry.description === '' ? entry.name : entry.description}</small>
                  {entry.issue === undefined ? null : <small className={css.libraryEntryIssue}>{entry.issue}</small>}
                  {entry.config === undefined || entry.config.missing.length === 0 ? null : (
                    <small className={css.libraryEntryIssue}>{tt('canvas.skills.configMissingHint', { fields: entry.config.missing.join('、') })}</small>
                  )}
                </span>
                <span className={css.libraryEntryMeta}>{entry.sizeBytes > 0 ? fileSizeLabel(entry.sizeBytes) : ''}</span>
                {entry.config === undefined ? null : (
                  <button
                    type="button"
                    className={css.libraryRemove}
                    data-variant="config"
                    disabled={props.busy}
                    onClick={() => setConfigOpen(current => current === entry.name ? null : entry.name)}
                  >{tt('canvas.skills.configOpen')}</button>
                )}
                <button
                  type="button"
                  className={css.libraryRemove}
                  disabled={props.busy || removing !== null}
                  onClick={() => {
                    if (!globalThis.confirm(tt('canvas.skills.libraryRemoveConfirm', { name: entry.name }))) return
                    setRemoving(entry.name)
                    props.onRemove(entry.name)
                    window.setTimeout(() => setRemoving(null), 4_000)
                  }}
                >{removing === entry.name ? tt('canvas.skills.libraryRemoving') : tt('canvas.skills.libraryRemove')}</button>
              </div>
              {entry.config !== undefined && configOpen === entry.name
                ? <SkillConfigForm
                    name={entry.name}
                    config={entry.config}
                    busy={props.busy}
                    onSave={props.onSaveConfig}
                    onApply={props.onApplyConfig}
                  />
                : null}
            </div>)}
          </div> : null}
        </section>
      </div>
      <div className={css.skillDialogActions}>
        <button type="button" className={css.skillGhost} onClick={props.onClose}>{tt('canvas.close')}</button>
      </div>
    </div>
  </>, props.container ?? globalThis.document.body)
}

/**
 * Style menu behind the text node's ✨ button. One click applies the rewrite to
 * the node itself (Ctrl+Z restores the previous text), so the fastest path
 * needs no dialog; the custom row accepts an ad-hoc instruction.
 */
export function PolishMenu(props: {
  anchor: Point
  batchCount: number
  busy: boolean
  onPick: (style: string, instruction?: string) => void
  onClose: () => void
  /** Mount node. Inside the canvas root so fullscreen keeps it on top. */
  container: HTMLElement | null
}): React.JSX.Element {
  const [custom, setCustom] = useState('')
  const styles = (['formal', 'casual', 'shorter', 'expand'] as const).map(style => ({
    style,
    label: style === 'formal' ? tt('canvas.polish.formal') : style === 'casual' ? tt('canvas.polish.casual') : style === 'shorter' ? tt('canvas.polish.shorter') : tt('canvas.polish.expand'),
  }))
  const style: CSSProperties = {
    left: Math.max(8, Math.min(props.anchor.x, (globalThis.innerWidth || 1024) - 320)),
    top: Math.max(8, Math.min(props.anchor.y, (globalThis.innerHeight || 768) - 300)),
  }
  return createPortal(<>
    <div className={css.skillScrim} onPointerDown={props.onClose} />
    <div className={css.skillMenu} style={style} role="menu" aria-label={tt('canvas.polish.title')}>
      <header className={css.skillMenuHeader}>
        <span>{tt('canvas.polish.title')}</span>
        <button type="button" className={css.skillMenuClose} aria-label={tt('canvas.close')} onClick={props.onClose}><ToolbarIcon name="close" size={14} /></button>
      </header>
      {props.batchCount > 1 ? <p className={css.skillBatch}>{tt('canvas.skills.batchNote', { count: props.batchCount })}</p> : null}
      <div className={css.skillList}>
        {styles.map(item => <button
          key={item.style}
          type="button"
          role="menuitem"
          className={css.skillRow}
          disabled={props.busy}
          onClick={() => props.onPick(item.style)}
        >
          <span className={css.skillRowIcon}><ToolbarIcon name="sparkle" size={15} /></span>
          <span className={css.skillRowText}><strong>{item.label}</strong></span>
        </button>)}
      </div>
      <div className={css.polishCustom}>
        <textarea
          className={css.skillDialogInput}
          value={custom}
          placeholder={tt('canvas.polish.customPlaceholder')}
          onChange={event => setCustom(event.target.value)}
          onPointerDown={event => event.stopPropagation()}
        />
        <button
          type="button"
          className={css.skillPrimary}
          disabled={props.busy || custom.trim() === ''}
          onClick={() => props.onPick('custom', custom)}
        >{tt('canvas.polish.run')}</button>
      </div>
    </div>
  </>, props.container ?? globalThis.document.body)
}

/**
 * Confirmation shown before a skill run that commits real resources: a heavy
 * (headless-agent) run, or a `local` run such as stitching clips.
 *
 * The two differ in what they must say. A heavy run's body explains the agent
 * and its cost; a local run must instead show the ORDER it will use, because
 * that is the user's only chance to check the sequence before ffmpeg commits
 * to it. Reusing the agent copy for a local run would describe a run that does
 * not happen.
 */
export function SkillConfirmDialog(props: {
  skill: CanvasSkillDescriptor
  /** Clips a compose run would stitch, already in canvas order. */
  composeIds?: readonly string[]
  onConfirm: (instruction: string) => void
  onClose: () => void
  /** Mount node. Inside the canvas root so fullscreen keeps it on top. */
  container: HTMLElement | null
}): React.JSX.Element {
  const [instruction, setInstruction] = useState('')
  const requires = props.skill.requires ?? []
  const composeIds = props.composeIds
  const composing = composeIds !== undefined && composeIds.length > 0
  return createPortal(<>
    <div className={css.skillScrim} onPointerDown={props.onClose} />
    <div
      className={css.skillDialog}
      role="dialog"
      aria-modal="true"
      aria-label={composing ? tt('canvas.skills.compose') : tt('canvas.skills.confirmTitle')}
      {...composing ? { 'data-compose-card': '' } : {}}
    >
      {composing
        ? <>
            <h3>{tt('canvas.skills.compose')}</h3>
            <p className={css.skillDialogBody}>{tt('canvas.composeAsk', { count: composeIds.length })}</p>
            {/* The sequence here MUST match the badges on the nodes: this is
                the only moment the user can check the order before it runs. */}
            <p className={css.skillDialogNote} data-compose-order="">{tt('canvas.composeAskHint', { list: composeGlyphs(composeIds.length) })}</p>
            <p className={css.skillDialogNote}>{tt('canvas.skills.composeCost')}</p>
            <div className={css.skillDialogActions}>
              <button type="button" className={css.skillGhost} onClick={props.onClose}>{tt('canvas.skills.confirmCancel')}</button>
              <button type="button" className={css.skillPrimary} data-compose-run="" onClick={() => props.onConfirm(instruction)}>{tt('canvas.composeConfirm')}</button>
            </div>
          </>
        : <>
            <h3>{tt('canvas.skills.confirmTitle')}</h3>
            <p className={css.skillDialogBody}>{tt('canvas.skills.confirmBody', { name: props.skill.name })}</p>
            {props.skill.costHint !== undefined ? <p className={css.skillDialogNote}>{tt('canvas.skills.confirmCost', { hint: props.skill.costHint })}</p> : null}
            {requires.length > 0 ? <p className={css.skillDialogNote}>{tt('canvas.skills.confirmRequires', { list: requires.join('；') })}</p> : null}
            <textarea
              className={css.skillDialogInput}
              value={instruction}
              placeholder={tt('canvas.skills.extraInstruction')}
              onChange={event => setInstruction(event.target.value)}
            />
            <div className={css.skillDialogActions}>
              <button type="button" className={css.skillGhost} onClick={props.onClose}>{tt('canvas.skills.confirmCancel')}</button>
              <button type="button" className={css.skillPrimary} onClick={() => props.onConfirm(instruction)}>{tt('canvas.skills.confirmRun')}</button>
            </div>
          </>}
    </div>
  </>, props.container ?? globalThis.document.body)
}
