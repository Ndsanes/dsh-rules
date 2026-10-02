import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Config } from '../src/config.ts'
import { resolveConfig } from '../src/config.ts'
import { buildRuleFromMarkdown, type Rule } from '../src/rule.ts'
import { RuleSession, toolPaths, toolSnapshot } from '../src/session.ts'
import { TtsrManager, type TtsrSettings } from '../src/ttsr.ts'

const SOURCE = { provider: 'native', path: '/tmp/x.md', priority: 100 }

function rule(name: string, content: string): Rule {
  return buildRuleFromMarkdown({ name, path: `/tmp/${name}.md`, content, source: SOURCE })
}

/** Recording stand-in for the live agent, capturing every delivery channel. */
function fakeAgent(): { agent: Agent; cancel: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; inject: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn()
  const steer = vi.fn()
  const inject = vi.fn()
  const agent: Agent = { id: 'session-1', cancel, steer, inject } as unknown as Agent
  return { agent, cancel, steer, inject }
}

function session(rules: Rule[], overrides: Config = {}) {
  const settings: TtsrSettings = { enabled: true, interruptMode: 'always', repeatMode: 'once', repeatGap: 10 }
  const ttsr = new TtsrManager(() => settings)
  for (const subject of rules) ttsr.addRule(subject)
  const resolved = resolveConfig({ ...overrides, ttsr: overrides.ttsr })
  return new RuleSession(
    rules,
    rules,
    rules,
    new Map(),
    ttsr,
    '/workspace/project',
    () => resolved.ttsr.interruptMode,
  )
}

describe('observeDelta', () => {
  it('aborts the turn and re-queues the rule body on an interrupting match', async () => {
    const { agent, cancel, steer } = fakeAgent()
    const rules = [rule('a', '---\ncondition: forbidden\n---\nrule body')]
    const rules2 = session(rules)

    rules2.observeDelta(agent, 'text', 'a forbidden line')
    await new Promise<void>(resolve => setTimeout(resolve, 5))

    expect(cancel).toHaveBeenCalledWith(
      { kind: 'hook', reason: 'TTSR rule violation: a' },
      { keepInbox: true },
    )
    expect(steer).toHaveBeenCalledTimes(1)
    expect(String(steer.mock.calls[0]?.[0]?.content?.[0]?.text)).toContain('<system-interrupt')
    expect(String(steer.mock.calls[0]?.[0]?.content?.[0]?.text)).toContain('rule body')
  })

  it('never aborts under interruptMode never and defers a reminder instead', () => {
    const { agent, cancel, inject } = fakeAgent()
    const rules = session([rule('a', '---\ncondition: forbidden\ninterruptMode: never\n---\nrule body')])

    rules.observeDelta(agent, 'text', 'a forbidden line')
    expect(cancel).not.toHaveBeenCalled()

    rules.flushProsePending(agent)
    expect(inject).toHaveBeenCalledTimes(1)
    expect(String(inject.mock.calls[0]?.[0]?.content?.[0]?.text)).toContain('<system-reminder')
  })

  it('aborts only prose for prose-only and leaves tool matches to the reminder path', () => {
    const { agent, cancel } = fakeAgent()
    const rules = session([rule('a', '---\ncondition: forbidden\ninterruptMode: prose-only\n---\nbody')])

    rules.observeDelta(agent, 'tool', 'forbidden', { tool: 'write' })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('matches across chunk boundaries through the rolling buffer', () => {
    const { agent, cancel } = fakeAgent()
    const rules = session([rule('a', '---\ncondition: "forbidden"\n---\nbody')])

    rules.observeDelta(agent, 'text', 'this is for')
    expect(cancel).not.toHaveBeenCalled()
    rules.observeDelta(agent, 'text', 'bidden')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('buckets a tool match against its own tool call', () => {
    const { agent, cancel } = fakeAgent()
    const rules = session([rule('a', '---\ncondition: forbidden\nscope: tool\n---\nbody')])

    rules.observeDelta(agent, 'tool', 'forbidden', { tool: 'write', callId: 'call-1' })
    expect(cancel).not.toHaveBeenCalled()
    expect(rules.takeToolReminder('call-1')).toContain('<system-reminder')
  })

  it('clears buffers and pending retries when the next turn starts', () => {
    const { agent, cancel } = fakeAgent()
    const rules = session([rule('a', '---\ncondition: forbidden\n---\nbody')])

    rules.observeDelta(agent, 'text', 'forbidden')
    rules.beginTurn(2)
    expect(rules.takeToolReminder('tool:write')).toBeUndefined()
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('toolViolations', () => {
  it('blocks a regex violation on the reconstructed source', () => {
    const rules = session([rule('a', '---\ncondition: "DROP TABLE"\nscope: tool\n---\nbody')])
    const outcome = rules.toolViolations('DROP TABLE users', { source: 'tool', tool: 'write', paths: ['x.sql'] })
    expect(outcome.blocking).toHaveLength(1)
    expect(outcome.warnings).toEqual([])
  })

  it('warns instead of blocking when the rule only wants to inform', () => {
    const rules = session([rule('a', '---\ncondition: ".*"\nscope: tool\ninterruptMode: never\n---\nbody')])
    const outcome = rules.toolViolations('anything', { source: 'tool', tool: 'write', callId: 'c1' })

    expect(outcome.blocking).toEqual([])
    expect(outcome.warnings).toHaveLength(1)
    expect(rules.takeToolReminder('c1')).toContain('<system-reminder')
  })

  it('blocks the same rule again on a later call, because a block is not a delivery', () => {
    const rules = session([rule('a', '---\ncondition: forbidden\nscope: tool\n---\nbody')])
    const context = { source: 'tool' as const, tool: 'write', callId: 'c1', paths: ['a.ts'] }

    expect(rules.toolViolations('forbidden', context).blocking).toHaveLength(1)
    expect(rules.toolViolations('forbidden', { ...context, callId: 'c2' }).blocking).toHaveLength(1)
  })

  it('does not deliver the same reminder twice under repeatMode once', () => {
    const rules = session([rule('a', '---\ncondition: forbidden\nscope: tool\ninterruptMode: never\n---\nbody')])
    const context = { source: 'tool' as const, tool: 'write', paths: ['a.ts'] }

    expect(rules.toolViolations('forbidden', { ...context, callId: 'c1' }).warnings).toHaveLength(1)
    expect(rules.toolViolations('forbidden', { ...context, callId: 'c2' }).warnings).toEqual([])
  })

  it('reports an ast-grep violation only when a path yields a grammar', () => {
    const rules = session([rule('a', '---\nastCondition: "return $X"\n---\nbody')])

    expect(rules.toolViolations('function f(){ return 1 }', { source: 'tool', tool: 'write', paths: ['a.ts'] }).blocking).toHaveLength(1)
    expect(rules.toolViolations('function f(){ return 1 }', { source: 'tool', tool: 'write', paths: ['a.unknown'] }).blocking).toEqual([])
  })

  it('keeps blocking after the rule was warned about once', () => {
    const rules = session([rule('a', '---\ncondition: forbidden\nscope: tool\n---\nbody')])
    const context = { source: 'tool' as const, tool: 'write', paths: ['a.ts'] }

    expect(rules.toolViolations('forbidden', context).blocking).toHaveLength(1)
    expect(rules.toolViolations('forbidden', context).blocking).toHaveLength(1)
  })

  it('returns nothing when no tool rule matches', () => {
    const rules = session([rule('a', '---\ncondition: forbidden\n---\nbody')])
    expect(rules.toolViolations('clean content', { source: 'tool', tool: 'write' }).blocking).toEqual([])
  })
})

describe('judged', () => {
  it('selects question rules admitted by their prefilter', () => {
    const rules = session([rule('a', '---\nquestion: claimed success?\ncondition: claimed\nscope: text\n---\nbody')])
    expect(rules.judged('it claimed success', { source: 'text' })).toHaveLength(1)
    expect(rules.judged('unrelated prose', { source: 'text' })).toEqual([])
  })

  it('delivers warnings as non-waking context', () => {
    const { agent, inject, steer } = fakeAgent()
    const rules = session([rule('a', '---\nquestion: q\n---\nbody')])

    rules.deliverWarnings(agent, [rules.rules[0] as Rule])
    expect(inject).toHaveBeenCalledTimes(1)
    expect(steer).not.toHaveBeenCalled()
    expect(String(inject.mock.calls[0]?.[0]?.content?.[0]?.text)).toContain('<system-reminder')
  })

  it('delivers nothing for an empty verdict', () => {
    const { agent, inject } = fakeAgent()
    session([]).deliverWarnings(agent, [])
    expect(inject).not.toHaveBeenCalled()
  })
})

describe('snapshot', () => {
  it('exposes rulebook, always-apply, and TTSR rules by name', () => {
    const rules = session([rule('book', '---\ndescription: d\n---\nbody'), rule('guard', '---\ncondition: forbidden\n---\nbody')])
    expect([...rules.snapshot.rules.keys()].sort()).toEqual(['book', 'guard'])
  })
})

describe('toolSnapshot', () => {
  it('reconstructs the source a write would produce', () => {
    expect(toolSnapshot('write', { file_path: 'a.ts', content: 'const a = 1' })).toBe('const a = 1')
  })

  it('reconstructs the replacement an edit would produce', () => {
    expect(toolSnapshot('edit', { file_path: 'a.ts', old_string: 'x', new_string: 'const a = 1' })).toBe('const a = 1')
  })

  it('joins the replacements of a multi-edit call', () => {
    const snapshot = toolSnapshot('multi_edit', { edits: [{ new_string: 'one' }, { new_string: 'two' }] })
    expect(snapshot).toBe('one\ntwo')
  })

  it('falls back to the whole arguments for a tool with no source field', () => {
    expect(toolSnapshot('bash', { command: 'ls' })).toContain('ls')
  })
})

describe('toolPaths', () => {
  it('collects the path fields a tool call carries', () => {
    expect(toolPaths({ file_path: 'a.ts', paths: ['b.ts', 'c.ts'] })).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('returns nothing for a pathless call', () => {
    expect(toolPaths({ command: 'ls' })).toEqual([])
  })
})
