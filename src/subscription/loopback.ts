/**
 * Temporary loopback server that catches the OAuth redirect on a vendor-fixed
 * local port and hands the code to a handler.
 *
 * Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
 * lib/loopback.js — same protocol (first matching request wins, server shuts
 * down, 10-minute cap), restated in TypeScript with this bundle's style.
 */
import http from 'node:http'

const OK_HTML = '<!doctype html><meta charset="utf-8"><title>dsh-image-gen</title><p>登录成功，可以关闭此页返回设置。</p>'
const ERR_HTML = '<!doctype html><meta charset="utf-8"><title>dsh-image-gen</title><p>登录失败，请返回设置重试。</p>'

/**
 * Loopback addresses accepted by the request handler. On dual-stack systems
 * Node reports IPv4-mapped IPv6 addresses as `::ffff:127.0.0.1`, so we must
 * accept that form in addition to the canonical IPv4 and IPv6 loopback.
 */
const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
])

/**
 * Listen on the redirect_uri's port and resolve when the provider calls back.
 * Rejects on port conflicts, network errors, or when nothing arrives in time.
 */
export function startLoopback(options: {
  redirectUri: string
  timeoutMs?: number
  onCode: (params: URLSearchParams) => Promise<string>
  onReady?: () => void
  onError?: (error: Error) => void
}): Promise<{ ok: true }> {
  const parsed = new URL(options.redirectUri)
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return Promise.reject(new Error(`loopback redirect requires localhost, got ${parsed.hostname}`))
  }
  const port = Number(parsed.port) || 80
  const path = parsed.pathname
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  const state = { done: false }

  return new Promise<{ ok: true }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Security: reject connections not originating from the local machine.
      // The server listens on all interfaces (dual-stack) so both IPv4 and
      // IPv6 browsers reach the callback, but only loopback is accepted. (#53)
      const remote = req.socket.remoteAddress ?? ''
      if (!LOOPBACK_ADDRESSES.has(remote)) {
        res.writeHead(403)
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`)
      // The provider may redirect to a suffixed path (e.g. /auth/callback/extra)
      if (!url.pathname.startsWith(path)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ERR_HTML)
        return
      }
      if (state.done) return
      state.done = true
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      Promise.resolve(options.onCode(url.searchParams))
        .then(html => { res.end(html.length > 0 ? html : OK_HTML) })
        .catch(() => { res.end(ERR_HTML) })
        .finally(() => {
          clearTimeout(timer)
          server.close()
          resolve({ ok: true })
        })
    })
    server.on('error', error => {
      const failure = error instanceof Error ? error : new Error(String(error))
      options.onError?.(failure)
      if (state.done) return
      state.done = true
      clearTimeout(timer)
      reject(failure)
    })
    const timer = setTimeout(() => {
      if (state.done) return
      state.done = true
      server.close()
      reject(new Error('loopback timeout: no callback received'))
    }, timeoutMs)
    // Listen without specifying a host so the OS binds dual-stack (both
    // 127.0.0.1 and [::1]). This ensures the callback is reachable regardless
    // of how the browser resolves 'localhost' on this machine. The handler-
    // level loopback guard above rejects any non-local connection. (#53)
    server.listen(port, () => { options.onReady?.() })
  })
}