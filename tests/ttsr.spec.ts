import { describe, expect, it, vi, type Mock } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createJudge } from '../src/judge.ts'
import { buildRuleFromMarkdown, type Rule } from '../src/rule.ts'
import { RuleSession } from '../src/session.ts'
import { interrupts, TtsrManager, type TtsrSettings } from '../src/ttsr.ts'

const SOURCE = { provider: 'native', path: '/tmp/x.md', priority: 100 }

function rule(content: string): Rule {
  return buildRuleFromMarkdown({ name: 'r', path: '/tmp/x.md', content, source: SOURCE })
}

function manager(overrides: Partial<TtsrSettings> = {}): TtsrManager {
  const settings: TtsrSettings = { enabled: true, interruptMode: 'always', repeatMode: 'once', repeatGap: 10, ...overrides }
  return new TtsrManager(() => settings)
}

/** A session over already-registered rules, with a recording agent. */
function session(rules: readonly Rule[], ttsr: TtsrManager): { session: RuleSession; agent: Agent; inject: Mock } {
  const inject = vi.fn()
  const agent = { id: 'session-1', cancel: vi.fn(), steer: vi.fn(), inject } as unknown as Agent
  const built = new RuleSession(rules, rules, rules, new Map(), ttsr, '/workspace/project', () => 'always')
  return { session: built, agent, inject }
}

describe('interrupts', () => {
  it('never interrupts under never', () => {
    expect(interrupts('never', 'text')).toBe(false)
    expect(interrupts('never', 'tool')).toBe(false)
  })

  it('interrupts every surface under always', () => {
    expect(interrupts('always', 'text')).toBe(true)
    expect(interrupts('always', 'tool')).toBe(true)
  })

  it('gates prose-only on prose surfaces', () => {
    expect(interrupts('prose-only', 'text')).toBe(true)
    expect(interrupts('prose-only', 'thinking')).toBe(true)
    expect(interrupts('prose-only', 'tool')).toBe(false)
  })

  it('gates tool-only on tool surfaces', () => {
    expect(interrupts('tool-only', 'tool')).toBe(true)
    expect(interrupts('tool-only', 'text')).toBe(false)
  })
})

describe('TtsrManager.addRule', () => {
  it('refuses every rule while streaming rules are disabled', () => {
    expect(manager({ enabled: false }).addRule(rule('---\ncondition: a\n---\n')).reason).toBe('disabled')
  })

  it('refuses a rule with no trigger', () => {
    expect(manager().addRule(rule('no trigger')).reason).toBe('no-trigger')
  })

  it('refuses a rule whose only regex does not compile', () => {
    const result = manager().addRule(rule('---\ncondition: "("\n---\n'))
    expect(result.accepted).toBe(false)
    expect(manager().warnings).toBeDefined()
  })

  it('records the invalid-regex reason', () => {
    expect(manager().addRule(rule('---\ncondition: "("\n---\n')).reason).toBe('invalid-regex')
  })

  it('refuses a duplicate name', () => {
    const ttsr = manager()
    expect(ttsr.addRule(rule('---\ncondition: a\n---\n')).accepted).toBe(true)
    expect(ttsr.addRule(rule('---\ncondition: b\n---\n')).reason).toBe('duplicate-name')
  })

  it('refuses an empty scope that can never match a stream', () => {
    const result = manager().addRule({ ...rule('---\ncondition: a\n---\n'), scope: [] })
    expect(result.reason).toBe('unreachable-scope')
  })

  it('keeps a narrow scope registered rather than retiring it', () => {
    expect(manager().addRule(rule('---\ncondition: a\nscope: "tool:edit(**/*.ts)"\n---\n')).accepted).toBe(true)
  })

  it('accepts a question rule with no regex at all', () => {
    expect(manager().addRule(rule('---\nquestion: did it?\n---\n')).accepted).toBe(true)
  })
})

describe('TtsrManager matching', () => {
  it('matches text within the default scope', () => {
    const ttsr = manager()
    ttsr.addRule(rule('---\ncondition: forbidden\n---\n'))
    expect(ttsr.checkDelta('a forbidden thing', { source: 'text' })).toHaveLength(1)
  })

  it('does not watch thinking under the default scope', () => {
    const ttsr = manager()
    ttsr.addRule(rule('---\ncondition: forbidden\n---\n'))
    expect(ttsr.checkDelta('forbidden', { source: 'thinking' })).toEqual([])
  })

  it('watches thinking when the scope asks for it', () => {
    const ttsr = manager()
    ttsr.addRule(rule('---\ncondition: forbidden\nscope: "text, thinking"\n---\n'))
    expect(ttsr.checkDelta('forbidden', { source: 'thinking' })).toHaveLength(1)
  })

  it('applies an inline case-insensitive flag', () => {
    const ttsr = manager()
    ttsr.addRule(rule('---\ncondition: "(?i)FORBIDDEN"\n---\n'))
    expect(ttsr.checkDelta('forbidden', { source: 'text' })).toHaveLength(1)
  })

  it('gates on a named tool', () => {
    const ttsr = manager()
    ttsr.addRule(rule('---\ncondition: forbidden\nscope: "tool:write(**)"\n---\n'))
    expect(ttsr.checkDelta('forbidden', { source: 'tool', tool: 'edit', paths: ['a.ts'] })).toEqual([])
    expect(ttsr.checkDelta('forbidden', { source: 'tool', tool: 'write', paths: ['a.ts'] })).toHaveLength(1)
  })

  it('gates on a per-tool path glob', () => {
    const ttsr = manager()
    ttsr.addRule(rule('---\ncondition: forbidden\nscope: "tool:edit(*.ts)"\n---\n'))
    expect(ttsr.checkDelta('forbidden', { source: 'tool', tool: 'edit', paths: ['a.md'] })).toEqual([])
    expect(ttsr.checkDelta('forbidden', { source: 'tool', tool: 'edit', paths: ['a.ts'] })).toHaveLength(1)
  })

  it('requires a matching path when the rule declares globs', () => {
    const ttsr = manager()
    ttsr.addRule(rule('---\ncondition: forbidden\nglobs: "**/*.surql"\n---\n'))
    expect(ttsr.checkDelta('forbidden', { source: 'tool', tool: 'edit' })).toEqual([])
    expect(ttsr.checkDelta('forbidden', { source: 'tool', tool: 'edit', paths: ['x.surql'] })).toHaveLength(1)
  })

  it('returns nothing while disabled', () => {
    const ttsr = manager({ enabled: false })
    ttsr.addRule(rule('---\ncondition: forbidden\n---\n'))
    expect(ttsr.checkDelta('forbidden', { source: 'text' })).toEqual([])
    expect(ttsr.hasRules()).toBe(false)
  })

  it('matches a whole snapshot rather than one delta', () => {
    const ttsr = manager()
    ttsr.addRule(rule('---\ncondition: "const x = \\d+"\n---\n'))
    expect(ttsr.checkSnapshot('const x = 1', { source: 'tool', tool: 'write' })).toHaveLength(1)
    expect(ttsr.checkSnapshot('let y = 1', { source: 'tool', tool: 'write' })).toEqual([])
  })
})

describe('TtsrManager repeat policy', () => {
  it('allows a rule once in once mode', () => {
    const ttsr = manager({ repeatMode: 'once' })
    const target = rule('---\ncondition: forbidden\n---\n')
    ttsr.addRule(target)

    expect(ttsr.claim(target)).toBe(true)
    expect(ttsr.claim(target)).toBe(false)
  })

  it('requires the gap in after-gap mode', () => {
    const ttsr = manager({ repeatMode: 'after-gap', repeatGap: 2 })
    const target = rule('---\ncondition: forbidden\n---\n')
    ttsr.addRule(target)

    expect(ttsr.claim(target)).toBe(true)
    expect(ttsr.claim(target)).toBe(false)
    ttsr.countTurn()
    expect(ttsr.claim(target)).toBe(false)
    ttsr.countTurn()
    expect(ttsr.claim(target)).toBe(true)
  })

  it('reports and restores injected names', () => {
    const ttsr = manager({ repeatMode: 'after-gap', repeatGap: 1 })
    const target = rule('---\ncondition: forbidden\n---\n')
    ttsr.addRule(target)
    ttsr.claim(target)
    expect(ttsr.injectedNames()).toEqual(['r'])

    const restored = manager({ repeatMode: 'after-gap', repeatGap: 1 })
    restored.addRule(target)
    restored.restoreInjected(['r'])
    expect(restored.claim(target)).toBe(false)
    restored.countTurn()
    expect(restored.claim(target)).toBe(true)
  })
})

describe('TtsrManager judged candidates', () => {
  it('selects question rules passing scope and prefilter', () => {
    const ttsr = manager()
    const judged = rule('---\nquestion: did it claim success?\ncondition: claimed\nscope: text\n---\n')
    ttsr.addRule(judged)

    expect(ttsr.judgedCandidates('it claimed success', { source: 'text' })).toEqual([judged])
    expect(ttsr.judgedCandidates('unrelated prose', { source: 'text' })).toEqual([])
  })

  it('never surfaces a judged rule through the regex path', () => {
    const ttsr = manager()
    const judged = rule('---\nquestion: q\ncondition: forbidden\n---\n')
    ttsr.addRule(judged)
    expect(ttsr.checkDelta('forbidden', { source: 'text' })).toEqual([])
  })

  it('stops judging as soon as streaming rules are switched off', () => {
    // The toggle is volatile: a rule registered while TTSR was on must go
    // quiet on the next message, not only on the next registration pass.
    const settings: TtsrSettings = { enabled: true, interruptMode: 'always', repeatMode: 'once', repeatGap: 10 }
    const ttsr = new TtsrManager(() => settings)
    const judged = rule('---\nquestion: did it claim success?\ncondition: claimed\n---\n')
    ttsr.addRule(judged)

    settings.enabled = false
    expect(ttsr.judgedCandidates('it claimed success', { source: 'text' })).toEqual([])
    // The one-shot budget is untouched, so the rule returns the moment TTSR
    // is back on — which is what proves the empty result above was the
    // `enabled` guard refusing, and not a spent rule answering either way.
    settings.enabled = true
    expect(ttsr.judgedCandidates('it claimed success', { source: 'text' })).toEqual([judged])
  })
})

describe('judged repeat policy', () => {
  it('delivers a one-shot question rule once, not on every later message', () => {
    const judged = rule('---\nquestion: did it claim success?\ncondition: claimed\nscope: text\n---\nbody')
    const ttsr = manager({ repeatMode: 'once' })
    ttsr.addRule(judged)
    const { session: rules, agent, inject } = session([judged], ttsr)

    const first = rules.judged('it claimed success', { source: 'text' })
    rules.deliverWarnings(agent, first)
    const second = rules.judged('it claimed success', { source: 'text' })
    rules.deliverWarnings(agent, second)

    expect(second).toEqual([])
    expect(inject).toHaveBeenCalledTimes(1)
    expect(String(inject.mock.calls[0]?.[0]?.content?.[0]?.text)).toContain('body')
  })
})

describe('tool argument buffers', () => {
  const TOOL_RULE = '---\ncondition: forbidden\nscope: tool\ninterruptMode: never\n---\nbody'

  it('never joins the arguments of two different calls', () => {
    const subject = rule(TOOL_RULE)
    const ttsr = manager()
    ttsr.addRule(subject)
    const { session: rules, agent } = session([subject], ttsr)

    // Neither call contains the phrase; only the seam between them would.
    rules.observeDelta(agent, 'tool', 'this is for', { tool: 'write', callId: 'call-1' })
    rules.observeDelta(agent, 'tool', 'bidden', { tool: 'write', callId: 'call-2' })

    expect(rules.takeToolReminder('call-2')).toBeUndefined()
    // A phantom hit would also spend the one-shot budget.
    expect(ttsr.injectedNames()).toEqual([])
  })

  it('still matches across chunks of one call', () => {
    const subject = rule(TOOL_RULE)
    const ttsr = manager()
    ttsr.addRule(subject)
    const { session: rules, agent } = session([subject], ttsr)

    rules.observeDelta(agent, 'tool', 'this is for', { tool: 'write', callId: 'call-1' })
    rules.observeDelta(agent, 'tool', 'bidden', { tool: 'write', callId: 'call-1' })

    expect(rules.takeToolReminder('call-1')).toContain('<system-reminder')
  })
})

describe('judge request deadline', () => {
  it('gives up on a stalled provider instead of pending forever', async () => {
    const judged = rule('---\nquestion: did it claim success?\n---\nbody')
    // A provider that accepts the signal and then never terminates: the case
    // that used to leave one pending request per assistant message.
    const seen: AbortSignal[] = []
    const stream = vi.fn((options: { signal?: AbortSignal }) => {
      if (options.signal !== undefined) seen.push(options.signal)
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>(() => {})
        },
      }
    })
    const ctx = { llm: { stream } } as unknown as Context

    const judge = createJudge(ctx, { provider: 'test', model: 'test' }, 20)
    await expect(judge.ask([judged], 'it claimed success')).rejects.toThrow(/deadline/)
    // The deadline reaches the provider too, so the call is cancelled, not just
    // abandoned — otherwise the abandoned request would keep its socket open.
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(seen[0]?.aborted).toBe(true)
  })
})
