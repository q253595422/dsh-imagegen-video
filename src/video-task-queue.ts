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
import { cancelRemoteVideo, onVideoSubmitted, type VideoSubmitEvent } from './video-engine.ts'
import { recordDiagnostic } from './diagnostics-store.ts'
import {
  readPendingVideoTasks,
  removePendingVideoTask,
  writePendingVideoTask,
  type PendingVideoTask,
} from './video-store.ts'
import type { VideoCancelState, VideoGenerateRequest, VideoGenerateResult, VideoMode, VideoTask, VideoTaskSummary } from './protocol.ts'

export type { VideoTask, VideoTaskSummary, VideoTaskStatus } from './protocol.ts'

export type VideoTaskListener = (task: VideoTask) => void

/**
 * The persistence and cancel behaviour the queue needs, injectable so a test can
 * run the whole restore path against memory instead of the user's data folder.
 *
 * Every member defaults to the real implementation below: the queue is a
 * host-resident singleton in production, and the smoke suite is the only caller
 * that has an opinion.
 */
export interface VideoTaskQueueHooks {
  /**
   * Stop one render on the provider's side. Defaults to the engine's capability
   * table, which currently answers `'unsupported'` for every family.
   */
  cancelRemote?: (task: VideoTask) => Promise<VideoCancelState>
  /** Read the in-flight index written by {@link VideoTaskQueueHooks.writePending}. */
  readPending?: () => Promise<{ tasks: PendingVideoTask[]; corrupt?: string }>
  /** Persist one in-flight render so a restart can reattach it. */
  writePending?: (entry: PendingVideoTask) => Promise<void>
  /** Drop one in-flight record once its render reached a terminal state. */
  removePending?: (localTaskId: string) => Promise<void>
  /** Where a restore failure is recorded (defaults to the shared diagnostics buffer). */
  recordFailure?: (input: { taskId: string; model: string; mode: string; message: string; code: string }) => void
}

/** Result of a restore attempt, so the caller can report it instead of guessing. */
export interface VideoRestoreOutcome {
  /** How many tasks were put back into the queue. */
  restored: number
  /** Why the index could not be read, when it could not (never swallowed). */
  error?: string
}

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
  /**
   * The submit context of each running task, keyed by local task id.
   *
   * Cancel needs the channel credentials and the family, and neither belongs on
   * the wire shape (`VideoTask` is what the browser sees). Kept here because this
   * is the only place that knows the local id at the moment the engine publishes
   * the remote one.
   */
  private readonly remoteOf = new Map<string, VideoSubmitEvent>()
  /** Which local task owns each run's AbortSignal (the engine's only identity). */
  private readonly signalTasks = new WeakMap<AbortSignal, string>()
  /** Runs the restore at most once, however many callers ask for it. */
  private restoreOnce: Promise<VideoRestoreOutcome> | undefined
  private readonly hooks: Required<VideoTaskQueueHooks>

  constructor(
    private readonly run: (request: VideoGenerateRequest, signal: AbortSignal) => Promise<VideoGenerateResult>,
    private readonly concurrency = 1,
    hooks: VideoTaskQueueHooks = {},
  ) {
    this.hooks = {
      cancelRemote: hooks.cancelRemote ?? (async task => {
        const context = this.remoteOf.get(task.id)
        if (context === undefined) return 'unsupported'
        return await cancelRemoteVideo(context.upstream, {
          taskId: context.remoteTaskId,
          family: context.family,
          model: context.model,
          mode: task.request.mode,
        })
      }),
      readPending: hooks.readPending ?? readPendingVideoTasks,
      writePending: hooks.writePending ?? writePendingVideoTask,
      removePending: hooks.removePending ?? removePendingVideoTask,
      recordFailure: hooks.recordFailure ?? (input => {
        recordDiagnostic({
          phase: 'video-poll',
          channel: '恢复',
          model: input.model,
          mode: input.mode,
          url: 'pending-tasks.json',
          method: 'GET',
          failureCode: input.code,
          message: input.message,
        })
      }),
    }
    // The engine announces the provider's task id; this is where it becomes
    // durable. The record is written BEFORE the poll loop starts inside the
    // engine, so a crash mid-render still leaves something to reattach.
    onVideoSubmitted(event => {
      if (event.signal === undefined) return
      const localId = this.signalTasks.get(event.signal)
      if (localId === undefined) return
      const task = this.tasks.find(item => item.id === localId)
      if (task === undefined) return
      task.remoteTaskId = event.remoteTaskId
      this.remoteOf.set(localId, event)
      this.publish(task)
      void this.persistPending(task, event).catch(() => { /* the render still proceeds */ })
    })
  }

  /** Persist one in-flight render; failures are reported, never fatal. */
  private async persistPending(task: VideoTask, event: VideoSubmitEvent): Promise<void> {
    const request = event.request
    const entry: PendingVideoTask = {
      localTaskId: task.id,
      remoteTaskId: event.remoteTaskId,
      submittedAt: event.submittedAt,
      ...request.channelId === undefined ? {} : { channelId: request.channelId },
      channelName: event.upstream.channelName?.trim() || '默认渠道',
      family: event.family,
      modelAlias: request.model,
      upstream: event.request.upstream ?? request.model,
      request: {
        mode: request.mode,
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        seconds: request.seconds,
        prompt: request.prompt,
        // Frames are NOT written: they are base64 data URLs and would turn this
        // index into megabytes. Only their presence survives, for error copy.
        hasImage: request.image !== undefined,
        hasImages: request.images?.length ?? 0,
        hasFirstFrame: request.firstFrame !== undefined,
        hasLastFrame: request.lastFrame !== undefined,
        ...request.refName === undefined ? {} : { refName: request.refName },
      },
    }
    await this.hooks.writePending(entry)
  }

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

  /**
   * Cancel one task locally and try to stop it upstream (#10-2).
   *
   * Deliberately synchronous: both callers (`routes.ts` and the Agent tool) read
   * the returned task directly, and a cancel that waited for a network round trip
   * would hold the panel's button. So the local state flips here, and the remote
   * attempt continues afterwards: `remoteCancel` starts as `'pending'` and settles
   * to `'stopped'` / `'unconfirmed'` / `'unsupported'`, and the panel shows which
   * one — because "已取消" without that distinction is what made users believe the
   * billing had stopped when it had not.
   */
  cancel(id: string): VideoTask | undefined {
    const task = this.tasks.find(item => item.id === id)
    if (task === undefined || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task
    task.status = 'cancelled'
    task.finishedAt = Date.now()
    task.remoteCancel = 'pending'
    this.controllers.get(id)?.abort()
    this.publish(task)
    this.trimTerminal()
    // The record stays until the remote attempt answered: if this process dies
    // while the provider is still rendering, the next start must find it (and
    // must NOT resume it — a cancelled task is never re-queued).
    void this.settleRemoteCancel(task)
    this.drain()
    return this.snapshot(task)
  }

  /** Ask the provider to stop, then record the honest answer on the task. */
  private async settleRemoteCancel(task: VideoTask): Promise<void> {
    let outcome: VideoCancelState
    try {
      outcome = task.remoteTaskId === undefined ? 'unsupported' : await this.hooks.cancelRemote(this.snapshot(task))
    } catch (error) {
      // A failed cancel must not resurrect the task, but it must not claim success
      // either: "the request never landed" is exactly `unconfirmed`.
      this.hooks.recordFailure({
        taskId: task.id,
        model: task.request.model,
        mode: task.request.mode,
        message: error instanceof Error ? error.message : String(error),
        code: 'video-cancel-failed',
      })
      outcome = 'unconfirmed'
    }
    const live = this.tasks.find(item => item.id === task.id)
    if (live !== undefined) {
      live.remoteCancel = outcome
      this.publish(live)
    }
    this.remoteOf.delete(task.id)
    await this.hooks.removePending(task.id).catch(() => { /* the index is advisory here */ })
    this.trimTerminal()
  }

  /**
   * Put still-running renders back after a restart (#10-1).
   *
   * Idempotent and safe to call from any request path: the read happens once, and
   * a restored task is queued with `resume` set so the engine polls the existing
   * remote task instead of submitting — and paying — again.
   *
   * Failure is reported, not hidden: an unreadable index yields `error` (the store
   * also quarantines the file so the user can inspect it), and a row whose channel
   * is gone fails its own task through the normal run path, which records a
   * diagnostic entry.
   */
  restorePending(): Promise<VideoRestoreOutcome> {
    this.restoreOnce ??= this.restorePendingOnce()
    return this.restoreOnce
  }

  private async restorePendingOnce(): Promise<VideoRestoreOutcome> {
    let read: { tasks: PendingVideoTask[]; corrupt?: string }
    try {
      read = await this.hooks.readPending()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.hooks.recordFailure({ taskId: '', model: '', mode: '', message, code: 'video-resume-failed' })
      return { restored: 0, error: message }
    }
    if (read.corrupt !== undefined) {
      this.hooks.recordFailure({ taskId: '', model: '', mode: '', message: read.corrupt, code: 'video-resume-failed' })
    }
    let restored = 0
    for (const entry of read.tasks) {
      // A record for a task this process already knows about (the write raced the
      // restore) must not be queued twice.
      if (this.tasks.some(task => task.id === entry.localTaskId)) continue
      const task: VideoTask = {
        id: entry.localTaskId,
        request: {
          mode: entry.request.mode,
          model: entry.modelAlias,
          prompt: entry.request.prompt,
          aspectRatio: entry.request.aspectRatio,
          resolution: entry.request.resolution as VideoGenerateRequest['resolution'],
          seconds: entry.request.seconds,
          upstream: entry.upstream,
          ...entry.channelId === undefined ? {} : { channelId: entry.channelId },
          ...entry.request.refName === undefined ? {} : { refName: entry.request.refName },
          resume: { taskId: entry.remoteTaskId, family: entry.family, submittedAt: entry.submittedAt },
        },
        status: 'queued',
        createdAt: entry.submittedAt,
        remoteTaskId: entry.remoteTaskId,
        resumedAt: Date.now(),
      }
      this.tasks.unshift(task)
      // 不写 `remoteOf`：恢复出来的任务没有本进程的 submit 上下文（渠道凭据
      // 属于上一次进程，重启后可能已经改了或删了）。取消时 `cancelRemote`
      // 会因为「没有上下文」直接答 `'unsupported'`，而不是拿着一个空 URL 去
      // 请求；真实的渠道由 `runVideo` 在恢复轮询时按 `channelId` 重新解析。
      this.publish(task)
      restored += 1
    }
    // 恢复本身就是一次真实的状态变化：上面已经逐条 publish 过了，这里只需要
    // 把队列抽起来。不再额外广播一条伪造的 task——观察方拿到的每一条都应该
    // 对应一个真实任务。
    if (restored > 0) this.drain()
    return read.corrupt === undefined ? { restored } : { restored, error: read.corrupt }
  }

  /**
   * Retry always submits afresh.
   *
   * A restored task carries `resume`; replaying it verbatim would reattach a
   * remote task that already ended (failed or timed out), so the abandon marker is
   * stripped here rather than in the panel.
   */
  retry(id: string): VideoTask | undefined {
    const previous = this.tasks.find(item => item.id === id)
    if (previous === undefined) return undefined
    const request = { ...previous.request }
    delete request.resume
    return this.submit(request)
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
    // 引擎只会把 AbortSignal 递回来（它不认得本地 task id），所以这里必须先把
    // 「信号 → 本地任务」记下来，否则 onVideoSubmitted 永远匹配不到任务，
    // pending 记录一次都不会落盘，重启恢复也就无从谈起。
    this.signalTasks.set(controller.signal, task.id)
    try {
      const result = await this.run(task.request, controller.signal)
      if (this.tasks.find(item => item.id === task.id)?.status !== 'cancelled') {
        task.status = 'completed'
        task.result = result
        task.finishedAt = Date.now()
        this.publish(task)
        this.forgetPending(task.id)
        this.trimTerminal()
      }
    } catch (error) {
      if (this.tasks.find(item => item.id === task.id)?.status !== 'cancelled') {
        task.status = 'failed'
        task.error = error instanceof Error ? error.message : String(error)
        task.finishedAt = Date.now()
        this.publish(task)
        this.forgetPending(task.id)
        this.trimTerminal()
      }
    } finally {
      this.controllers.delete(task.id)
    }
  }

  /**
   * Drop the in-flight record once a render reaches a terminal state.
   *
   * Without this the index only ever grows: every finished task would leave a
   * row behind, and the next restart would reattach renders that are long done
   * — polling providers for clips that no longer exist. Failure to write is
   * reported through `recordFailure` rather than swallowed, because a stale row
   * is exactly the thing that causes a duplicate reattach.
   */
  private forgetPending(localTaskId: string): void {
    void this.hooks.removePending(localTaskId).catch((error: unknown) => {
      this.hooks.recordFailure({
        taskId: localTaskId,
        model: '',
        mode: '',
        message: error instanceof Error ? error.message : String(error),
        code: 'video-resume-cleanup-failed',
      })
    })
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
