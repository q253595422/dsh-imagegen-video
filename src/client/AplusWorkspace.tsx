/**
 * A+ 详情页 workspace: twelve modules, generated one at a time, stitched into a
 * single long PNG by the browser's own canvas.
 *
 * WHY a separate file: `ImageGenPanel.tsx` is 4400+ lines and is edited by more
 * than one author, so this surface lives here and the panel only wires it in
 * (type union, one nav item, one `onSelect` branch, one render line).
 *
 * The three decisions a reader should not have to reverse-engineer:
 *
 * 1. LAYOUT IS PURE AND ELSEWHERE. `composeAplusLayout` owns every number that
 *    decides where a block lands; this file only calls it and paints the result.
 *    That is what lets the arithmetic be asserted under jsdom, where no canvas
 *    exists, and keeps the Chromium test about pixels instead of geometry.
 *    See `aplus-layout.ts` and `aplus-draw.ts`.
 *
 * 2. CONCURRENCY 3, FAILURE PER BLOCK. Blocks are dispatched through a fixed
 *    pool of three and each one owns its own state, so a single upstream 500
 *    marks that block failed and leaves the rest of the batch running. There is
 *    no batch-wide abort, because the user paid for the other blocks.
 *
 * 3. THE HEIGHT CAP REFUSES, IT DOES NOT CROP. Over 16000px the export is
 *    refused with a message. Silently truncating would ship a detail page
 *    missing its closing banner, and downscaling would blur the whole sheet to
 *    save one module; both are worse than asking the user to narrow the width
 *    or drop a module.
 */
import { useEffect, useRef, useState } from 'react'
import type { ChannelConfig, GeneratedImage } from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import { ModelPicker, resolveModelChoice, type ModelPickerValue } from './ModelPicker.tsx'
import type { ImageModelGroup } from './settings-scope.ts'
import type { ImageGenKey } from './locales.ts'
import { APLUS_MAX_HEIGHT, composeAplusLayout } from './aplus-layout.ts'
import type { AplusCopyMap } from './aplus-text.ts'
import {
  AplusBandOverflow,
  aplusExportName,
  aspectOfImage,
  canvasToPngBlob,
  drawAplusBlocks,
  isCanvasSafeSource,
  loadAplusImage,
} from './aplus-draw.ts'
import css from './aplus-workspace.module.css'

/** One module of the twelve. `aspect` is width/height, used only as a fallback. */
interface AplusModuleDefinition {
  /** Stable identity, also the DOM marker for the row. */
  key: string
  nameKey: ImageGenKey
  guideKey: ImageGenKey
  /** Assumed width/height when the generated image reports no size. */
  aspect: number
  /** The aspect ratio string sent to the engine; it maps it per model. */
  size: string
}

/**
 * The first cut of twelve modules, in stitch order. No custom modules: an A+
 * page has a conventional reading order and a free-form list would produce
 * sheets whose sections cannot be compared across products.
 */
const MODULES: readonly AplusModuleDefinition[] = [
  { key: 'brand', nameKey: 'aplus.module.brand', guideKey: 'aplus.guide.brand', aspect: 16 / 9, size: '16:9' },
  { key: 'selling-point', nameKey: 'aplus.module.sellingPoint', guideKey: 'aplus.guide.sellingPoint', aspect: 4 / 3, size: '4:3' },
  { key: 'scene', nameKey: 'aplus.module.scene', guideKey: 'aplus.guide.scene', aspect: 4 / 3, size: '4:3' },
  { key: 'detail', nameKey: 'aplus.module.detail', guideKey: 'aplus.guide.detail', aspect: 1, size: '1:1' },
  { key: 'comparison', nameKey: 'aplus.module.comparison', guideKey: 'aplus.guide.comparison', aspect: 4 / 3, size: '4:3' },
  { key: 'steps', nameKey: 'aplus.module.steps', guideKey: 'aplus.guide.steps', aspect: 4 / 3, size: '4:3' },
  { key: 'model', nameKey: 'aplus.module.model', guideKey: 'aplus.guide.model', aspect: 3 / 4, size: '3:4' },
  { key: 'trust', nameKey: 'aplus.module.trust', guideKey: 'aplus.guide.trust', aspect: 4 / 3, size: '4:3' },
  { key: 'bundle', nameKey: 'aplus.module.bundle', guideKey: 'aplus.guide.bundle', aspect: 4 / 3, size: '4:3' },
  { key: 'spec', nameKey: 'aplus.module.spec', guideKey: 'aplus.guide.spec', aspect: 4 / 3, size: '4:3' },
  { key: 'faq', nameKey: 'aplus.module.faq', guideKey: 'aplus.guide.faq', aspect: 4 / 3, size: '4:3' },
  { key: 'closing', nameKey: 'aplus.module.closing', guideKey: 'aplus.guide.closing', aspect: 16 / 9, size: '16:9' },
]

/** Stitched width choices in px; the middle one matches a common detail page. */
const WIDTHS = [750, 970, 1200] as const

/** Gap between modules in px; 0 gives a continuous sheet. */
const GAPS = [0, 16, 32] as const

/** How many modules may be in flight at once. */
const CONCURRENCY = 3

/** Selected on first open: the part of the page a shopper actually reads first. */
const DEFAULT_CHOSEN: readonly string[] = ['brand', 'selling-point', 'scene', 'detail', 'comparison']

type AplusModuleState = 'idle' | 'generating' | 'done' | 'failed'

interface AplusModuleResult {
  state: AplusModuleState
  image?: GeneratedImage
  error?: string
}

/** One picked product reference image, shared by every module. */
interface AplusReference {
  name: string
  dataUrl: string
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('image read failed'))
    reader.onerror = reader.onabort = () => reject(new Error('image read failed'))
    reader.readAsDataURL(file)
  })
}

/**
 * Run `worker` over every item with at most `limit` in flight.
 *
 * Workers are expected to settle (never reject) — the pool is a throughput
 * control, not an error barrier, and `Promise.all` below would otherwise end the
 * whole batch on the first failure, which is exactly what must not happen.
 */
async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(runners)
}

export interface AplusWorkspaceProps {
  api: ImageGenApi
  active: boolean
  modelGroups: ImageModelGroup[]
  /** Undefined until a channel exists; `resolveModelChoice` handles that. */
  defaultChannelId: string | undefined
  /** Configured channels, kept for the same reason the replica form keeps them. */
  channels: ChannelConfig[]
  /** False when no channel is configured; the form still renders, submit is blocked. */
  connected: boolean
}

export function AplusWorkspace(props: AplusWorkspaceProps): React.JSX.Element {
  const { api, active, modelGroups, defaultChannelId, channels, connected } = props
  // Live language switching, same as every other workspace surface.
  useImageGenLanguageTick()

  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(DEFAULT_CHOSEN))
  const [captions, setCaptions] = useState<Record<string, string>>({})
  // Copy for the band painted under each block. Unlike `captions` (which feeds
  // the prompt) this never reaches the model or the protocol — it is drawn by
  // the canvas at export time and lives only in this component's state.
  const [copies, setCopies] = useState<AplusCopyMap>({})
  const [results, setResults] = useState<Record<string, AplusModuleResult>>({})
  const [product, setProduct] = useState<AplusReference | null>(null)
  const [choice, setChoice] = useState<ModelPickerValue | null>(null)
  const [width, setWidth] = useState<number>(970)
  const [gap, setGap] = useState<number>(16)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exported, setExported] = useState<string | null>(null)

  const productInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const resolved = resolveModelChoice(modelGroups, choice ?? undefined, defaultChannelId)
  const canGenerate = connected && resolved.model !== ''
  const chosenModules = MODULES.filter(module => chosen.has(module.key))
  const doneModules = chosenModules.filter(module => results[module.key]?.state === 'done')
  const anyGenerating = MODULES.some(module => results[module.key]?.state === 'generating')

  const setModule = (key: string, next: AplusModuleResult): void => {
    if (!mounted.current) return
    setResults(previous => ({ ...previous, [key]: next }))
  }

  const toggleModule = (key: string): void => {
    setChosen(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** The prompt the model sees: what the module is, then the user's own line. */
  const buildPrompt = (module: AplusModuleDefinition): string => {
    const guide = tt(module.guideKey)
    const name = tt(module.nameKey)
    const caption = (captions[module.key] ?? '').trim()
    // The guide is guidance, not a promise: it asks for room for a title or a
    // comparison column, but the model may still fill it.
    return caption === '' ? `${name}。${guide}` : `${name}。${guide}。${caption}`
  }

  const generateOne = async (module: AplusModuleDefinition): Promise<void> => {
    if (!canGenerate) {
      setModule(module.key, { state: 'failed', error: tt('aplus.error.noChannel') })
      return
    }
    setModule(module.key, { state: 'generating' })
    try {
      const sent = await api.generate({
        // The product reference, when present, is the same image for every
        // module, so the whole sheet stays visually consistent.
        mode: product === null ? 'text' : 'edit',
        model: resolved.model,
        prompt: buildPrompt(module),
        size: module.size,
        quality: 'auto',
        n: 1,
        detail: '',
        ...(resolved.channelId === '' ? {} : { channelId: resolved.channelId }),
        ...(product === null ? {} : { image: product.dataUrl, refName: product.name }),
      })
      const image = sent.images[0]
      if (image === undefined) {
        setModule(module.key, { state: 'failed', error: tt('aplus.error.noImage') })
        return
      }
      setModule(module.key, { state: 'done', image })
    } catch (caught) {
      setModule(module.key, { state: 'failed', error: errorMessage(caught) })
    }
  }

  const generateAll = (): void => {
    if (!canGenerate) {
      setExportError(tt('aplus.error.noChannel'))
      return
    }
    setExportError(null)
    setExported(null)
    // Only blocks that are not already in flight are queued; re-running a
    // finished batch would burn credits for identical output.
    const pending = chosenModules.filter(module => results[module.key]?.state !== 'generating')
    void runPool(pending, CONCURRENCY, module => generateOne(module))
  }

  const exportLongImage = async (): Promise<void> => {
    setExportError(null)
    setExported(null)
    if (doneModules.length === 0) {
      setExportError(tt('aplus.error.empty'))
      return
    }
    setExporting(true)
    try {
      // Load every block first: the real aspect ratio is only known after the
      // image decodes, and the layout must be complete before the canvas is
      // sized, otherwise the sheet height would be wrong by construction.
      let loaded: Array<{ module: AplusModuleDefinition; element: HTMLImageElement; aspect: number }>
      try {
        loaded = await Promise.all(doneModules.map(async module => {
          const image = results[module.key]?.image
          const source = image === undefined ? '' : `data:${image.mime};base64,${image.b64}`
          // A data URL is same-origin by definition, so it never needs CORS; the
          // branch exists for a source that is not local.
          const element = await loadAplusImage(source, !isCanvasSafeSource(source))
          return { module, element, aspect: aspectOfImage(element, module.aspect) }
        }))
      } catch {
        // A block that will not decode cannot be stitched, and a hole in the
        // middle of a detail page is worse than no page at all.
        setExportError(tt('aplus.error.draw'))
        return
      }
      const layout = composeAplusLayout({
        modules: loaded.map(item => ({ key: item.module.key, aspect: item.aspect })),
        width,
        gap,
      })
      if (layout.overflow) {
        // Refuse, with the real number so the user can judge how far over it is.
        setExportError(tt('aplus.guard'))
        return
      }
      const canvas = document.createElement('canvas')
      const images = new Map(loaded.map(item => [item.module.key, item.element]))
      const drawn = drawAplusBlocks(canvas, layout, images, copies)
      if (drawn.bandOverflow.length > 0) {
        // One module's copy will not fit in its band. The spec says refuse, not
        // truncate and not eat the picture, so the export stops here with the
        // module named — the sheet on disk would otherwise be missing a band
        // the user typed.
        setExportError(tt('aplus.copy.tooLong', { name: tt(MODULES.find(m => m.key === drawn.bandOverflow[0])?.nameKey ?? 'aplus.module.brand') }))
        return
      }
      const blob = await canvasToPngBlob(canvas)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = aplusExportName(new Date())
      anchor.click()
      // Released on the next task: revoking synchronously can cancel a download
      // that has not started writing yet.
      setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
      setExported(anchor.download)
    } catch (caught) {
      setExportError(errorMessage(caught))
    } finally {
      if (mounted.current) setExporting(false)
    }
  }

  const acceptProduct = async (files: FileList | null): Promise<void> => {
    const file = files?.[0]
    if (file === undefined) return
    try {
      const dataUrl = await readAsDataUrl(file)
      if (!mounted.current) return
      setProduct({ name: file.name, dataUrl })
    } catch (caught) {
      setExportError(errorMessage(caught))
    }
  }

  const exportDisabled = exporting || doneModules.length === 0 || resolved.model === ''

  return (
    <div className={css.root} data-aplus-workspace="true" hidden={!active}>
      <header className={css.intro}>
        <div>
          <h2>{tt('aplus.title')}</h2>
          <p>{tt('aplus.intro')}</p>
        </div>
        <span className={css.hint}>{tt('aplus.hint.concurrent', { count: CONCURRENCY })}</span>
      </header>

      <div className={css.body}>
        <section className={css.controls}>
          <div className={css.modelRow}>
            <ModelPicker
              groups={modelGroups}
              value={resolved}
              channelLabel={tt('aplus.model.channel')}
              modelLabel={tt('aplus.model.model')}
              emptyLabel={tt('aplus.model.empty')}
              channelPlaceholder={tt('aplus.model.channel')}
              ariaLabel={tt('aplus.model.aria')}
              disabled={!connected}
              onChange={setChoice}
            />
          </div>

          <div className={css.productRow}>
            <div className={css.fieldHead}>
              <span className={css.fieldLabel}>{tt('aplus.product')}</span>
              <span className={css.fieldNote}>{tt('aplus.productHint')}</span>
            </div>
            {product === null ? (
              <>
                <button type="button" className={css.drop} onClick={() => { productInput.current?.click() }}>
                  {tt('aplus.productAdd')}
                </button>
                <input
                  ref={productInput}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={event => {
                    void acceptProduct(event.target.files)
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
                    aria-label={tt('aplus.productRemove')}
                    onClick={() => { setProduct(null) }}
                  >×</button>
                </li>
              </ul>
            )}
          </div>

          <div className={css.exportRow}>
            <span className={css.fieldLabel}>{tt('aplus.width')}</span>
            <select
              className={css.select}
              value={String(width)}
              onChange={event => { setWidth(Number(event.target.value)) }}
            >
              {WIDTHS.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
            <span className={css.fieldLabel}>{tt('aplus.gap')}</span>
            <select
              className={css.select}
              value={String(gap)}
              onChange={event => { setGap(Number(event.target.value)) }}
            >
              {GAPS.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
            <button
              type="button"
              className={css.primary}
              data-testid="aplus-export"
              disabled={exportDisabled}
              onClick={() => { void exportLongImage() }}
            >
              {exporting ? tt('aplus.exporting') : tt('aplus.export')}
            </button>
          </div>

          <div className={css.exportRow}>
            <button type="button" className={css.secondary} data-testid="aplus-generate-all" disabled={!canGenerate || anyGenerating} onClick={generateAll}>
              {tt('aplus.generateAll')}
            </button>
            <button type="button" className={css.link} onClick={() => { setChosen(new Set(MODULES.map(module => module.key))) }}>
              {tt('aplus.selectAll')}
            </button>
            <button type="button" className={css.link} onClick={() => { setChosen(new Set()) }}>
              {tt('aplus.selectNone')}
            </button>
            <span className={css.fieldNote}>{tt('aplus.exportHint', { count: doneModules.length })}</span>
          </div>

          {/* The refusal, and only the refusal: no truncated sheet, no blur. */}
          {exportError !== null ? (
            <p className={css.guard} role="alert" data-testid="aplus-guard">{exportError}</p>
          ) : null}
          {exported !== null ? (
            <p className={css.done} role="status" data-testid="aplus-exported">{tt('aplus.exportDone', { name: exported })}</p>
          ) : null}
        </section>

        <section className={css.list}>
          {MODULES.map(module => {
            const result = results[module.key]
            const state = result?.state ?? 'idle'
            const image = result?.image
            const isChosen = chosen.has(module.key)
            return (
              <div key={module.key} className={css.row} data-module={module.key} data-state={state}>
                <input
                  type="checkbox"
                  className={css.check}
                  checked={isChosen}
                  onChange={() => { toggleModule(module.key) }}
                  aria-label={tt(module.nameKey)}
                />
                <span className={css.name}>{tt(module.nameKey)}</span>
                <span className={css.ratio}>{module.size}</span>
                <input
                  className={css.caption}
                  value={captions[module.key] ?? ''}
                  placeholder={tt('aplus.captionPlaceholder')}
                  onChange={event => {
                    const value = event.target.value
                    setCaptions(previous => ({ ...previous, [module.key]: value }))
                  }}
                />
                <button
                  type="button"
                  className={css.small}
                  disabled={!canGenerate || state === 'generating'}
                  onClick={() => { void generateOne(module) }}
                >
                  {state === 'generating'
                    ? tt('aplus.state.generating')
                    : state === 'done'
                      ? tt('aplus.regenerate')
                      : tt('aplus.generate')}
                </button>
                <span className={css.state} data-state={state}>
                  {state === 'idle' ? tt('aplus.state.idle') : state === 'done' ? tt('aplus.state.done') : state === 'failed' ? tt('aplus.state.failed') : ''}
                </span>
                {image !== undefined ? (
                  <img className={css.thumbImage} src={`data:${image.mime};base64,${image.b64}`} alt={tt(module.nameKey)} />
                ) : (
                  <span className={css.thumbEmpty} />
                )}
                {state === 'failed' && result?.error !== undefined ? (
                  <span className={css.rowError}>{result.error}</span>
                ) : null}
                {/* Copy band inputs. They feed the exported image only — never
                    the prompt — so they sit below the row's own controls and
                    carry a stable marker for the tests. */}
                <div className={css.copyRow}>
                  <input
                    className={css.copyTitle}
                    data-aplus-copy={`${module.key}-title`}
                    value={copies[module.key]?.title ?? ''}
                    placeholder={tt('aplus.copy.title')}
                    onChange={event => {
                      const value = event.target.value
                      setCopies(previous => ({ ...previous, [module.key]: { title: value, body: previous[module.key]?.body ?? '' } }))
                    }}
                  />
                  <textarea
                    className={css.copyBody}
                    data-aplus-copy={`${module.key}-body`}
                    rows={2}
                    value={copies[module.key]?.body ?? ''}
                    placeholder={tt('aplus.copy.body')}
                    onChange={event => {
                      const value = event.target.value
                      setCopies(previous => ({ ...previous, [module.key]: { title: previous[module.key]?.title ?? '', body: value } }))
                    }}
                  />
                </div>
              </div>
            )
          })}
        </section>
      </div>
      <p className={css.footnote}>{tt('aplus.limit', { max: APLUS_MAX_HEIGHT })}</p>
    </div>
  )
}
