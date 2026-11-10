/**
 * One check runner for every standalone suite.
 *
 * WHY this file exists: each suite used to carry its own copy of `check()`, and
 * the copy was subtly wrong in the same way in all of them. The deadline was
 * treated as a verdict -- overrun the budget and the check was recorded `FAIL`,
 * `process.exitCode` set to 1, before anyone knew whether the assertions had
 * actually failed. On a loaded machine (these suites are routinely run beside a
 * build) a correct check crossed the line and was reported broken. The same tree
 * then passed and failed on consecutive runs, which is worse than a slow suite:
 * a green run stops meaning anything, and the habit becomes to re-run until it
 * is green.
 *
 * The deadline is a HANG guard, not a performance budget. What it is for: a mock
 * upstream that accepts the socket and never answers, a React effect that stops
 * flushing under jsdom. Those never settle, and the guard names them. A check
 * that settles -- however late -- reports what it actually found:
 *
 *   settled and passed   -> PASS, annotated with how far past the budget it ran
 *   settled and failed   -> FAIL with the real assertion message
 *   never settled        -> FAIL saying the late assertions stay unverified
 *
 * Six suites had six copies; the defect was in six places and the seventh copy
 * (written later) would have inherited it by example. One implementation is the
 * fix that does not come back.
 */

/**
 * How long a check that already blew its deadline is still watched for a verdict.
 *
 * Ten minutes: long enough that a check which genuinely finishes gets to say so
 * even on a badly loaded machine, short enough that a truly hung one still ends
 * the run instead of holding it forever. The check's own budget lives in
 * `CHECK_TIMEOUT_MS`; this is only the courtesy window after it.
 */
export const LATE_SETTLE_MS = 600_000

/**
 * Default per-check budget: a HANG guard, not a performance budget.
 *
 * Three minutes. The suites that mount the real client bundle under jsdom take
 * tens of seconds when idle and have been measured at 92s under load; sixty
 * seconds did not separate "slow machine" from "hung". Override with
 * `SMOKE_CHECK_TIMEOUT_MS` to pin a number (a hang bisect, or CI).
 *
 * This is a default, not a ceiling: a suite that knows a check is heavier passes
 * its own value as the third argument.
 */
export const CHECK_TIMEOUT_MS = Number(process.env.SMOKE_CHECK_TIMEOUT_MS ?? '') || 180_000

/**
 * Distinguishes this guard's own deadline from an assertion that threw something
 * carrying the same text. Matching on the message string (which is what the old
 * copies did) means a check whose own error message happened to start the same
 * way would be treated as a timeout and silently downgraded.
 */
class CheckTimeout extends Error {
  constructor (timeoutMs) {
    super(`timed out after ${timeoutMs}ms`)
    this.timeoutMs = timeoutMs
  }
}

/**
 * Await `promise` for at most `ms` and report how it ended rather than throwing.
 *
 * A handler is attached before the wait, so a rejection landing after it is
 * already handled instead of becoming an unhandled rejection that kills the run.
 */
export function settleWithin (promise, ms) {
  return Promise.race([
    promise.then(() => ({ settled: true, error: undefined }), error => ({ settled: true, error })),
    new Promise(resolve => {
      const guard = setTimeout(() => resolve({ settled: false, error: undefined }), ms)
      // Merely watching a slow check must not keep the process alive.
      guard.unref?.()
    }),
  ])
}

const messageOf = error => (error instanceof Error ? error.message : String(error))
const spent = startedAt => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`

/**
 * Build this suite's `check()`.
 *
 * @param {object} options
 * @param {string[]} options.results - the suite's own results array; lines are
 *   pushed onto it in the order the checks ran, as every suite already prints.
 * @param {(error: unknown) => boolean} [options.isSkip] - true for a check that
 *   could not run on this machine (missing ffmpeg, missing browser). Skips are
 *   reported and are not failures, checked BEFORE the deadline handling.
 * @param {(name: string, error: Error) => void} [options.onSkip] - extra output
 *   a suite wants for a skip; the `SKIP` line itself is pushed by this runner.
 * @param {(error: unknown) => string} [options.formatError] - how a failure
 *   prints. Defaults to `error.message`; a suite that wants the stack (a render
 *   failing inside a child process) passes its own.
 * @returns {(name: string, fn: () => unknown, timeoutMs?: number) => Promise<void>}
 */
export function createCheckHarness ({ results, isSkip, onSkip, formatError = messageOf }) {
  return async function check (name, fn, timeoutMs = CHECK_TIMEOUT_MS) {
    // Progress goes to stderr so a hung check is identifiable from the log alone.
    process.stderr.write(`... ${name}\n`)
    const startedAt = Date.now()
    // Started exactly once: the timeout path watches this same promise, because
    // calling `fn()` again there would run the whole check a second time.
    const ran = Promise.resolve().then(fn)
    // Set only when this check is actually recorded as a failure. The old copies
    // set it as soon as the deadline fired, which made a slow-but-correct check
    // poison the exit code even after the verdict said it passed.
    let failed = false
    let timer
    try {
      await Promise.race([
        ran,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new CheckTimeout(timeoutMs)), timeoutMs)
        }),
      ])
      results.push(`PASS  ${name}`)
    } catch (error) {
      if (isSkip !== undefined && isSkip(error)) {
        results.push(`SKIP  ${name}: ${messageOf(error)}`)
        onSkip?.(name, error)
        return
      }
      if (!(error instanceof CheckTimeout)) {
        results.push(`FAIL  ${name}: ${formatError(error)}`)
        failed = true
        return
      }
      clearTimeout(timer)
      // Overrunning the budget means "slower than budgeted", which is not a fact
      // about the code. The verdict is whatever the check finally does.
      const late = await settleWithin(ran, LATE_SETTLE_MS)
      if (!late.settled) {
        results.push(`FAIL  ${name}: timed out after ${timeoutMs}ms; still running at ${spent(startedAt)}, the assertions past the deadline stay unverified`)
        failed = true
      } else if (late.error === undefined) {
        results.push(`PASS  ${name} (slow: overran ${timeoutMs}ms, settled at ${spent(startedAt)})`)
      } else {
        results.push(`FAIL  ${name}: ${formatError(late.error)}`)
        failed = true
      }
    } finally {
      clearTimeout(timer)
      if (failed) process.exitCode = 1
    }
  }
}
