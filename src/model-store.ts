import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { imageDataRoot } from './image-storage-path.ts'

export interface ModelEntry { id: string; name: string; mime: string; createdAt: number; file: string }
const modelsDir = () => path.join(imageDataRoot(), 'models')
const indexFile = () => path.join(modelsDir(), 'index.json')
const maxBytes = 20 * 1024 * 1024
const extension = (mime: string): string => mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
function valid(x: unknown): x is ModelEntry { if (!x || typeof x !== 'object') return false; const r = x as Record<string, unknown>; return typeof r.id === 'string' && typeof r.name === 'string' && typeof r.mime === 'string' && typeof r.createdAt === 'number' && typeof r.file === 'string' }
async function readIndex(): Promise<ModelEntry[]> { try { const parsed: unknown = JSON.parse(await fs.readFile(indexFile(), 'utf8')); const rows = Array.isArray(parsed) ? parsed : (parsed as { models?: unknown })?.models; return Array.isArray(rows) ? rows.filter(valid) : [] } catch { return [] } }
async function writeIndex(rows: ModelEntry[]): Promise<void> { await fs.mkdir(modelsDir(), { recursive: true }); const tmp = `${indexFile()}.tmp-${process.pid}-${randomUUID()}`; await fs.writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8'); await fs.rename(tmp, indexFile()) }
function decode(data: string): Buffer { const comma = data.indexOf(','); const raw = comma >= 0 ? data.slice(comma + 1) : data; const output = Buffer.from(raw, 'base64'); if (output.byteLength > maxBytes) throw new Error('model image exceeds 20 MiB'); return output }
export async function listModels(): Promise<ModelEntry[]> { return readIndex() }
export async function saveModel(input: { name: string; data: string; mime: string }): Promise<ModelEntry> { const id = randomUUID(); const entry: ModelEntry = { id, name: input.name.trim() || '模特', mime: input.mime || 'image/png', createdAt: Date.now(), file: `${id}.${extension(input.mime)}` }; const bytes = decode(input.data); await fs.mkdir(modelsDir(), { recursive: true }); await fs.writeFile(path.join(modelsDir(), entry.file), bytes); await writeIndex([entry, ...await readIndex()]); return entry }
export async function readModel(id: string): Promise<{ mime: string; data: Buffer } | undefined> { const rows = await readIndex(); const entry = rows.find(x => x.id === id || x.file === id); if (!entry) return undefined; try { return { mime: entry.mime, data: await fs.readFile(path.join(modelsDir(), entry.file)) } } catch { return undefined } }
export async function removeModel(id: string): Promise<boolean> { const rows = await readIndex(); const entry = rows.find(x => x.id === id); if (!entry) return false; await fs.rm(path.join(modelsDir(), entry.file), { force: true }); await writeIndex(rows.filter(x => x.id !== id)); return true }
