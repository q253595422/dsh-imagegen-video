/** Immutable PPT task checkpoints avoid Windows replace/rename sharing violations. */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CanvasSkillTask } from './protocol.ts'

type TaskIO = Pick<typeof fs, 'mkdir' | 'writeFile' | 'readFile' | 'readdir' | 'rm'>
const CHECKPOINT = /^(skillrun-[\w-]+)\.(\d+)\.([\da-f-]+)\.json$/
const LEGACY = /^(skillrun-[\w-]+)\.json$/

export class PptTaskStore {
  private clock = 0
  private tails = new Map<string, Promise<void>>()
  constructor(private readonly dataRoot: () => string, private readonly io: TaskIO = fs) {}

  write(task: CanvasSkillTask): Promise<void> {
    if (!/^skillrun-[\w-]+$/.test(task.id) || task.canvasId !== 'ppt') return Promise.reject(new Error('Invalid PPT task identity'))
    const dir = path.join(this.dataRoot(), 'ppt-tasks')
    const key = path.join(dir, task.id)
    // Snapshot at enqueue time: later mutation must never turn an old write into a stale overwrite.
    const text = JSON.stringify(task)
    const revision = this.clock = Math.max(Date.now(), this.clock + 1)
    const file = path.join(dir, `${task.id}.${revision}.${randomUUID()}.json`)
    const operation = (this.tails.get(key) ?? Promise.resolve()).then(async () => {
      await this.io.mkdir(dir, { recursive: true })
      try {
        // A fresh file is closed/flushed before this promise resolves. Readers skip partial JSON.
        await this.io.writeFile(file, text, { encoding: 'utf8', flag: 'wx', flush: true })
      } catch (error) {
        await this.io.rm(file, { force: true }).catch(() => {})
        throw error
      }
      // A run records only queue, Agent identity and terminal snapshots. Keep
      // earlier checkpoints for recovery rather than replacing or unlinking locked files.

    })
    const tail = operation.then(() => {}, () => {})
    this.tails.set(key, tail)
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    return operation
  }

  async list(): Promise<CanvasSkillTask[]> {
    const dir = path.join(this.dataRoot(), 'ppt-tasks')
    let names: string[]
    try { names = await this.io.readdir(dir) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const latest = new Map<string, { revision: number; task: CanvasSkillTask }>()
    for (const name of names) {
      const checkpoint = CHECKPOINT.exec(name), legacy = LEGACY.exec(name)
      const id = checkpoint?.[1] ?? legacy?.[1]
      if (!id) continue
      const revision = checkpoint ? Number(checkpoint[2]) : 0
      if (!Number.isSafeInteger(revision) || (latest.get(id)?.revision ?? -1) >= revision) continue
      const task = await this.io.readFile(path.join(dir, name), 'utf8').then(raw => JSON.parse(raw) as CanvasSkillTask).catch(() => undefined)
      if (!task || task.id !== id || task.canvasId !== 'ppt' || !Number.isFinite(task.startedAt)
        || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(task.status)) continue
      latest.set(id, { revision, task })
    }
    return [...latest.values()].map(item => item.task)
  }
}
