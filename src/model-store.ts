import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { imageDataRoot } from './image-storage-path.ts'

export interface ModelEntry { id: string; name: string; mime: string; createdAt: number; file: string }
const modelsDir = () => path.join(imageDataRoot(), 'models')
const indexFile = () => path.join(modelsDir(), 'index.json')
const maxBytes = 20 * 1024 * 1024
const extension = (mime: string): string => mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'png'
const supportedMime = (mime: string): mime is 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' => mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp' || mime === 'image/gif'
/** Reject anything that is not a single plain file name inside the model dir. */
function safeFileName(value: string): string | undefined {
  if (value.length === 0 || value.length > 200 || value.includes('/') || value.includes('\\') || value.includes('\0')) return undefined
  if (value === '.' || value === '..' || value.startsWith('..') || path.basename(value) !== value) return undefined
  return /^[0-9a-f-]{36}\.(png|jpg|jpeg|webp|gif)$/.test(value) ? value : undefined
}
function valid(x: unknown): x is ModelEntry { if (!x || typeof x !== 'object') return false; const r = x as Record<string, unknown>; return typeof r.id === 'string' && typeof r.name === 'string' && typeof r.mime === 'string' && supportedMime(r.mime) && typeof r.createdAt === 'number' && typeof r.file === 'string' && safeFileName(r.file) !== undefined }
async function readIndex(): Promise<ModelEntry[]> { try { const parsed: unknown = JSON.parse(await fs.readFile(indexFile(), 'utf8')); const rows = Array.isArray(parsed) ? parsed : (parsed as { models?: unknown })?.models; return Array.isArray(rows) ? rows.filter(valid) : [] } catch { return [] } }
async function writeIndex(rows: ModelEntry[]): Promise<void> { await fs.mkdir(modelsDir(), { recursive: true }); const tmp = `${indexFile()}.tmp-${process.pid}-${randomUUID()}`; await fs.writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8'); await fs.rename(tmp, indexFile()) }
function decode(data: string): Buffer { const comma = data.indexOf(','); const raw = comma >= 0 ? data.slice(comma + 1) : data; const output = Buffer.from(raw, 'base64'); if (output.byteLength > maxBytes) throw new Error('model image exceeds 20 MiB'); return output }
export async function listModels(): Promise<ModelEntry[]> { return readIndex() }
export async function saveModel(input: { name: string; data: string; mime: string }): Promise<ModelEntry> { const mime = input.mime || 'image/png'; if (!supportedMime(mime)) throw new Error(`unsupported model mime: ${mime}`); const id = randomUUID(); const entry: ModelEntry = { id, name: input.name.trim() || '模特', mime, createdAt: Date.now(), file: `${id}.${extension(mime)}` }; const file = safeFileName(entry.file); if (file === undefined) throw new Error('invalid model file name'); const bytes = decode(input.data); await fs.mkdir(modelsDir(), { recursive: true }); await fs.writeFile(path.join(modelsDir(), file), bytes); await writeIndex([entry, ...await readIndex()]); return entry }
export async function readModel(id: string): Promise<{ mime: string; data: Buffer } | undefined> { const rows = await readIndex(); const entry = rows.find(x => x.id === id || x.file === id); if (!entry) return undefined; const file = safeFileName(entry.file); if (file === undefined) return undefined; try { return { mime: entry.mime, data: await fs.readFile(path.join(modelsDir(), file)) } } catch { return undefined } }
export async function removeModel(id: string): Promise<boolean> { const rows = await readIndex(); const entry = rows.find(x => x.id === id); if (!entry) return false; const file = safeFileName(entry.file); if (file === undefined) return false; await fs.rm(path.join(modelsDir(), file), { force: true }); await writeIndex(rows.filter(x => x.id !== id)); return true }
