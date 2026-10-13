/**
 * OpenRouter account image vendor.
 *
 * OpenRouter's official OAuth exchange returns a permanent, user-controlled
 * API key. The key is stored in DSH Credentials like every other subscription
 * blob; generation uses OpenRouter's image-capable chat completions route.
 */
import type { Pkce } from '../oauth.js'
import type { SubscriptionBlob } from '../blob.js'

const OPENROUTER_AUTH = 'https://openrouter.ai/auth'
const OPENROUTER_TOKEN = 'https://openrouter.ai/api/v1/auth/keys'
export const OPENROUTER_REDIRECT_URI = 'http://127.0.0.1:56231/oauth/callback'
export const OPENROUTER_IMAGE_URL = 'https://openrouter.ai/api/v1/chat/completions'
export const OPENROUTER_IMAGE_MODEL = 'google/gemini-3-pro-image'

export function openRouterAuthorizeUrl(pkce: Pkce): string {
  const url = new URL(OPENROUTER_AUTH)
  url.searchParams.set('callback_url', OPENROUTER_REDIRECT_URI)
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', pkce.state)
  return url.toString()
}

export function openRouterIdentityHeaders(blob: SubscriptionBlob): Record<string, string> {
  return {
    authorization: `Bearer ${blob.accessToken}`,
    'content-type': 'application/json',
    accept: 'application/json',
  }
}

export async function openRouterExchangeCode(pkce: Pkce, code: string): Promise<SubscriptionBlob> {
  const response = await fetch(OPENROUTER_TOKEN, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: pkce.verifier, code_challenge_method: 'S256' }),
    signal: AbortSignal.timeout(30_000),
  })
  const json = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(`OpenRouter OAuth key exchange failed (HTTP ${response.status})`)
  const key = json.key
  if (typeof key !== 'string' || key.length === 0) throw new Error('OpenRouter OAuth response carries no key')
  return {
    accessToken: key,
    refreshToken: '',
    expiresAt: Number.MAX_SAFE_INTEGER,
    label: 'OpenRouter',
    email: '',
    accountId: '',
  }
}

export async function openRouterRefresh(blob: SubscriptionBlob): Promise<SubscriptionBlob> {
  return blob
}