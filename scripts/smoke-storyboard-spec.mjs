/**
 * Storyboard editorial rules, as pure functions: how long a shot's dialogue
 * actually needs, and which lengths the picker may offer.
 *
 * WHY this is a suite of its own rather than more cases in
 * `smoke-storyboard.mjs`: that file is about the board's STATE (which shot is
 * done, what a stitch covers, what a re-run invalidates). These two rules are
 * about what a director may WRITE, they belong to a different reader, and the
 * failure modes are different: a state bug shows a wrong badge, a duration bug
 * produces a clip where the actor is still mid-sentence when the file ends.
 *
 * Every check drives the real module. Nothing here needs a DOM, a canvas or a
 * network, so a red line is always about the rule, not the harness.
 *
 * Run: node scripts/smoke-storyboard-spec.mjs   (from the package root, no build)
 */

import assert from 'node:assert/strict'
import {
  MAX_SHOT_REFERENCES,
  SHOT_SECONDS,
  SPEECH_CJK_PER_SECOND,
  SPEECH_MARGIN_SECONDS,
  SPEECH_WORDS_PER_SECOND,
  shotSecondsOptions,
  shotSpeechFit,
  shotVideoPlan,
  shotsWithoutCast,
  speechSeconds,
  spokenText,
} from '../src/client/storyboard.ts'

const results = []
function check (name, fn) {
  try {
    fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const shot = (prompt, seconds) => ({ id: 'shot-1', prompt, seconds })

// ------------------------------------------------------------ spoken text

check('S1 only quoted text counts as dialogue', () => {
  // Camera direction and stage business carry no speaking time. A rule that
  // measured the whole prompt would reject every visually rich shot.
  assert.equal(spokenText('缓慢推近，她抬头：「你来晚了。」'), '你来晚了。')
  assert.equal(spokenText('固定机位。'), '')
  assert.equal(spokenText(''), '')
})

check('S2 every quotation style the editor accepts is recognised', () => {
  assert.equal(spokenText('「甲」'), '甲', 'CJK corner brackets')
  assert.equal(spokenText('『乙』'), '乙', 'CJK double corner brackets')
  assert.equal(spokenText('“丙”'), '丙', 'full-width curly quotes')
  assert.equal(spokenText('"ding"'), 'ding', 'ASCII quotes')
})

check('S3 several lines in one shot are summed, not just the first', () => {
  // Two characters arguing inside one shot is normal; measuring only the first
  // line would under-report a shot by half.
  assert.equal(spokenText('「甲说」…「乙说」'), '甲说乙说')
})

// ------------------------------------------------------------ speech rate

check('S4 Mandarin is measured at the documented rate', () => {
  // 9 字 / 4.5 字·秒⁻¹ = 2 s. This number is the whole rule; a typo here moves
  // every advisory in the product.
  assert.equal(speechSeconds('一二三四五六七八九'), 2)
  assert.equal(SPEECH_CJK_PER_SECOND, 4.5)
})

check('S5 English is measured in words, not characters', () => {
  assert.equal(speechSeconds('one two three four five'), 2)
  assert.equal(SPEECH_WORDS_PER_SECOND, 2.5)
})

check('S6 punctuation and spaces take no speaking time', () => {
  assert.equal(speechSeconds('你，好。'), speechSeconds('你好'))
  assert.equal(speechSeconds('  '), 0)
  assert.equal(speechSeconds(''), 0)
})

check('S7 mixed dialogue adds both halves', () => {
  // 4.5 字 = 1 s and 2.5 words = 1 s, so 4 字 + 1 word ≈ 0.89 s + 0.4 s.
  assert.ok(Math.abs(speechSeconds('一二三四 five') - (4 / 4.5 + 1 / 2.5)) < 1e-12)
})

// ------------------------------------------------------------ fit

check('S8 the margin is two seconds on top of the measured speech', () => {
  const fit = shotSpeechFit(shot('「一二三四五六七八九」', 5))
  assert.equal(fit.speech, 2, 'the line itself takes two seconds')
  assert.equal(fit.required, 2 + SPEECH_MARGIN_SECONDS, 'and the performance needs room too')
  assert.equal(fit.fits, true, '5 s covers 2 s of speech + 2 s margin')
})

check('S9 a shot that only just covers the words does not fit', () => {
  // 4 s of speech needs 6 s: the actor has to breathe and react. This is the
  // exact "the clip cuts mid-sentence" case the rule exists for.
  const line = '一'.repeat(18)
  const fit = shotSpeechFit(shot(`「${line}」`, 4))
  assert.equal(fit.required, 6, '4 s of speech needs 6 s: the line plus the performance margin')
  assert.equal(fit.fits, false, 'a 4 s shot cannot deliver a 6 s requirement')
})

check('S10 a shot with no dialogue always fits — it is not a gate', () => {
  const fit = shotSpeechFit(shot('她把杯子放下，走向门口。', 4))
  assert.equal(fit.line, '', 'no quotes means no measurable speech')
  assert.equal(fit.required, 0)
  assert.equal(fit.fits, true, 'a visual-only shot is never flagged')
})

check('S11 an invalid duration reports a fit, it does not throw', () => {
  // shotProblem already refuses a bad duration for running. This advisory must
  // not be a second, differently-worded explanation of the same thing.
  const fit = shotSpeechFit(shot('「一二三」', Number.NaN))
  assert.equal(fit.fits, false)
})

// ------------------------------------------------------------ picker

check('S12 the editorial set reaches past ten seconds', () => {
  // 8-15 s paragraphs with two cuts inside them cannot be expressed by a list
  // that stops at ten; that was the reported limitation.
  assert.ok(SHOT_SECONDS.includes(12), '12 s is offered')
  assert.ok(SHOT_SECONDS.includes(15), '15 s is offered')
  assert.deepEqual([...SHOT_SECONDS], [...SHOT_SECONDS].sort((a, b) => a - b), 'offered in order')
})

check('S13 the picker narrows to what the model accepts', () => {
  // snapgen speaks 6 / 10 / 15. Offering 4 or 5 would guarantee a 400.
  assert.deepEqual(shotSecondsOptions([6, 10, 15]), [6, 10, 15], 'only the values this model accepts')
  assert.deepEqual(shotSecondsOptions([5]), [5], 'a single-duration model offers exactly one')
})

check('S14 an undeclared model keeps the whole editorial set', () => {
  // No model named means the channel default decides, and the board cannot
  // resolve it. Offering our full list is honest; offering the intersection
  // with nothing would leave the picker empty.
  assert.deepEqual(shotSecondsOptions(), [...SHOT_SECONDS])
  assert.deepEqual(shotSecondsOptions([]), [...SHOT_SECONDS])
  assert.deepEqual(shotSecondsOptions([0, -1, Number.NaN]), [...SHOT_SECONDS], 'junk values are not durations')
})

check('S15 a model with no overlap still gets its own values', () => {
  // A hypothetical 7-second-only model: one valid choice beats seven invalid
  // ones. This is a fallback, not the common path.
  assert.deepEqual(shotSecondsOptions([7]), [7])
  assert.deepEqual(shotSecondsOptions([9, 7]), [7, 9], 'sorted, deduplicated')
})

// ------------------------------------------------------------ shot plan

check('S16 the reference ceiling matches the composers', () => {
  assert.equal(MAX_SHOT_REFERENCES, 4)
  assert.equal(shotVideoPlan({ continuity: 'cut', index: 0, castCount: 9 }).castSlots, 4, 'never more than four')
})

check('S17 continuity owns the frame slots; identity does not ride along', () => {
  // A carried shot is a first/last-keyframe run, and the provider contracts
  // forbid mixing first_frame with reference_image. The exact join wins, and
  // castSlots is 0 so the prompt never claims a reference it did not send.
  assert.deepEqual(shotVideoPlan({ continuity: 'carry', index: 2, castCount: 3 }), { mode: 'keyframe', castSlots: 0 })
  // The FIRST shot of a carry board has no predecessor to join, so it can use
  // identities exactly like a cut board.
  assert.deepEqual(shotVideoPlan({ continuity: 'carry', index: 0, castCount: 1 }), { mode: 'reference', castSlots: 1 })
  assert.deepEqual(shotVideoPlan({ continuity: 'cut', index: 0, castCount: 0 }), { mode: 'text', castSlots: 0 })
  assert.deepEqual(shotVideoPlan({ continuity: 'cut', index: 3, castCount: 2 }), { mode: 'reference', castSlots: 2 })
})

check('S18 the board can name exactly which shots lose the cast', () => {
  // This is what the warning on the board renders. It has to agree with
  // `shotVideoPlan` shot for shot, or the badge would claim a loss that does not
  // happen (or stay silent about one that does).
  const carry = { shots: [{ id: 'a', prompt: '', seconds: 5 }, { id: 'b', prompt: '', seconds: 5 }, { id: 'c', prompt: '', seconds: 5 }], aspectRatio: '16:9', resolution: '720P', continuity: 'carry' }
  assert.deepEqual(shotsWithoutCast(carry, 2), [1, 2], 'every carried shot drops the pinned cast')

  const cut = { ...carry, continuity: 'cut' }
  assert.deepEqual(shotsWithoutCast(cut, 2), [], 'independent shots keep the cast, so there is nothing to warn about')

  // Nobody pinned: nothing is being lost, so the board must stay quiet rather
  // than warn about "0 identities".
  assert.deepEqual(shotsWithoutCast(carry, 0), [], 'a board with nothing pinned never warns')

  // The warning must not fire on a board that has not been laid out yet: one
  // blank shot in carry mode has no predecessor, so it keeps the cast.
  const fresh = { ...carry, shots: [{ id: 'a', prompt: '', seconds: 5 }] }
  assert.deepEqual(shotsWithoutCast(fresh, 1), [], 'the first shot of a carry board can still use identities')
})

for (const line of results) console.log(line)
// Both numbers, because a summary that only counts passes hides a red line in
// a long log -- and this suite's whole job is to be readable when it fails.
const passed = results.filter(item => item.startsWith('PASS')).length
console.log(`\nstoryboard-spec: ${passed}/${results.length} checks ok`)
