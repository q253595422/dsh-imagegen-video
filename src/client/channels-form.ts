/**
 * Staged form model for the channel list of the settings card. Mirrors the
 * CardForm staging pattern (dirty → one save) but for a structured value, so
 * the card can edit N channels, per-channel keys, and the default-channel
 * flag, then persist everything in one revision-fenced mutate call.
 *
 * Storage rules (dictated by dsh-settings semantics):
 *  - the whole `channels` array is written wholesale via `path: ['channels']`;
 *  - every channel's API key lives at `channelSecrets.<channelId>` (a secret
 *    dict), written per-key so untouched keys are never clobbered by a save
 *    the reader could not see (keys are redacted out of the wire view);
 *  - path ops never navigate *inside* the channels array.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ChannelConfig, ChannelProtocolPreference, ModelMapping, SubscriptionProvider } from '../protocol.ts'
import type { ImageGenScope, SettingsOp } from './settings-scope.ts'

/** One channel as the editor stages it (secrets never travel here). */
export interface ChannelDraft {
  id: string
  preset: string
  name: string
  apiUrl: string
  apiUrlFull: boolean
  /** Seedream 水印开关：缺省/true 表示开启，只有 false 会写入并透传给上游（#56）。 */
  watermark?: boolean
  protocol?: ChannelProtocolPreference
  auth?: 'api-key' | 'subscription'
  subscription?: SubscriptionProvider
  models: ModelMapping[]
  /** Video model catalog (alias → upstream id); independent of `models`. */
  videoModels?: ModelMapping[]
}

/** One staged key edit for a channel. */
export type KeyEdit = { kind: 'set'; value: string } | { kind: 'clear' }

/**
 * One reason a draft cannot be saved.
 *
 * The form model stays i18n-free: it names the field and the reason, and the
 * card maps the code to a localized sentence. `field` is also the focus
 * target, and the array is ordered by the order the fields appear on screen,
 * so "focus the first error" needs no second ordering rule.
 */
export interface ChannelIssue {
  field: 'apiUrl' | 'models'
  code: 'apiUrlRequired' | 'apiUrlScheme' | 'modelsRequired'
}

/**
 * Whether a draft would save a channel that cannot work, and why.
 *
 * Checked in the card BEFORE any request: an empty API URL used to travel all
 * the way to the settings mutation, where the Host rejected it with a message
 * the footer rendered as the generic 「保存失败，请重试」 — so the one thing the
 * user needed to fix was the one thing never named.
 *
 * @param draft - the staged channel as the editor holds it.
 * @returns every problem, in on-screen field order (empty when saveable).
 */
export function validateChannelDraft(draft: ChannelDraft): ChannelIssue[] {
  const issues: ChannelIssue[] = []
  // A subscription channel has no endpoint to fill in; its auth is the account.
  const subscriptionMode = draft.auth === 'subscription' && draft.subscription !== undefined
  if (!subscriptionMode) {
    const apiUrl = draft.apiUrl.trim()
    if (apiUrl === '') issues.push({ field: 'apiUrl', code: 'apiUrlRequired' })
    else if (!/^https?:\/\/\S+/i.test(apiUrl)) issues.push({ field: 'apiUrl', code: 'apiUrlScheme' })
  }
  // `stripChannel` drops blank aliases, so a list of blanks saves as a channel
  // with no models — selectable in the pickers and unusable at generate time.
  if (!draft.models.some(model => model.alias.trim() !== '')) issues.push({ field: 'models', code: 'modelsRequired' })
  return issues
}

/** What a save attempt did. */
export interface ChannelsSaveOutcome {
  /** Whether every staged edit reached the Host document. */
  ok: boolean
  /** Nothing was staged, so no write was attempted (not a failure). */
  noop?: boolean
  /** The Host's own words when `ok` is false; shown verbatim under the summary. */
  message?: string
}

/** The state the card renders. */
export interface ChannelsFormState {
  /** Staged channel list (the scope value when nothing is staged). */
  channels: ChannelDraft[]
  /** Which channels currently hold a stored secret (staged edits included). */
  keySet: Record<string, boolean>
  /** The effective default channel id. */
  defaultChannelId: string
  /** The effective default image-model alias (first model when unset). */
  defaultModel: string
  /** The effective default video-model alias (first video model when unset). */
  defaultVideoModel: string
  /** Whether a save would write anything. */
  dirty: boolean
  /** Whether the document accepts writes. */
  writable: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save failed (cleared by the next edit or save). */
  failed: boolean
  /** The Host's own words for the last failure, when it sent any. */
  error: string | null
  /** Per-channel blocking problems, keyed by channel id (empty = saveable). */
  issues: Record<string, ChannelIssue[]>
}

/** The actions the card's slot entry injects. */
export interface ChannelsFormActions {
  /** Replace the whole channel list (add/edit/remove go through here). */
  setChannels: (channels: ChannelDraft[]) => void
  /** Stage a key for one channel ('' clears; undefined = no staged change). */
  setChannelKey: (id: string, value: string | undefined) => void
  /** Stage the default-channel flag. */
  setDefaultChannel: (id: string) => void
  /** Stage the default image-model alias. */
  setDefaultModel: (model: string) => void
  /** Stage the default video-model alias. */
  setDefaultVideoModel: (model: string) => void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  commit: () => Promise<ChannelsSaveOutcome>
  /** Drop every staged edit. */
  discard: () => void
}

/** Deep equality over JSON-compatible data (the change predicate). */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqualJson(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => key in right && deepEqualJson(left[key], right[key]))
}

/** Trim and normalize a draft channel (models never carry empty aliases). */
function stripChannel(channel: ChannelDraft): ChannelDraft {
  const models = channel.models
    .map(model => ({ alias: model.alias.trim(), id: model.id.trim() === '' ? model.alias.trim() : model.id.trim() }))
    .filter(model => model.alias !== '')
  const videoModels = (channel.videoModels ?? [])
    .map(model => ({ alias: model.alias.trim(), id: model.id.trim() === '' ? model.alias.trim() : model.id.trim() }))
    .filter(model => model.alias !== '')
  return {
    id: channel.id,
    preset: channel.preset,
    name: channel.name.trim(),
    apiUrl: channel.apiUrl.trim(),
    apiUrlFull: channel.apiUrlFull === true,
    // 与设置 schema 的默认值保持一致，避免读到旧渠道时出现假的「有改动」状态。
    watermark: channel.watermark !== false,
    ...channel.protocol === undefined ? {} : { protocol: channel.protocol },
    ...channel.auth === undefined ? {} : { auth: channel.auth },
    ...channel.subscription === undefined ? {} : { subscription: channel.subscription },
    models: [...new Map(models.map(model => [model.alias, model])).values()],
    videoModels: [...new Map(videoModels.map(model => [model.alias, model])).values()],
  }
}

export class ChannelsForm {
  private stagedChannels: ChannelDraft[] | null = null
  private readonly stagedKeys = new Map<string, KeyEdit>()
  private stagedDefault: string | null = null
  private stagedDefaultModel: string | null = null
  private stagedDefaultVideoModel: string | null = null
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false
  private lastError: string | null = null

  constructor(private readonly scope: ImageGenScope) {
    scope.subscribe(() => { this.publish() })
    scope.subscribeSecretSets(() => { this.publish() })
  }

  /** Publish a projection of this form, rebuilt on every scope or draft change. */
  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createSnapshotStore(project())
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  /** Subscribe to staged and persisted channel changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The staged channel list, or the scope value when nothing is staged. */
  private channelsValue(): ChannelDraft[] {
    const view = this.scope.getSnapshot().value as { channels?: ChannelConfig[] } | undefined
    return this.stagedChannels ?? (Array.isArray(view?.channels) ? view.channels.map(toDraft) : [])
  }

  /** Whether a channel currently holds a stored or staged secret. */
  private keyHeld(id: string): boolean {
    const edit = this.stagedKeys.get(id)
    if (edit !== undefined) return edit.kind === 'set' && edit.value !== ''
    return this.scope.getSecretSetSnapshot(`channelSecrets.${id}`)
  }

  private defaultValue(): string {
    if (this.stagedDefault !== null) return this.stagedDefault
    const view = this.scope.getSnapshot().value as { defaultChannelId?: string } | undefined
    const channels = this.channelsValue()
    if (view?.defaultChannelId !== undefined && channels.some(channel => channel.id === view.defaultChannelId)) return view.defaultChannelId
    return channels[0]?.id ?? ''
  }

  private modelAliases(): string[] {
    return [...new Set(this.channelsValue().flatMap(channel => channel.models.map(model => model.alias)).filter(alias => alias !== ''))]
  }

  private defaultModelValue(): string {
    if (this.stagedDefaultModel !== null) return this.stagedDefaultModel
    const models = this.modelAliases()
    const view = this.scope.getSnapshot().value as { defaultModel?: string } | undefined
    if (typeof view?.defaultModel === 'string' && models.includes(view.defaultModel)) return view.defaultModel
    return models[0] ?? ''
  }

  private videoModelAliases(): string[] {
    return [...new Set(this.channelsValue().flatMap(channel => (channel.videoModels ?? []).map(model => model.alias)).filter(alias => alias !== ''))]
  }

  private defaultVideoModelValue(): string {
    if (this.stagedDefaultVideoModel !== null) return this.stagedDefaultVideoModel
    const models = this.videoModelAliases()
    const view = this.scope.getSnapshot().value as { defaultVideoModel?: string } | undefined
    if (typeof view?.defaultVideoModel === 'string' && models.includes(view.defaultVideoModel)) return view.defaultVideoModel
    return models[0] ?? ''
  }

  private dirtyValue(): boolean {
    const channels = this.channelsValue()
    const stagedChanged = this.stagedChannels !== null && !deepEqualJson(this.stagedChannels, scopeChannelsOf(this.scope))
    const scopeView = this.scope.getSnapshot().value as { defaultChannelId?: string; defaultModel?: string; defaultVideoModel?: string } | undefined
    const scopeDefault = scopeView?.defaultChannelId ?? channels[0]?.id ?? ''
    const defaultChanged = this.stagedDefault !== null && this.stagedDefault !== scopeDefault
    const models = this.modelAliases()
    const storedModel = typeof scopeView?.defaultModel === 'string' && models.includes(scopeView.defaultModel)
      ? scopeView.defaultModel
      : models[0] ?? ''
    const modelChanged = this.stagedDefaultModel !== null && this.stagedDefaultModel !== storedModel
    const videoModels = this.videoModelAliases()
    const storedVideo = typeof scopeView?.defaultVideoModel === 'string' && videoModels.includes(scopeView.defaultVideoModel)
      ? scopeView.defaultVideoModel
      : videoModels[0] ?? ''
    const videoChanged = this.stagedDefaultVideoModel !== null && this.stagedDefaultVideoModel !== storedVideo
    return stagedChanged || defaultChanged || modelChanged || videoChanged || this.stagedKeys.size > 0
  }

  /** The card-facing snapshot. */
  snapshot(): ChannelsFormState {
    const channels = this.channelsValue()
    const keySet: Record<string, boolean> = {}
    for (const channel of channels) keySet[channel.id] = this.keyHeld(channel.id)
    return {
      channels,
      keySet,
      defaultChannelId: this.defaultValue(),
      defaultModel: this.defaultModelValue(),
      defaultVideoModel: this.defaultVideoModelValue(),
      dirty: this.dirtyValue(),
      writable: this.scope.getSnapshot().writable !== false,
      saving: this.saving,
      failed: this.failed,
      error: this.lastError,
      issues: Object.fromEntries(channels.map(channel => [channel.id, validateChannelDraft(channel)])),
    }
  }

  /** The actions the card's slot registration injects. */
  actions(): ChannelsFormActions {
    return {
      setChannels: (channels) => { this.stageChannels(channels) },
      setChannelKey: (id, value) => { this.stageKey(id, value) },
      setDefaultChannel: (id) => { this.stagedDefault = id; this.clearFailure(); this.publish() },
      setDefaultModel: (model) => { this.stagedDefaultModel = model; this.clearFailure(); this.publish() },
      setDefaultVideoModel: (model) => { this.stagedDefaultVideoModel = model; this.clearFailure(); this.publish() },
      commit: () => this.commit(),
      discard: () => {
        if (this.stagedChannels === null && this.stagedKeys.size === 0 && this.stagedDefault === null && this.stagedDefaultModel === null && this.stagedDefaultVideoModel === null && !this.failed) return
        this.stagedChannels = null
        this.stagedKeys.clear()
        this.stagedDefault = null
        this.stagedDefaultModel = null
        this.stagedDefaultVideoModel = null
        this.clearFailure()
        this.publish()
      },
    }
  }

  // ------------------------------------------------------------------ staging

  /** Drop the recorded failure (every edit invalidates the reason it named). */
  private clearFailure(): void {
    this.failed = false
    this.lastError = null
  }

  private stageChannels(channels: ChannelDraft[]): void {
    const cleaned = channels.map(stripChannel)
    // A channel the list no longer contains must not keep a staged key edit:
    // a pending `set` would be written straight back to the id that was just
    // deleted, so the user who typed a key and then removed the channel would
    // get that key persisted instead of discarded. `planOps` emits the unset.
    const kept = new Set(cleaned.map(channel => channel.id))
    for (const id of [...this.stagedKeys.keys()]) {
      if (!kept.has(id)) this.stagedKeys.delete(id)
    }
    this.stagedChannels = cleaned
    this.clearFailure()
    this.publish()
  }

  /**
   * Channel ids this save drops from the persisted list.
   *
   * Deleting a channel used to be a plain `channels` rewrite, which left the
   * channel's plaintext key in `channelSecrets` with no UI entry left to clear
   * it. The save now derives the removals itself instead of trusting each
   * caller to remember.
   */
  private removedChannelIds(): string[] {
    if (this.stagedChannels === null) return []
    const kept = new Set(this.stagedChannels.map(channel => channel.id))
    return this.storedChannelIds().filter(id => !kept.has(id))
  }

  /** The persisted channel ids (the scope value, never the staged draft). */
  private storedChannelIds(): string[] {
    const stored = scopeChannelsOf(this.scope)
    if (!Array.isArray(stored)) return []
    return stored.flatMap((channel: unknown) => typeof channel === 'object' && channel !== null && typeof (channel as { id?: unknown }).id === 'string'
      ? [(channel as { id: string }).id]
      : [])
  }

  private stageKey(id: string, value: string | undefined): void {
    if (value === undefined || value.trim() === '') {
      if (this.keyHeld(id)) this.stagedKeys.set(id, { kind: 'clear' })
      // An empty key for a key-less channel stages nothing.
    } else {
      this.stagedKeys.set(id, { kind: 'set', value: value.trim() })
    }
    this.clearFailure()
    this.publish()
  }

  // ----------------------------------------------------------------- save

  /** Build the single batch of path ops a save performs. */
  private planOps(): SettingsOp[] {
    const ops: SettingsOp[] = []
    const removed = this.removedChannelIds()
    if (this.stagedChannels !== null) {
      ops.push({ op: 'set', path: ['channels'], value: this.stagedChannels })
      // Once channels exist, the legacy flat fields are obsolete (idempotent).
      ops.push({ op: 'unset', path: ['apiUrl'] })
      ops.push({ op: 'unset', path: ['apiKey'] })
      ops.push({ op: 'unset', path: ['imageModels'] })
    }
    // A removed channel takes its secret with it. `unset` (not `set`) is the
    // only op a removed id may ever appear in.
    for (const id of removed) ops.push({ op: 'unset', path: ['channelSecrets', id] })
    for (const [id, edit] of this.stagedKeys) {
      if (removed.includes(id)) continue
      if (edit.kind === 'set') ops.push({ op: 'set', path: ['channelSecrets', id], value: edit.value })
      else ops.push({ op: 'unset', path: ['channelSecrets', id] })
    }
    if (this.stagedDefault !== null) {
      ops.push({ op: 'set', path: ['defaultChannelId'], value: this.stagedDefault })
    } else if (this.stagedChannels !== null) {
      // The stored default may name a channel this very save removes. Left
      // alone it stays in cordis.patch.yml as a dangling id, and `resolve()`
      // only papers over it at read time.
      const remaining = this.stagedChannels.map(channel => channel.id)
      const storedDefault = this.scope.getSnapshot().value?.defaultChannelId ?? ''
      if (storedDefault !== '' && !remaining.includes(storedDefault)) {
        ops.push(remaining.length > 0
          ? { op: 'set', path: ['defaultChannelId'], value: remaining[0] }
          : { op: 'unset', path: ['defaultChannelId'] })
      }
    }
    if (this.stagedDefaultModel !== null) {
      ops.push(this.stagedDefaultModel === ''
        ? { op: 'unset', path: ['defaultModel'] }
        : { op: 'set', path: ['defaultModel'], value: this.stagedDefaultModel })
    } else if (this.stagedChannels !== null) {
      // Same dangling-default problem for the model aliases: reset to empty so
      // the stored config is honest. A later channel re-adding the same alias
      // must not silently inherit the old selection.
      const storedModel = this.scope.getSnapshot().value?.defaultModel ?? ''
      if (storedModel !== '' && !this.modelAliases().includes(storedModel)) {
        ops.push({ op: 'unset', path: ['defaultModel'] })
      }
    }
    if (this.stagedDefaultVideoModel !== null) {
      ops.push(this.stagedDefaultVideoModel === ''
        ? { op: 'unset', path: ['defaultVideoModel'] }
        : { op: 'set', path: ['defaultVideoModel'], value: this.stagedDefaultVideoModel })
    } else if (this.stagedChannels !== null) {
      const storedVideo = this.scope.getSnapshot().value?.defaultVideoModel ?? ''
      if (storedVideo !== '' && !this.videoModelAliases().includes(storedVideo)) {
        ops.push({ op: 'unset', path: ['defaultVideoModel'] })
      }
    }
    return ops
  }

  /**
   * Write every staged edit, then re-seed from what the Host accepted.
   *
   * The outcome is returned rather than only recorded, because the caller owes
   * the user an answer at the moment they pressed the button: a boolean in the
   * snapshot could only ever say 「保存失败」, never which field the Host
   * objected to.
   *
   * @returns what the write did, including the Host's message on failure.
   */
  async commit(): Promise<ChannelsSaveOutcome> {
    if (this.saving) return { ok: false, message: 'save already in progress' }
    const ops = this.planOps()
    if (ops.length === 0) return { ok: true, noop: true }
    this.saving = true
    this.clearFailure()
    this.publish()
    try {
      await this.scope.mutateOps(ops)
      this.stagedChannels = null
      this.stagedKeys.clear()
      this.stagedDefault = null
      this.stagedDefaultModel = null
      this.stagedDefaultVideoModel = null
      this.clearFailure()
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failed = true
      this.lastError = message
      return { ok: false, message }
    } finally {
      this.saving = false
      this.publish()
    }
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** Project a stored channel into a draft (secrets never travel in channels). */
function toDraft(channel: ChannelConfig): ChannelDraft {
  return { id: channel.id, preset: channel.preset, name: channel.name, apiUrl: channel.apiUrl, apiUrlFull: channel.apiUrlFull === true, watermark: channel.watermark !== false, ...channel.protocol === undefined ? {} : { protocol: channel.protocol }, ...channel.auth === undefined ? {} : { auth: channel.auth }, ...channel.subscription === undefined ? {} : { subscription: channel.subscription }, models: channel.models.map(model => ({ ...model })), videoModels: (channel.videoModels ?? []).map(model => ({ ...model })) }
}

/** The scope's current channels value (a plain array), for change detection. */
function scopeChannelsOf(scope: ImageGenScope): unknown {
  const view = scope.getSnapshot().value as { channels?: unknown } | undefined
  return Array.isArray(view?.channels) ? view.channels : []
}
