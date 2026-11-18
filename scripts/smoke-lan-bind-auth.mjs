/**
 * Issue #50: a LAN bind (`192.168.x.y:port`) used to answer every
 * /api/dsh-imagegen request with 403 `forbidden: loopback-only`, because the
 * guard demanded a loopback `remoteAddress` — which a browser pointed at the
 * listener's own NIC address can never have.
 *
 * This starts the REAL route table on the LAN address and drives it over HTTP,
 * so the assertions are about what a browser actually gets. Four cases:
 *
 *   1. LAN address + Host naming that address        -> allowed (the fix)
 *   2. LAN address + Host naming a foreign domain    -> 403  (rebinding)
 *   3. LAN address + foreign Host + same-site Origin -> 403  (rebinding)
 *   4. loopback address + localhost Host             -> allowed (unchanged)
 *
 * Run: node scripts/smoke-lan-bind-auth.mjs
 */
import { createServer, request as httpRequest } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-imagegen-lan-auth-'))

const host = await import('../lib/index.js')

/**
 * The machine's own non-loopback IPv4, discovered rather than hard-coded: the
 * previous literal (`192.168.31.187`) made this suite red on every other
 * machine, which is the failure mode a test that only passes on its author's
 * laptop always has.
 */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && address.internal === false) return address.address
    }
  }
  return undefined
}

const LAN = lanAddress()
if (LAN === undefined) {
  // Deliberately a SKIP, not a pass: a machine with no NIC cannot exercise the
  // bind-address path, and reporting green here would claim coverage it lacks.
  console.log('SKIP  no non-loopback IPv4 interface on this machine; LAN bind cases not exercised')
  process.exit(0)
}
const seam = {
  async describe() { return { values: {} } },
  async mutate() { return { values: {} } },
}

const routes = host.makeRoutes({
  settings: seam,
  settingsNamespace: 'imagegen',
  bindHost: LAN,
  resolve: () => ({ apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test' }),
  history: {
    list: async () => [],
    append: async () => [],
    remove: async () => [],
    clear: async () => [],
    readImage: async () => undefined,
  },
})

function start(bindAddress) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const route = routes.find(r => (r.kind === 'exact'
      ? r.path === pathname
      : pathname === r.path || pathname.startsWith(`${r.path}/`)))
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    route.handler(req, res).catch(error => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  return new Promise(resolve => server.listen(0, bindAddress, () => resolve({ server, port: server.address().port })))
}

/** POST with an explicit Host header (undici refuses to override it, so go raw). */
function post(port, address, path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: address,
      port,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': 2, ...headers },
    }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end('{}')
  })
}

const PATH = '/api/dsh-imagegen/history/list'
const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition, detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${detail}`}`)
}

const lan = await start(LAN)
try {
  const authority = `${LAN}:${lan.port}`

  const own = await post(lan.port, LAN, PATH, { host: authority })
  check('LAN bind: browser on the bind address is allowed', own.status === 200, `got ${own.status} ${own.body}`)

  const rebind = await post(lan.port, LAN, PATH, { host: `evil.example.com:${lan.port}` })
  check('LAN bind: a foreign Host is still refused', rebind.status === 403, `got ${rebind.status} ${rebind.body}`)

  const rebindSameSite = await post(lan.port, LAN, PATH, {
    host: `evil.example.com:${lan.port}`,
    'sec-fetch-site': 'same-origin',
    origin: `http://evil.example.com:${lan.port}`,
  })
  check('LAN bind: foreign Host with a self-consistent Origin is still refused', rebindSameSite.status === 403,
    `got ${rebindSameSite.status} ${rebindSameSite.body}`)

  const crossSite = await post(lan.port, LAN, PATH, { host: authority, 'sec-fetch-site': 'cross-site' })
  check('LAN bind: cross-site marker is still refused', crossSite.status === 403, `got ${crossSite.status} ${crossSite.body}`)

  const foreignOrigin = await post(lan.port, LAN, PATH, { host: authority, origin: 'http://evil.example.com' })
  check('LAN bind: a mismatched Origin is still refused', foreignOrigin.status === 403, `got ${foreignOrigin.status} ${foreignOrigin.body}`)
} finally {
  lan.server.close()
}

// The loopback deployment must behave exactly as before.
const local = await start('127.0.0.1')
try {
  const viaLocalhost = await post(local.port, '127.0.0.1', PATH, { host: `localhost:${local.port}` })
  check('loopback bind: localhost Host is allowed', viaLocalhost.status === 200, `got ${viaLocalhost.status} ${viaLocalhost.body}`)

  const viaIp = await post(local.port, '127.0.0.1', PATH, { host: `127.0.0.1:${local.port}` })
  check('loopback bind: 127.0.0.1 Host is allowed', viaIp.status === 200, `got ${viaIp.status} ${viaIp.body}`)

  const foreign = await post(local.port, '127.0.0.1', PATH, { host: `evil.example.com:${local.port}` })
  check('loopback bind: a foreign Host is still refused', foreign.status === 403, `got ${foreign.status} ${foreign.body}`)
} finally {
  local.server.close()
}

// A bind address that is not this machine's must not authorise anything.
const mismatchRoutes = host.makeRoutes({
  settings: seam,
  settingsNamespace: 'imagegen',
  bindHost: '10.9.9.9',
  resolve: () => ({ apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test' }),
  history: {
    list: async () => [],
    append: async () => [],
    remove: async () => [],
    clear: async () => [],
    readImage: async () => undefined,
  },
})
const wrong = createServer((req, res) => {
  const r = mismatchRoutes.find(r => r.path === PATH)
  void r.handler(req, res)
})
await new Promise(resolve => wrong.listen(0, LAN, resolve))
try {
  const port = wrong.address().port
  const denied = await post(port, LAN, PATH, { host: `${LAN}:${port}` })
  check('a bind address other than the one reached grants nothing', denied.status === 403, `got ${denied.status} ${denied.body}`)
} finally {
  wrong.close()
}

// Reverse control: with no bindHost the guard must be exactly the old
// loopback-only one. Without this case the suite above would still pass if the
// guard had simply been widened to "always allow".
const legacyRoutes = host.makeRoutes({
  settings: seam,
  settingsNamespace: 'imagegen',
  resolve: () => ({ apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test' }),
  history: {
    list: async () => [],
    append: async () => [],
    remove: async () => [],
    clear: async () => [],
    readImage: async () => undefined,
  },
})
const legacy = createServer((req, res) => {
  const r = legacyRoutes.find(r => r.path === PATH)
  void r.handler(req, res)
})
await new Promise(resolve => legacy.listen(0, LAN, resolve))
try {
  const port = legacy.address().port
  const stillBlocked = await post(port, LAN, PATH, { host: `${LAN}:${port}` })
  check('no bindHost: a LAN client keeps the old 403 (the fix is opt-in on the address)', stillBlocked.status === 403,
    `got ${stillBlocked.status} ${stillBlocked.body}`)
} finally {
  legacy.close()
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
