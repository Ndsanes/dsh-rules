import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { astMatch, languageForPath } from '../src/ast.ts'
import { buildRuleFromMarkdown, type Rule } from '../src/rule.ts'
import { createRuleTool, type RuleLookup, type RuleToggle } from '../src/tool.ts'

function rule(name: string, body: string): Rule {
  return buildRuleFromMarkdown({
    name,
    path: `/tmp/${name}.md`,
    content: `---\ndescription: d\n---\n${body}\n`,
    source: { provider: 'native', path: `/tmp/${name}.md`, priority: 1 },
  })
}

/** Capture the registered tool so its executor can be driven directly. */
function captureTool(): { tool: ToolDefinition; dispose: () => void } {
  const dispose = registerSpy()
  let registered: ToolDefinition | undefined
  const tool = createRuleTool(
    definition => {
      registered = definition
      return dispose
    },
    () => currentLookup(),
    currentToggle,
  )
  expect(tool.name).toBe('rule')
  if (registered === undefined) throw new Error('tool was not registered')
  return { tool: registered, dispose }
}

function registerSpy(): () => void {
  return () => undefined
}

let active: readonly Rule[] = []
let discovered: readonly Rule[] = []
let inactive: ReadonlyMap<string, string> = new Map()
let lookupState: 'ready' | 'building' | 'no-agent' = 'ready'
let disabled: string[] = []
let persisted: string[] | undefined
let guidance = 'guidance text'

/** Current lookup answer for the captured tool. */
function currentLookup(): RuleLookup {
  if (lookupState === 'no-agent') return { state: 'no-agent' }
  if (lookupState === 'building') return { state: 'building' }
  return {
    state: 'ready',
    snapshot: { rules: new Map(active.map(entry => [entry.name, entry])), all: discovered.length > 0 ? [...discovered] : [...active], inactive },
  }
}

/** The toggle surface the captured tool drives. */
function currentToggle(): RuleToggle {
  return {
    toggleable: ['bundled-a', 'bundled-b'],
    get disabled() {
      return disabled
    },
    setDisabled: async intent => {
      if (guidance !== '') return { ok: false, guidance }
      // The writer resolves the intent against the live set, which is what a
      // real one does; the stub holds it in `disabled` for the same reason.
      // The real writer de-duplicates and sorts before it stores.
      disabled = [...new Set(intent(disabled))].sort()
      persisted = [...disabled]
      return { ok: true }
    },
  }
}

function run(tool: ToolDefinition, args: unknown): Promise<string> {
  const exec = {} as ToolRunContext
  return tool.execute(args, exec) as Promise<string>
}

describe('createRuleTool', () => {
  it('returns the rule body for an exact name', async () => {
    active = [rule('a', 'the body')]
    const { tool } = captureTool()
    expect(await run(tool, { name: 'a' })).toBe('the body')
  })

  it('lists the available names for an unknown rule', async () => {
    active = [rule('a', 'x'), rule('b', 'y')]
    const { tool } = captureTool()

    const answer = await run(tool, { name: 'missing' })
    expect(answer).toContain('Unknown rule "missing"')
    expect(answer).toContain('Available rules: a, b')
  })

  it('says so when no rule is addressable at all', async () => {
    active = []
    const { tool } = captureTool()
    expect(await run(tool, { name: 'a' })).toContain('No rules are addressable')
  })

  it('explains a known rule that is not in force', async () => {
    active = []
    inactive = new Map([['a', 'listed in ttsr.disabledRules']])
    const { tool } = captureTool()
    expect(await run(tool, { name: 'a' })).toContain('listed in ttsr.disabledRules')
  })

  it('says the session rules are still being discovered, not that there are none', async () => {
    lookupState = 'building'
    const { tool } = captureTool()
    const answer = await run(tool, { name: 'a' })
    expect(answer).toContain('still being discovered')
    expect(answer).toContain('created before the rules layer was mounted')
  })

  it('distinguishes a call that is bound to no session at all', async () => {
    lookupState = 'no-agent'
    const { tool } = captureTool()
    expect(await run(tool, { name: 'a' })).toContain('not bound to a session')
  })

  it('advertises the rule:// addressing form in its schema', () => {
    active = []
    const { tool } = captureTool()
    expect(tool.description).toContain('rule://<name>')
    expect(Object.keys(tool.parameters.properties ?? {})).toContain('name')
  })

  it('returns the host disposer it was given', () => {
    active = []
    lookupState = 'ready'
    let disposed = false
    const hostDisposer = (): void => { disposed = true }
    const { dispose } = createRuleTool(() => hostDisposer, () => currentLookup(), currentToggle)

    expect(disposed).toBe(false)
    dispose()
    expect(disposed).toBe(true)
  })
})

describe('rule management', () => {
  beforeEach(() => {
    active = [rule('bundled-a', 'a body')]
    discovered = [rule('bundled-a', 'a body'), rule('bundled-b', 'b body')]
    inactive = new Map([['bundled-b', 'listed in ttsr.disabledRules']])
    disabled = ['bundled-b']
    persisted = undefined
    guidance = ''
    lookupState = 'ready'
  })

  it('lists every rule with its state and the reason it is off', async () => {
    const { tool } = captureTool()
    const answer = await run(tool, { action: 'list' })

    expect(answer).toContain('on   bundled-a')
    expect(answer).toContain('off  bundled-b (inactive: listed in ttsr.disabledRules)')
    expect(answer).toContain('2 bundled')
  })

  it('marks a bundled rule as bundled in the listing', async () => {
    const origin = { provider: 'builtin-defaults', path: 'builtin-defaults:bundled-a.md', priority: 1 }
    active = [{ ...rule('bundled-a', 'a body'), _source: origin }]
    discovered = [{ ...rule('bundled-a', 'a body'), _source: origin }]
    const { tool } = captureTool()
    expect(await run(tool, { action: 'list' })).toContain('[bundled]')
  })

  it('disables a bundled rule by persisting the disabled set', async () => {
    const { tool } = captureTool()
    const answer = await run(tool, { action: 'disable', name: 'bundled-a' })

    expect(persisted).toEqual(['bundled-a', 'bundled-b'])
    expect(answer).toContain('now disabled')
  })

  it('re-enables a bundled rule by removing it from the disabled set', async () => {
    const { tool } = captureTool()
    const answer = await run(tool, { action: 'enable', name: 'bundled-b' })

    expect(persisted).toEqual([])
    expect(answer).toContain('now enabled')
  })

  it('refuses to toggle a rule that is not bundled', async () => {
    active = [rule('user-rule', 'mine')]
    const { tool } = captureTool()
    const answer = await run(tool, { action: 'disable', name: 'user-rule' })

    expect(answer).toContain('not a bundled rule')
    expect(answer).toContain('edit that file')
    expect(persisted).toBeUndefined()
  })

  it('reports the guidance instead of claiming success when the write fails', async () => {
    guidance = 'no settings service here'
    const { tool } = captureTool()
    const answer = await run(tool, { action: 'disable', name: 'bundled-a' })

    expect(answer).toContain('no settings service here')
    expect(answer).not.toContain('now disabled')
  })
})

describe('languageForPath', () => {
  it('maps the bundled grammars', () => {
    expect(languageForPath('src/a.ts')).toBeDefined()
    expect(languageForPath('src/a.tsx')).toBeDefined()
    expect(languageForPath('src/a.js')).toBeDefined()
  })

  it('returns undefined for an unknown extension', () => {
    expect(languageForPath('README.md')).toBeUndefined()
    expect(languageForPath('Makefile')).toBeUndefined()
  })
})

describe('astMatch', () => {
  it('matches a structural pattern in the right grammar', () => {
    expect(astMatch('function f(){ return 1 }', 'a.ts', ['return $X'])).toBe(true)
  })

  it('does not match when the structure is absent', () => {
    expect(astMatch('const a = 1', 'a.ts', ['return $X'])).toBe(false)
  })

  it('skips a path whose grammar is unknown', () => {
    expect(astMatch('return 1', 'a.unknown', ['return $X'])).toBe(false)
  })

  it('does not throw on unparsable source', () => {
    expect(astMatch('function ( {', 'a.ts', ['return $X'])).toBe(false)
  })

  it('matches on any one of several patterns', () => {
    expect(astMatch('function f(){ return 1 }', 'a.ts', ['await $X', 'return $X'])).toBe(true)
  })
})
