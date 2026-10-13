/**
 * OAuth token blob persistence for subscription accounts.
 *
 * Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
 * lib/blob.js — trimmed to the two image vendors this plugin ships. The blob
 * is stored through the DSH Credentials service under a provider-scoped ref
 * (see refs.ts); it never reaches the browser side.
 */

function asString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/** Everything a vendor needs to call its API plus display identity. */
export interface SubscriptionBlob {
  accessToken: string
  refreshToken: string
  /** Epoch ms when the access token stops working; 0 when unknown. */
  expiresAt: number
  label: string
  email: string
  /** ChatGPT-only: the chatgpt-account-id request header value. */
  accountId: string
}

/** Serialize a blob for storage; at least one token must be present. */
export function serializeBlob(obj: Partial<SubscriptionBlob>): string {
  const accessToken = asString(obj.accessToken)
  const refreshToken = asString(obj.refreshToken)
  if (accessToken.length === 0 && refreshToken.length === 0) {
    throw new Error('oauth blob needs accessToken or refreshToken')
  }
  return JSON.stringify({
    accessToken,
    refreshToken,
    expiresAt: Number(obj.expiresAt) || 0,
    label: asString(obj.label),
    email: asString(obj.email),
    accountId: asString(obj.accountId),
  })
}

/** Parse a stored blob back; invalid input throws. */
export function parseBlob(text: string): SubscriptionBlob {
  const obj: unknown = typeof text === 'string' ? JSON.parse(text) : text
  if (typeof obj !== 'object' || obj === null) throw new Error('invalid oauth blob')
  const row = obj as Record<string, unknown>
  return {
    accessToken: asString(row.accessToken),
    refreshToken: asString(row.refreshToken),
    expiresAt: Number(row.expiresAt) || 0,
    label: asString(row.label),
    email: asString(row.email),
    accountId: asString(row.accountId),
  }
}