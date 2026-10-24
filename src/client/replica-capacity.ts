/**
 * How many reference images actually reach the model, per channel/model.
 *
 * WHY this file exists: the reference product this feature imitates advertises
 * "最多 20 张参考图", and the first draft of this workspace was going to say the
 * same thing. That would have been a lie with a specific size. The host keeps
 * the primary image in `image` and at most FOUR extras in `images` (engine.ts
 * `slice(0, 4)`), so five is the ceiling — and several model families take only
 * the primary image, so for them the ceiling is one.
 *
 * `editReferenceLimit()` already encodes exactly those per-adapter facts for the
 * edit form, so this module delegates to it instead of growing a second, drift-
 * prone copy of the same table. What it adds is the accounting the UI needs:
 *  - how many of the user's picked references will be USED,
 *  - how many will be DROPPED,
 *  - and whether the target model can even accept a reference at all.
 *
 * The workspace is allowed to accept more files than the model can use — a user
 * assembling a mood board wants them on screen — but it is never allowed to
 * accept them silently, which is what `dropped` is for.
 */
import { describeModel } from '../model-catalog.ts'
import { resolveChannelProtocol, type ChannelConfig } from '../protocol.ts'
import { editReferenceLimit } from './reference-images.ts'

/** How many files the picker accepts. Larger than any model's capacity on purpose. */
export const REPLICA_PICK_LIMIT = 20

export interface ReferenceCapacity {
  /** How many of the picked references the next request will actually carry. */
  usable: number
  /** How many will be left out, so the UI can say so. */
  dropped: number
  /** The adapter family driving the number, for an honest one-line explanation. */
  reason: 'subscription' | 'chat' | 'single' | 'generic'
  /** The model id as configured, for the tooltip. */
  model: string
}

/**
 * Resolve the real capacity for one target.
 *
 * @param model - the model alias the user picked.
 * @param channel - the channel it lives on, when one could be resolved.
 * @param picked - how many references the user has put in the form.
 */
export function referenceCapacity(
  model: string,
  channel: Pick<ChannelConfig, 'apiUrl' | 'apiUrlFull' | 'protocol' | 'auth' | 'models'> | undefined,
  picked: number,
): ReferenceCapacity {
  const limit = editReferenceLimit(model, channel)
  const usable = Math.min(limit, picked)
  let reason: ReferenceCapacity['reason'] = 'generic'
  if (channel?.auth === 'subscription') reason = 'subscription'
  else if (resolveChannelProtocol(channel?.apiUrl ?? '', channel?.protocol) === 'chat-completions') reason = 'chat'
  else {
    const upstream = channel?.models.find(item => item.alias === model)?.id || model
    const { family } = describeModel(upstream)
    // `limit === 1` here can only have come from the family branch, because the
    // two branches above already returned and were checked first.
    if (limit === 1 && (family === 'grok' || family === 'nanobanana' || family === 'dall-e' || family === 'qwen' || family === 'minimax')) reason = 'single'
  }
  return { usable, dropped: Math.max(0, picked - usable), reason, model }
}

/**
 * Split the picked references into the two fields the request carries.
 *
 * The split is NOT arbitrary: `image` is the primary and `images` holds the
 * extras, and the engine re-slices the extras at 4. Slicing here as well means
 * the number the UI promises ("本次实际使用前 N 张") is the number that leaves
 * the browser, so the promise stays true even if the host limit changes.
 */
export function splitReferences(dataUrls: string[], usable: number): { primary?: string; extras: string[] } {
  const kept = dataUrls.slice(0, Math.max(0, usable))
  const [primary, ...rest] = kept
  return primary === undefined ? { extras: [] } : { primary, extras: rest }
}
