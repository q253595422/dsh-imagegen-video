/** Bounded, display-only progress from host events and upstream editppt records. */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CanvasSkillTask, PptTaskProgress } from './protocol.ts'
import type { SkillAgentSession } from './skill-runner.ts'
import type { CatalogTranslate } from './skills-catalog.ts'

/**
 * Record one user-visible execution event on a PPT task.
 *
 * Only `ppt` tasks carry progress (canvas runs have no page pipeline), the log
 * is capped so a long run cannot grow the task snapshot without bound, and the
 * timestamp doubles as the "last activity" the card shows — so a caller must
 * only call this for real observed activity, never for a poll that found
 * nothing new.
 */
export function pptActivity(task: CanvasSkillTask, label: string, state: 'running' | 'done' | 'warning' = 'running', at = Date.now()): void {
  if (task.canvasId !== 'ppt') return
  const progress = task.progress ??= { lastActivityAt: at, events: [] }
  progress.lastActivityAt = at
  progress.currentOperation = label
  progress.events.push({ time: at, label, state })
  progress.events = progress.events.slice(-40)
}

/**
 * Map one tool call onto a known upstream pipeline step.
 *
 * Returns a copy key, or undefined when the command is not one of the upstream
 * editppt verbs — a generic tool label is better than echoing an arbitrary
 * shell command, which could carry paths, tokens or user content.
 */
function toolOperation(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 20000) return undefined
  let args: any
  try { args = JSON.parse(raw) } catch { return undefined }
  if (!args || typeof args !== 'object') return undefined
  const command = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : Array.isArray(args.argv) ? args.argv.filter((value: unknown) => typeof value === 'string').join(' ') : ''
  const text = command.replace(/["']/g, '')
  const patterns: Array<[RegExp, string]> = [
    [/(?:editppt(?:\.exe)?\s+prepare|prepare_deck_run\.py)/i, 'ppt.activityPreparing'],
    [/(?:editppt(?:\.exe)?\s+page\s+hints|deck_text_hints\.py)/i, 'ppt.activityTextHints'],
    [/(?:editppt(?:\.exe)?\s+image\s+(?:edit|generate)|image_gen\.py)/i, 'ppt.activityAssets'],
    [/(?:editppt(?:\.exe)?\s+page\s+assemble|build_pptx_from_manifest\.py)/i, 'ppt.activityBuilding'],
    [/(?:editppt(?:\.exe)?\s+(?:page\s+)?validate|validate_pptx\.py)/i, 'ppt.activityValidating'],
    [/(?:editppt(?:\.exe)?\s+finalize|finalize_deck_run\.py)/i, 'ppt.activityFinalizing'],
  ]
  return patterns
    .flatMap(([pattern, key]) => { const match = pattern.exec(text); return match ? [{ index: match.index, key }] : [] })
    .sort((a, b) => a.index - b.index)[0]?.key
}

/**
 * Polls one live PPT run for honest progress.
 *
 * Two sources only: the agent session's own event stream (what the model and
 * its tools are doing) and the upstream pipeline's state files under the run
 * directory (which pages are actually validated). It never reads assistant
 * text, reasoning streams or tool output — the card is a status display, not a
 * log of the conversation — and it never derives a percentage from time: a
 * stalled run keeps showing its last observable state.
 *
 * Every failure here is swallowed on purpose: progress observation must never
 * decide whether the conversion succeeded.
 */
export class PptProgressMonitor {
  private cursor = 0
  private readonly calls = new Map<string, string>()
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<void>
  private stopped = false
  private paths: string[] = []
  private searchedAt = 0
  private fileSignature = ''

  constructor(
    private readonly task: CanvasSkillTask,
    private readonly session: SkillAgentSession,
    private readonly runDir: string,
    private readonly t: CatalogTranslate,
  ) {}

  /** Start polling every 1.5s; the timer is unref'd so it never holds the host open. */
  start(): void {
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, 1500)
    this.timer.unref?.()
  }

  /**
   * Run one scan now. Concurrent calls share the in-flight scan so a slow
   * filesystem cannot pile up overlapping reads of the same run directory.
   */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.pending !== undefined) return this.pending
    const work = this.scan().catch(() => { /* Progress observation never controls conversion success. */ })
    this.pending = work
    void work.then(() => { if (this.pending === work) this.pending = undefined })
    return work
  }

  /** Stop polling and take one final scan so the settled state is what the card shows. */
  async stop(): Promise<void> {
    clearInterval(this.timer)
    await this.refresh()
    this.stopped = true
  }

  private async scan(): Promise<void> {
    this.scanEvents()
    await this.scanUpstreamFiles()
  }

  /** Replay new session events into the activity log; the cursor never goes backwards. */
  private scanEvents(): void {
    const length = this.session.seq
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || this.session.eventAt === undefined) return
    // A resumed session can already hold a long history; only the tail is
    // relevant to a run that just started, and replaying all of it would
    // flood the bounded event log with steps from before this task existed.
    this.cursor = Math.max(this.cursor, length - 512)
    for (; this.cursor < length; this.cursor++) {
      let event: { type?: string; time?: number; data?: Record<string, any> } | undefined
      try { event = this.session.eventAt(this.cursor) as typeof event } catch { continue }
      const data = event?.data
      if (data === undefined) continue
      // Deliberately never read assistant text, reasoning streams or tool output.
      if (event?.type === 'step/start') pptActivity(this.task, this.t('ppt.activityModel'))
      else if (event?.type === 'tool/call') {
        const name = typeof data.name === 'string' && /^[\w.:/-]{1,80}$/.test(data.name) ? data.name : this.t('ppt.activityUnknownTool')
        if (typeof data.callId === 'string') {
          // Tool results arrive by callId; the map is capped so a runaway tool
          // loop cannot grow it without bound.
          if (this.calls.size >= 128) {
            const oldest = this.calls.keys().next().value
            if (oldest !== undefined) this.calls.delete(oldest)
          }
          this.calls.set(data.callId, name)
        }
        const operation = toolOperation(data.arguments)
        pptActivity(this.task, this.t('ppt.activityTool', { name }) + (operation === undefined ? '' : ` · ${this.t(operation)}`))
      } else if (event?.type === 'tool/result') {
        const message = data.message
        const name = this.calls.get(message?.callId) ?? this.t('ppt.activityUnknownTool')
        if (typeof message?.callId === 'string') this.calls.delete(message.callId)
        pptActivity(this.task, this.t(message?.isError ? 'ppt.activityToolFailed' : 'ppt.activityToolDone', { name }), message?.isError ? 'warning' : 'done')
      } else if (event?.type === 'assistant/message') pptActivity(this.task, this.t('ppt.activityModelDone'), 'done')
    }
  }

  /**
   * Read the upstream pipeline's own records: `page_jobs.json` for per-page
   * state and `run_state.json` for the coarse upstream stage.
   *
   * The files live somewhere below the run directory whose exact depth the
   * upstream skill decides, so the directory tree is walked (bounded, symlinks
   * never followed, the big content folders skipped) and re-walked only every
   * 10s. A `page_jobs.json` whose page count does not match this task's inputs
   * belongs to another run and is ignored.
   */
  private async scanUpstreamFiles(): Promise<void> {
    if (Date.now() - this.searchedAt >= 10000 || this.paths.length === 0) {
      this.searchedAt = Date.now()
      const queue: Array<{ dir: string; depth: number }> = [{ dir: this.runDir, depth: 0 }]
      const found: string[] = []
      let visited = 0
      while (queue.length > 0 && visited < 1000) {
        const item = queue.shift()!
        for (const entry of await fs.readdir(item.dir, { withFileTypes: true }).catch(() => [])) {
          if (++visited > 1000) break
          if (entry.isFile() && entry.name === 'page_jobs.json') found.push(path.join(item.dir, entry.name))
          if (entry.isDirectory() && item.depth < 6 && !['input', 'pages', '.venv', 'node_modules', '.git'].includes(entry.name)) {
            queue.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 })
          }
        }
      }
      this.paths = found
    }
    let newest: { file: string; time: number; jobs: any } | undefined
    for (const file of this.paths) {
      const stat = await fs.lstat(file).catch(() => undefined)
      if (stat === undefined || stat.isSymbolicLink() || stat.size > 512000) continue
      const jobs = await fs.readFile(file, 'utf8').then(raw => JSON.parse(raw) as any).catch(() => undefined)
      if (!Array.isArray(jobs?.pages) || jobs.pages.length !== this.task.pptImages?.length) continue
      if (newest === undefined || stat.mtimeMs > newest.time) newest = { file, time: stat.mtimeMs, jobs }
    }
    if (newest === undefined) return
    const pages = (newest.jobs.pages as any[]).map((page, index) => ({
      page: index + 1,
      state: ['recorded', 'accepted'].includes(page.status) && page.result?.validation_passed === true
        ? 'validated' as const
        : page.status === 'dispatched' || page.status === 'recorded' ? 'running' as const : 'pending' as const,
    }))
    const signature = JSON.stringify(pages)
    // A poll that finds the same records must not look like new activity: the
    // event log and the "last activity" clock only move on a real change.
    if (signature !== this.fileSignature) {
      this.fileSignature = signature
      pptActivity(this.task, this.t('ppt.activityPages', { done: pages.filter(page => page.state === 'validated').length, total: pages.length }))
    }
    const progress: PptTaskProgress = this.task.progress ??= { lastActivityAt: Date.now(), events: [] }
    progress.pages = pages
    await this.scanRunState(path.dirname(newest.file), progress)
  }

  /** Translate the upstream run status into one stage line, once per change. */
  private async scanRunState(dir: string, progress: PptTaskProgress): Promise<void> {
    const stateFile = path.join(dir, 'run_state.json')
    const stat = await fs.lstat(stateFile).catch(() => undefined)
    if (stat === undefined || stat.isSymbolicLink() || stat.size > 512000) return
    const state = await fs.readFile(stateFile, 'utf8').then(raw => JSON.parse(raw) as any).catch(() => undefined)
    const stages: Record<string, string> = {
      inputs_prepared: 'ppt.activityPrepared',
      pages_dispatched: 'ppt.activityDispatched',
      pages_recorded: 'ppt.activityRecorded',
      deck_built: 'ppt.activityBuilt',
      deck_validated: 'ppt.activityValidated',
      complete: 'ppt.activityUpstreamDone',
    }
    const key = stages[state?.status]
    if (key === undefined || progress.upstreamStage === state.status) return
    progress.upstreamStage = state.status
    pptActivity(this.task, this.t(key), state.status === 'complete' ? 'done' : 'running')
  }
}
