/**
 * Fixture validation shared by the real-browser layout guards.
 *
 * A layout guard renders hand-written HTML, which is its structural weakness: if
 * the component renames a class or drops a section, the fixture keeps rendering
 * the OLD markup, Chrome keeps measuring it, and the guard stays green while
 * describing a component that no longer exists. So each guard resolves every
 * class in its fixture against the real sources first.
 *
 * This lived only in verify-video-layout.mjs. The second guard (the canvas's
 * bottom chrome) needs the same two checks, and a copy would have drifted: the
 * two would disagree about what "unknown class" means the first time either was
 * edited. Both now call this.
 *
 * The checks are deliberately two-sided, because each catches a different drift:
 *  - the component no longer renders the class: the fixture is measuring markup
 *    that is gone;
 *  - the stylesheet no longer defines the class: the arrangement being measured
 *    is not the arrangement that ships.
 */

/**
 * The class names a fixture's markup actually uses.
 *
 * Read OUT of the markup rather than kept as a second hand-written list: a list
 * can be edited to match a renamed class and quietly re-green the guard, while
 * this cannot drift from what Chrome receives.
 * @param {string} page - the fixture HTML.
 * @param {ReadonlySet<string>} [scaffold] - names that style the page around the
 *   component (a stand-in for the host shell) and are not the component's own.
 * @returns {string[]} unique, sorted class names in first-appearance order.
 */
export function collectFixtureClasses (page, scaffold = new Set()) {
  return [...new Set(
    [...page.matchAll(/class="([^"]+)"/g)].flatMap(match => match[1].trim().split(/\s+/)),
  )].filter(name => !scaffold.has(name))
}

/**
 * The fixture's classes that the component or the stylesheet does not know.
 * @param {readonly string[]} names - classes from {@link collectFixtureClasses}.
 * @param {object} sources
 * @param {ReadonlySet<string>} sources.componentClasses - every `css.x` in the
 *   component source(s), collected by the caller.
 * @param {ReadonlySet<string>} sources.stylesheetClasses - every `.x` in the CSS.
 * @param {string} sources.componentName - the source file(s), for the message.
 * @param {string} sources.stylesheetName - the CSS file, for the message.
 * @returns {string[]} human-readable problems; empty means every class is real.
 */
export function missingFixtureClasses (names, { componentClasses, stylesheetClasses, componentName, stylesheetName }) {
  const unknown = []
  for (const name of names) {
    if (!componentClasses.has(name)) unknown.push(`${name} (not rendered by ${componentName})`)
    else if (!stylesheetClasses.has(name)) unknown.push(`${name} (not defined in ${stylesheetName})`)
  }
  return unknown
}

/**
 * Every `css.x` reference in one or more component sources.
 * @param {string} source - the TSX (or several, concatenated).
 * @returns {Set<string>}
 */
export function componentClassNames (source) {
  return new Set([...source.matchAll(/\bcss\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map(match => match[1]))
}

/**
 * Every `.x` selector in a stylesheet.
 * @param {string} css
 * @returns {Set<string>}
 */
export function stylesheetClassNames (css) {
  return new Set([...css.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map(match => match[1]))
}

/**
 * Validate a fixture's classes, including a self-test that the validator itself
 * discriminates, and exit 1 with a readable report on any problem.
 *
 * The self-test uses names of its own so it proves the VALIDATOR rather than the
 * fixture: a validator that always returned `[]` would let every stale fixture
 * through, and this is the one bug that silently re-greens a layout guard.
 * @param {object} options
 * @param {string} options.page - the fixture HTML; its classes are read from it.
 * @param {ReadonlySet<string>} [options.scaffold] - page-scaffolding classes.
 * @param {string} options.componentSource - component TSX source text.
 * @param {string} options.componentName - what to call it in messages.
 * @param {string} options.stylesheet - the module CSS text.
 * @param {string} options.stylesheetName - what to call it in messages.
 * @param {readonly [string, string]} options.selfTest - one invented name (must
 *   be reported) and one real name (must not be), so the pair proves both
 *   directions of the check.
 * @returns {string[]} the validated class names, for the caller to report.
 * @throws calls process.exit(1) when the fixture no longer matches the source.
 */
export function assertFixtureClasses ({ page, scaffold, componentSource, componentName, stylesheet, stylesheetName, selfTest }) {
  const componentClasses = componentClassNames(componentSource)
  const stylesheetClasses = stylesheetClassNames(stylesheet)
  const describe = { componentClasses, stylesheetClasses, componentName, stylesheetName }

  const [invented, real] = selfTest
  if (missingFixtureClasses([invented], describe).length !== 1
    || missingFixtureClasses([real], describe).length !== 0) {
    console.error('STALE FIXTURE GUARD: the class validator does not discriminate')
    process.exit(1)
  }

  const classes = collectFixtureClasses(page, scaffold)
  const unknown = missingFixtureClasses(classes, describe)
  if (unknown.length > 0) {
    console.error('\n' + '='.repeat(72))
    console.error('FAIL: the layout fixture no longer matches the real component.')
    for (const entry of unknown) console.error(`  - ${entry}`)
    console.error(`Update the fixture to the classes ${componentName} really renders,`)
    console.error('or the layout measured here is not the layout that ships.')
    console.error('='.repeat(72) + '\n')
    process.exit(1)
  }
  console.log(`fixture classes verified against ${componentName} + ${stylesheetName}: ${classes.length}`)
  return classes
}
