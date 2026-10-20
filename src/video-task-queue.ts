/**
 * In-memory, host-resident video generation queue.
 *
 * Deliberately a sibling of `task-queue.ts` rather than a generic rewrite of
 * it: the image queue is on the hot path for every existing feature, and video
 * differs in more than its payload types — a video task is long-running
 * (minutes, not seconds), so it needs its own concurrency (one render at a
 * time; a provider that renders serially gains nothing from parallel submits)
 * and its own summary shape, which strips reference frames but keeps the
 * finished clip's served URL.
 */

import { randomUUID } from 'node:crypto'
import type { VideoGenerateRequest, VideoGenerateResult, VideoMode, VideoTask, VideoTaskSummary } from './protocol.ts'

export type { VideoTask, VideoTaskSummary, VideoTaskStatus } from './protocol.ts'

export type VideoTaskListener = (task: VideoTask) => void

/**
 * Cap on retained *terminal* video tasks.
 *
 * Same reasoning as `task-queue.ts`, but the number is deliberately smaller:
 * a finished image task pins one base64 image, while a finished video task
 * pins its full `result` — the served clip URL plus the whole history entry
 * (which carries the reference frames' provenance and the clip metadata). A
 * video render also costs minutes of wall clock and hundreds of MiB upstream,
 * so a session accumulates far fewer of them than images; keeping 200 of these
 * would hold megabytes of result objects for work nobody will retry. Only
 * terminal entries are ever evicted: `queued`/`running` tasks ARE the live
 * queue and are never touched. The newest entries are kept because the panel's
 * task list, `get(id)` and `retry(id)` all look up recent work.
 */
const MAX_TERMINAL_TASKS = 100

export class VideoTaskQueue {
  private readonly tasks: VideoTask[] = []
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<VideoTaskListener>()
  private running = 0

  constructor(
    private readonly run: (request: VideoGenerateRequest, signal: AbortSignal) => Promise<VideoGenerateResult>,
    private readonly concurrency = 1,
  ) {}

  list(): VideoTask[] {
    return this.tasks.map(task => this.snapshot(task))
  }

  /** Bounded poll payload: active tasks plus the newest terminal summaries. */
  summaries(terminalLimit = 50): VideoTaskSummary[] {
    const limit = Math.max(0, Math.floor(terminalLimit))
    const active = this.tasks.filter(task => task.status === 'queued' || task.status === 'running')
    const terminal = this.tasks.filter(task => task.status !== 'queued' && task.status !== 'running').slice(0, limit)
    const selected = new Set([...active, ...terminal].map(task => task.id))
    return this.tasks.filter(task => selected.has(task.id)).map(task => this.summary(task))
  }

  get(id: string): VideoTask | undefined {
    const task = this.tasks.find(item => item.id === id)
    return task === undefined ? undefined : this.snapshot(task)
  }

  /** Observe queue state changes. Listener failures never disrupt generation. */
  subscribe(listener: VideoTaskListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  submit(request: VideoGenerateRequest): VideoTask {
    const task: VideoTask = { id: randomUUID(), request: { ...request }, status: 'queued', createdAt: Date.now() }
    this.tasks.unshift(task)
    this.publish(task)
    this.drain()
    return this.snapshot(task)
  }

  cancel(id: string): VideoTask | undefined {
    const task = this.tasks.find(item => item.id === id)
    if (task === undefined || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task
    task.status = 'cancelled'
    task.finishedAt = Date.now()
    this.controllers.get(id)?.abort()
    this.publish(task)
    this.trimTerminal()
    this.drain()
    return this.snapshot(task)
  }

  retry(id: string): VideoTask | undefined {
    const previous = this.tasks.find(item => item.id === id)
    return previous === undefined ? undefined : this.submit(previous.request)
  }

  /** Start queued tasks while capacity remains. */
  private drain(): void {
    while (this.running < Math.max(1, this.concurrency)) {
      const task = this.tasks.find(item => item.status === 'queued')
      if (task === undefined) return
      this.running += 1
      void this.runTask(task).finally(() => {
        this.running -= 1
        this.drain()
      })
    }
  }

  /**
   * Drop the oldest terminal tasks past the retention cap.
   *
   * Only terminal entries are eligible: a `queued`/`running` task is live
   * queue state, and `summaries()`/`get()`/`retry()` all expect to find it.
   * `tasks` is newest-first (every insert is an `unshift`), so the newest
   * terminal entries sit ahead of the older ones and are the ones kept.
   */
  private trimTerminal(): void {
    let seen = 0
    for (let index = 0; index < this.tasks.length;) {
      const task = this.tasks[index]
      if (task.status === 'queued' || task.status === 'running') {
        index += 1
        continue
      }
      seen += 1
      if (seen <= MAX_TERMINAL_TASKS) {
        index += 1
        continue
      }
      this.tasks.splice(index, 1)
    }
  }

  private async runTask(task: VideoTask): Promise<void> {
    task.status = 'running'
    task.startedAt = Date.now()
    this.publish(task)
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    try {
      const result = await this.run(task.request, controller.signal)
      if (this.tasks.find(item => item.id === task.id)?.status !== 'cancelled') {
        task.status = 'completed'
        task.result = result
        task.finishedAt = Date.now()
        this.publish(task)
        this.trimTerminal()
      }
    } catch (error) {
      if (this.tasks.find(item => item.id === task.id)?.status !== 'cancelled') {
        task.status = 'failed'
        task.error = error instanceof Error ? error.message : String(error)
        task.finishedAt = Date.now()
        this.publish(task)
        this.trimTerminal()
      }
    } finally {
      this.controllers.delete(task.id)
    }
  }

  private publish(task: VideoTask): void {
    const snapshot = this.snapshot(task)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Observers must not be able to interrupt the queue pump.
      }
    }
  }

  /**
   * Strip the reference frames before the summary crosses the wire: a base64
   * frame is large, and the panel already holds the frame the user picked.
   */
  private summary(task: VideoTask): VideoTaskSummary {
    const request = { ...task.request }
    delete request.image
    delete request.images
    delete request.firstFrame
    delete request.lastFrame
    // The plan rides the summary so the panel can show what the reasoning step
    // decided while the render is still running. It is small (a few strings)
    // and it is the whole point of the feature: an invisible plan cannot be
    // inspected or corrected.
    const plan = task.result?.plan
    // The drawing source is what makes a code-path retry cheap: sending it
    // back reproduces the same pixels without another chat call. It rides the
    // summary for the same reason the plan does — the canvas needs it while
    // polling, and re-reading the history for it would be a second round trip.
    const renderSource = task.result?.renderSource
    // Surface the finished clip so a polling client can play the result without
    // a second round trip; a video task always produces exactly one clip.
    const clip = task.result?.videos?.[0]
    const entryId = task.result?.history?.[0]?.id
    return {
      id: task.id,
      request,
      status: task.status,
      createdAt: task.createdAt,
      ...task.startedAt === undefined ? {} : { startedAt: task.startedAt },
      ...task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt },
      ...task.error === undefined ? {} : { error: task.error },
      resultAvailable: task.result !== undefined,
      ...clip === undefined || clip.url === '' ? {} : { resultUrl: clip.url },
      ...clip === undefined ? {} : { resultVideo: clip },
      ...entryId === undefined ? {} : { resultEntryId: entryId },
      ...plan === undefined ? {} : { plan },
      ...renderSource === undefined ? {} : { renderSource },
    }
  }

  private snapshot(task: VideoTask): VideoTask {
    return {
      ...task,
      request: { ...task.request },
      ...task.result === undefined ? {} : { result: task.result },
    }
  }
}

/** The video mode a task request uses (defensive read for polling callers). */
export function modeOfVideoRequest(request: VideoGenerateRequest): VideoMode {
  return request.mode
}
