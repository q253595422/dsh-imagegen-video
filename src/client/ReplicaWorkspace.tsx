/**
 * 爆款图复刻 (recreate-a-hit-image) workspace.
 *
 * WHY a separate file: `ImageGenPanel.tsx` is 4400+ lines and is edited by more
 * than one author, so this surface lives here and the panel only wires it in
 * (type union, one nav item, one `onSelect` branch, one render line).
 *
 * The two design decisions a reader should not have to reverse-engineer:
 *
 * 1. PICK LIMIT ≠ TRANSFER LIMIT. The form accepts up to 20 references because
 *    assembling a mood board is a real workflow. The number that reaches the
 *    model is decided by the selected adapter (host contract: `image` + four
 *    extras, and some families take only `image`). The gap is never silent: the
 *    form prints how many will be used, marks the rest as unused in the strip,
 *    and the same number is used to slice the request. See
 *    `replica-capacity.ts` and the `.capacity` block in the render.
 *
 * 2. THE TWO FIDELITY TIERS ARE STRUCTURALLY DIFFERENT, not two adjectives.
 *    `参考风格` emits prose. `高度复刻` emits labeled 【】 sections whose numbers
 *    come from measuring the first reference (aspect, visual-mass centroid,
 *    quiet band, palette shares, tone/contrast/saturation). The builder lives in
 *    `replica-prompt.ts` so it can be diffed without a browser. What it cannot
 *    do is reconstruct pixels — the prompt preview says so where it matters and
 *    the report states the limit rather than implying more.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChannelConfig, GeneratedImage } from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import { ModelPicker, resolveModelChoice, type ModelPickerValue } from './ModelPicker.tsx'
import type { ImageModelGroup } from './settings-scope.ts'
import {
  REPLICA_PICK_LIMIT,
  referenceCapacity,
  splitReferences,
} from './replica-capacity.ts'
import {
  REPLICA_FIDELITIES,
  REPLICA_KINDS,
  buildReplicaRequestPrompt,
  measureReference,
  type ReferenceFacts,
  type ReplicaDraft,
  type ReplicaFidelity,
  type ReplicaKind,
} from './replica-prompt.ts'
import css from './replica-workspace.module.css'

/** One picked reference image, held as a data URL for the request body. */
interface ReplicaReference {
  id: string
  name: string
  dataUrl: string
  bytes: number
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** The host accepts 24 MiB of JSON; keep the same per-file and total budget the
 *  edit form uses so a set that works there works here. */
const MAX_BYTES = 10 * 1024 * 1024
const TOTAL_BYTES = 16 * 1024 * 1024

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('image read failed'))
    reader.onerror = reader.onabort = () => reject(new Error('image read failed'))
    reader.readAsDataURL(file)
  })
}

export interface ReplicaWorkspaceProps {
  api: ImageGenApi
  active: boolean
  modelGroups: ImageModelGroup[]
  /** Undefined until a channel exists; `resolveModelChoice` handles that. */
  defaultChannelId: string | undefined
  /** Configured channels: the transfer limit is an adapter capability, not a constant. */
  channels: ChannelConfig[]
  /** False when no channel is configured; the form still renders, submit is blocked. */
  connected: boolean
}

export function ReplicaWorkspace(props: ReplicaWorkspaceProps): React.JSX.Element {
  const { api, active, modelGroups, defaultChannelId, channels, connected } = props
  // Live language switching, same as every other workspace surface.
  useImageGenLanguageTick()

  const [references, setReferences] = useState<ReplicaReference[]>([])
  const [product, setProduct] = useState<ReplicaReference | null>(null)
  const [kind, setKind] = useState<ReplicaKind>('ecommerce')
  const [fidelity, setFidelity] = useState<ReplicaFidelity>('style')
  const [extra, setExtra] = useState('')
  const [productText, setProductText] = useState('')
  const [quality, setQuality] = useState<'1k' | '2k'>('1k')
  const [count, setCount] = useState(1)
  const [choice, setChoice] = useState<ModelPickerValue | null>(null)
  const [facts, setFacts] = useState<ReferenceFacts | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outputs, setOutputs] = useState<GeneratedImage[]>([])
  const [dragging, setDragging] = useState(false)

  const fileInput = useRef<HTMLInputElement>(null)
  const productInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const nextId = useRef(0)
  /** Serial add queue: FileReader finishes out of order, selection order must not. */
  const queue = useRef(Promise.resolve())
  /** Invalidates in-flight reads so a cleared form cannot be refilled by a stale one. */
  const epoch = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; epoch.current += 1 }
  }, [])

  // The resolved target drives BOTH the visible capacity line and the slice
  // applied to the request, so the promise and the payload cannot disagree.
  const resolved = resolveModelChoice(modelGroups, choice ?? undefined, defaultChannelId)
  const channel: ChannelConfig | undefined = channels.find(item => item.id === resolved.channelId)
  // The product shot occupies one of the same slots, so it is counted here.
  // Telling the user "5 of 5 references" while silently dropping the product
  // would be the exact failure this block exists to prevent.
  const picked = references.length + (product === null ? 0 : 1)
  const capacity = referenceCapacity(resolved.model, channel, picked)

  const draft: ReplicaDraft = { kind, fidelity, product: productText, extra }
  const prompt = useMemo(
    () => buildReplicaRequestPrompt(draft, facts),
    // `draft` is rebuilt each render; the four primitive fields are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, fidelity, productText, extra, facts],
  )

  /**
   * Measure the FIRST reference only.
   *
   * The first image is the one the user reaches for first and the one the
   * request sends as `image` (the primary), so it is the only one whose layout
   * every adapter is guaranteed to see. Measuring the extras would produce
   * numbers for images that some models never receive.
   */
  const primaryReference = references[0]
  useEffect(() => {
    const url = primaryReference?.dataUrl
    if (url === undefined) { setFacts(null); return }
    let live = true
    setMeasuring(true)
    void measureReference(url)
      .then(result => { if (live && mounted.current) setFacts(result) })
      .catch(() => { if (live && mounted.current) setFacts(null) })
      .finally(() => { if (live && mounted.current) setMeasuring(false) })
    return () => { live = false }
  }, [primaryReference?.dataUrl])

  const accept = (files: FileList | File[] | null, setter: (next: ReplicaReference[]) => void, existing: ReplicaReference[], limit: number): void => {
    if (files === null) return
    const incoming = Array.from(files)
    if (incoming.length === 0) return
    const version = epoch.current
    queue.current = queue.current.then(async () => {
      if (version !== epoch.current) return
      let bytes = existing.reduce((sum, item) => sum + item.bytes, 0)
      const slots = Math.max(0, limit - existing.length)
      const accepted = incoming
        .filter(file => IMAGE_TYPES.has(file.type) && file.size > 0 && file.size <= MAX_BYTES)
        .slice(0, slots)
        .filter(file => {
          if (bytes + file.size > TOTAL_BYTES) return false
          bytes += file.size
          return true
        })
      if (accepted.length === 0) {
        if (mounted.current) setError(incoming.length > 0 && slots === 0
          ? tt('replica.error.pickLimit', { count: limit })
          : tt('replica.error.invalidFile'))
        return
      }
      if (accepted.length < incoming.length && mounted.current) {
        setError(tt('replica.error.pickLimit', { count: limit }))
      }
      const loaded = await Promise.allSettled(accepted.map(readAsDataUrl))
      if (version !== epoch.current || !mounted.current) return
      const additions: ReplicaReference[] = []
      loaded.forEach((result, index) => {
        if (result.status !== 'fulfilled') return
        additions.push({
          id: `replica-${++nextId.current}`,
          name: accepted[index]!.name,
          dataUrl: result.value,
          bytes: accepted[index]!.size,
        })
      })
      if (additions.length > 0) setter([...existing, ...additions])
    }).catch(() => { if (mounted.current) setError(tt('replica.error.invalidFile')) })
  }

  const removeReference = (id: string): void => {
    setReferences(previous => previous.filter(item => item.id !== id))
  }

  const clearReferences = (): void => {
    epoch.current += 1
    queue.current = Promise.resolve()
    setReferences([])
    setProduct(null)
    setFacts(null)
    setError(null)
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    if (!connected) { setError(tt('replica.error.noChannel')); return }
    setBusy(true)
    setError(null)
    try {
      const dataUrls = references.map(item => item.dataUrl)
      // The product shot joins the reference list AFTER the style references, so
      // the primary stays the image whose layout was measured. It is dropped by
      // the same slice when the adapter cannot carry it, and the capacity line
      // already told the user how many will survive.
      const all = product === null ? dataUrls : [...dataUrls, product.dataUrl]
      // Same number the capacity line promised, applied to the payload.
      const { primary, extras } = splitReferences(all, capacity.usable)
      const result = await api.generate({
        mode: primary === undefined ? 'text' : 'edit',
        model: resolved.model,
        prompt,
        // The replica tier pins the frame to the measured ratio whenever the
        // adapter can express it; the style tier leaves the frame free.
        size: fidelity === 'replica' && facts !== null ? facts.aspect : 'auto',
        quality,
        n: count,
        detail: '',
        ...(resolved.channelId === '' ? {} : { channelId: resolved.channelId }),
        ...(primary === undefined ? {} : { image: primary }),
        ...(extras.length === 0 ? {} : { images: extras }),
        ...(references[0] === undefined ? {} : { refName: references[0].name }),
      })
      if (!mounted.current) return
      setOutputs(result.images)
      if (result.historyError !== undefined) setError(result.historyError)
    } catch (caught) {
      if (mounted.current) setError(errorMessage(caught))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const submitDisabled = busy || !connected || resolved.model === '' || (references.length === 0 && productText.trim() === '')

  return (
    <div className={css.root} data-replica-workspace="true" hidden={!active}>
      <header className={css.intro}>
        <div>
          <h2>{tt('replica.title')}</h2>
          <p>{tt('replica.intro')}</p>
        </div>
      </header>

      <div className={css.body}>
        <form className={css.form} onSubmit={event => { event.preventDefault(); void submit() }}>
          {/* ------------------------------------------------ reference images */}
          <div className={css.field}>
            <div className={css.fieldHead}>
              <span className={css.fieldLabel}>{tt('replica.references')}</span>
              <span className={css.fieldNote}>{tt('replica.referencesHint', { count: REPLICA_PICK_LIMIT })}</span>
            </div>
            {references.length > 0 ? (
              <ul className={css.thumbs}>
                {references.map((item, index) => (
                  <li key={item.id} className={css.thumb} data-unused={index >= capacity.usable ? 'true' : 'false'}>
                    <img src={item.dataUrl} alt={item.name} />
                    <span className={css.thumbIndex}>{index + 1}</span>
                    <button
                      type="button"
                      className={css.thumbRemove}
                      aria-label={tt('replica.referenceRemove', { index: index + 1 })}
                      onClick={() => { removeReference(item.id) }}
                    >×</button>
                  </li>
                ))}
              </ul>
            ) : null}
            <button
              type="button"
              className={css.drop}
              data-over={dragging ? 'true' : 'false'}
              disabled={references.length >= REPLICA_PICK_LIMIT}
              onClick={() => { fileInput.current?.click() }}
              onDragOver={event => { event.preventDefault(); setDragging(true) }}
              onDragLeave={() => { setDragging(false) }}
              onDrop={event => {
                event.preventDefault()
                setDragging(false)
                accept(event.dataTransfer.files, setReferences, references, REPLICA_PICK_LIMIT)
              }}
            >
              {references.length >= REPLICA_PICK_LIMIT
                ? tt('replica.referencesFull', { count: REPLICA_PICK_LIMIT })
                : tt('replica.addReferences', { count: REPLICA_PICK_LIMIT })}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={event => {
                accept(event.target.files, setReferences, references, REPLICA_PICK_LIMIT)
                event.target.value = ''
              }}
            />
          </div>

          {/* The honesty block. Two states, both explicit: nothing dropped, or
              exactly how many of the picked references will not be sent and why. */}
          <div className={css.capacity} data-replica-capacity="" data-tone={capacity.dropped > 0 ? 'warn' : 'info'}>
            {capacity.dropped > 0 ? (
              <span>
                {tt('replica.capacity.dropped', { used: capacity.usable, picked })}
                {' '}
                <strong>{tt(`replica.capacity.reason.${capacity.reason}`)}</strong>
              </span>
            ) : (
              <span>
                {references.length === 0
                  ? tt('replica.capacity.none', { count: capacity.limit })
                  : tt('replica.capacity.all', { used: references.length, limit: capacity.usable })}
              </span>
            )}
          </div>

          {/* --------------------------------------------------- product photo */}
          <div className={css.field}>
            <div className={css.fieldHead}>
              <span className={css.fieldLabel}>{tt('replica.product')}</span>
              <span className={css.fieldNote}>{tt('replica.productHint')}</span>
            </div>
            {product === null ? (
              <>
                <button type="button" className={css.drop} onClick={() => { productInput.current?.click() }}>
                  {tt('replica.addProduct')}
                </button>
                <input
                  ref={productInput}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={event => {
                    accept(event.target.files, next => { setProduct(next[0] ?? null) }, [], 1)
                    event.target.value = ''
                  }}
                />
              </>
            ) : (
              <ul className={css.thumbs}>
                <li className={css.thumb}>
                  <img src={product.dataUrl} alt={product.name} />
                  <button
                    type="button"
                    className={css.thumbRemove}
                    aria-label={tt('replica.productRemove')}
                    onClick={() => { setProduct(null) }}
                  >×</button>
                </li>
              </ul>
            )}
            <input
              className={css.input}
              value={productText}
              placeholder={tt('replica.productPlaceholder')}
              onChange={event => { setProductText(event.target.value) }}
            />
          </div>

          {/* ------------------------------------------------------ replica kind */}
          <div className={css.field}>
            <span className={css.fieldLabel}>{tt('replica.kind')}</span>
            <div className={css.pills} role="radiogroup" aria-label={tt('replica.kind')}>
              {REPLICA_KINDS.map(option => (
                <button
                  key={option}
                  type="button"
                  className={css.fact}
                  role="radio"
                  aria-checked={kind === option}
                  data-selected={kind === option ? 'true' : 'false'}
                  onClick={() => { setKind(option) }}
                >{tt(`replica.kind.${option}`)}</button>
              ))}
            </div>
          </div>

          {/* ----------------------------------------------------- fidelity tier */}
          <div className={css.field}>
            <span className={css.fieldLabel}>{tt('replica.fidelity')}</span>
            <div className={css.pills} role="radiogroup" aria-label={tt('replica.fidelity')}>
              {REPLICA_FIDELITIES.map(option => (
                <button
                  key={option}
                  type="button"
                  className={css.fact}
                  role="radio"
                  aria-checked={fidelity === option}
                  data-selected={fidelity === option ? 'true' : 'false'}
                  onClick={() => { setFidelity(option) }}
                >{tt(`replica.fidelity.${option}`)}</button>
              ))}
            </div>
            <span className={css.fieldNote}>{tt(`replica.fidelityHint.${fidelity}`)}</span>
          </div>

          <div className={css.field}>
            <span className={css.fieldLabel}>{tt('replica.extra')}</span>
            <textarea
              className={css.textarea}
              value={extra}
              placeholder={tt('replica.extraPlaceholder')}
              onChange={event => { setExtra(event.target.value) }}
            />
          </div>

          {/* -------------------------------------------------- output settings */}
          <div className={css.field}>
            <span className={css.fieldLabel}>{tt('replica.model')}</span>
            <ModelPicker
              groups={modelGroups}
              value={resolved}
              channelLabel={tt('model.channel')}
              modelLabel={tt('model.label')}
              emptyLabel={tt('replica.noModel')}
              channelPlaceholder={tt('model.channelPlaceholder')}
              ariaLabel={tt('replica.model')}
              disabled={busy}
              onChange={value => { setChoice(value) }}
            />
          </div>

          <div className={css.field}>
            <span className={css.fieldLabel}>{tt('replica.quality')}</span>
            <div className={css.pills} role="radiogroup" aria-label={tt('replica.quality')}>
              {(['1k', '2k'] as const).map(option => (
                <button
                  key={option}
                  type="button"
                  className={css.fact}
                  role="radio"
                  aria-checked={quality === option}
                  data-selected={quality === option ? 'true' : 'false'}
                  onClick={() => { setQuality(option) }}
                >{tt(`quality.${option}`)}</button>
              ))}
            </div>
          </div>

          <div className={css.field}>
            <span className={css.fieldLabel}>{tt('replica.count')}</span>
            <div className={css.pills} role="radiogroup" aria-label={tt('replica.count')}>
              {[1, 2, 3, 4].map(option => (
                <button
                  key={option}
                  type="button"
                  className={css.fact}
                  role="radio"
                  aria-checked={count === option}
                  data-selected={count === option ? 'true' : 'false'}
                  onClick={() => { setCount(option) }}
                >{option}</button>
              ))}
            </div>
          </div>

          <div className={css.submitBar}>
            {references.length > 0 ? (
              <button type="button" className={css.fact} onClick={clearReferences}>{tt('replica.clear')}</button>
            ) : null}
            <button
              type="submit"
              className={css.fact}
              data-primary="true"
              disabled={submitDisabled}
            >{busy ? tt('replica.generating') : tt('replica.generate')}</button>
            <span className={css.fieldNote}>
              {picked === 0
                ? tt('replica.submitHintEmpty', { limit: capacity.limit })
                : tt('replica.submitHint', { used: Math.min(capacity.usable, picked), picked })}
            </span>
            {error !== null ? <p className={css.error}>{error}</p> : null}
          </div>
        </form>

        <section className={css.results}>
          {/* ---------------------------------------------- measured reference */}
          {primaryReference !== undefined ? (
            <div className={css.promptBox}>
              <header>
                <span>{tt('replica.facts.title')}</span>
                <span>{measuring ? tt('replica.facts.measuring') : facts === null ? tt('replica.facts.failed') : tt('replica.facts.source')}</span>
              </header>
              {facts === null ? (
                <p className={css.fieldNote}>{tt('replica.facts.failedHint')}</p>
              ) : (
                <ul className={css.facts}>
                  <li className={css.fact}>{tt('replica.facts.aspect')} {facts.aspect}</li>
                  <li className={css.fact}>{tt('replica.facts.subject')} {facts.subject.x.toFixed(2)} / {facts.subject.y.toFixed(2)}</li>
                  <li className={css.fact}>{tt('replica.facts.spread')} {facts.subject.spread.toFixed(2)}</li>
                  <li className={css.fact}>{tt('replica.facts.quiet')} {facts.quiet === null
                    ? tt('replica.facts.quietNone')
                    : `${Math.round(facts.quiet.start * 100)}%–${Math.round(facts.quiet.end * 100)}%`}</li>
                  <li className={css.fact}>{tt('replica.facts.tone')} {facts.brightness.toFixed(2)}</li>
                  <li className={css.fact}>{tt('replica.facts.contrast')} {facts.contrast.toFixed(2)}</li>
                  <li className={css.fact}>{tt('replica.facts.saturation')} {facts.saturation.toFixed(2)}</li>
                  <li className={css.fact}>
                    <ul className={css.swatches}>
                      {facts.palette.slice(0, 4).map(entry => (
                        <li key={entry.hex} className={css.swatch} style={{ backgroundColor: entry.hex }} title={`${entry.hex} · ${Math.round(entry.share * 100)}%`} />
                      ))}
                    </ul>
                  </li>
                </ul>
              )}
            </div>
          ) : null}

          {/* ---------------------------------------------------- prompt preview */}
          <div className={css.promptBox}>
            <header>
              <span>{tt('replica.prompt.title')}</span>
              <span>{tt(`replica.prompt.tier.${fidelity}`)}</span>
            </header>
            <pre className={css.promptText} data-replica-prompt="true">{prompt}</pre>
          </div>

          {/* ------------------------------------------------------------ outputs */}
          {outputs.length > 0 ? (
            <div className={css.outputs}>
              {outputs.map((image, index) => (
                <img
                  key={`${index}-${image.b64.slice(0, 12)}`}
                  className={css.output}
                  src={`data:${image.mime};base64,${image.b64}`}
                  alt={tt('replica.outputAlt', { index: index + 1 })}
                />
              ))}
            </div>
          ) : (
            <div className={css.empty}>{tt('replica.empty')}</div>
          )}
        </section>
      </div>
    </div>
  )
}
