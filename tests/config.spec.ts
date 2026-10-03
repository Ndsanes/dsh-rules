import { describe, expect, it } from 'vitest'
import { formatModeOverride, liveTtsr } from '../src/config.ts'

/**
 * `ttsr.modeOverrides` is stored as `<rule-name>=<mode>` entries.
 *
 * A list of strings, like `disabledRules` beside it, rather than a mapping:
 * schemastery's one record-shaped schema reaches into cosmokit, which this
 * package does not depend on, and leaves the exported `Config` unnameable. A
 * rule name may legitimately contain an `=`, so the split is on the last one.
 */
const overridesOf = (entries: readonly string[]): Readonly<Record<string, string>> =>
  liveTtsr({ ttsr: { modeOverrides: entries } } as never).modeOverrides as Readonly<Record<string, string>>

describe('ttsr.modeOverrides', () => {
  it('reads entries into a lookup by rule name', () => {
    expect(overridesOf(['ts-set-map=never', 'go-ioutil=prose-only'])).toEqual({
      'ts-set-map': 'never',
      'go-ioutil': 'prose-only',
    })
  })

  it('drops an entry that names no mode rather than half-applying it', () => {
    // A malformed entry is a typo in a profile patch. Guessing at it would
    // silently put a rule into a mode nobody asked for.
    expect(overridesOf(['no-equals', '=never', 'x=bogus', 'ok=always'])).toEqual({ ok: 'always' })
  })

  it('splits on the last = so a rule name may contain one', () => {
    expect(overridesOf(['a=b=never'])).toEqual({ 'a=b': 'never' })
  })

  it('survives the round trip through the stored form', () => {
    expect(overridesOf([formatModeOverride('x', 'tool-only')])).toEqual({ x: 'tool-only' })
  })

  it('is empty when nothing is configured', () => {
    expect(overridesOf([])).toEqual({})
    expect(liveTtsr(undefined).modeOverrides).toEqual({})
  })
})
