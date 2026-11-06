import { readFileSync, writeFileSync } from 'node:fs'

const P = 'scripts/smoke.mjs'
const L = readFileSync(P, 'utf8').split('\n')

const startIdx = L.findIndex(l => l.includes('// The clothing upload stops at four garments'))
const endIdx = L.findIndex(l => l.includes('outfit keeps the nine top-nav entries'))
if (startIdx < 0 || endIdx < 0) throw new Error('outfit block anchors missing')
const block = L.slice(startIdx, endIdx + 1).join('\n')

const dedented = block.split('\n').map(l => (l.startsWith('  ') ? l.slice(2) : l)).join('\n')

L.splice(startIdx, endIdx - startIdx + 1)

const newCheck = `
// ---------------------------------------------------------------- E1o outfit
/**
 * The outfit form, probed on the studio E1 already mounted.
 *
 * These assertions used to sit at the bottom of E1, below a thousand lines that
 * fail on macOS for reasons that predate this feature, so they could never run
 * there. The assertions themselves are unchanged; only their home moved.
 * \`e1Realm.mounted\` is the handle E1 publishes the moment the studio view
 * exists, so an earlier failure in E1 does not quietly turn this check into a
 * pass -- without the handle this fails and says which precondition was missing.
 */
await check('E1o outfit workspace: modes, reference entries and preview-before-submit (jsdom)', async () => {
  try {
    assert.ok(e1Realm !== undefined, 'E1 must have built the jsdom realm before the outfit workspace can be probed')
    assert.ok(e1Realm.mounted !== undefined, 'E1 must reach the studio mount before the outfit assertions can run; without it there is nothing to probe and passing here would be a false green')
    const { view, jsdomWindow } = e1Realm.mounted

${dedented}
  } finally {
    // Restoring the globals belongs here now, not in E1: E1 leaves them installed
    // so this check can still render. A throw above must not leak the jsdom realm
    // into every check that follows, so the restore runs either way.
    await new Promise(resolve => setTimeout(resolve, 25))
    if (e1Realm !== undefined) {
      if (e1Realm.previousWindow === undefined) delete globalThis.window
      else globalThis.window = e1Realm.previousWindow
      if (e1Realm.previousDocument === undefined) delete globalThis.document
      else globalThis.document = e1Realm.previousDocument
    }
  }
})
`.split('\n')

const sumIdx = L.findIndex(l => l.includes('// ------------------------------------------------------------------ summary'))
if (sumIdx < 0) throw new Error('summary anchor missing')
L.splice(sumIdx, 0, ...newCheck)

let out = L.join('\n')

const decl = '// --------------- E. full client apply in jsdom (mounts the sidebar entry)'
if (out.split(decl).length !== 2) throw new Error('E section anchor missing')
out = out.replace(decl, `/**
 * The jsdom realm E1 builds and E1o finishes with. Declared here so E1o can see
 * it; assigned inside E1, and E1o fails loudly rather than skipping when it is
 * missing.
 */
let e1Realm

${decl}`)

writeFileSync(P, out)
console.log('moved outfit block into E1o')
