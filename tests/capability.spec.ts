import { describe, expect, it } from 'vitest'
import { bucketRules, agentMatches, hasTrigger } from '../src/buckets.ts'
import { loadCapability } from '../src/capability.ts'
import type { ProviderResult } from '../src/discovery.ts'
import type { Rule } from '../src/rule.ts'

function rule(name: string, overrides: Partial<Rule> = {}, provider = 'native'): Rule {
  return { name, path: `/tmp/${name}.md`, content: 'body', _source: { provider, path: `/tmp/${name}.md`, priority: 1 }, ...overrides }
}

function providerResult(provider: string, rules: Rule[]): ProviderResult {
  return { provider, rules, warnings: [] }
}

describe('loadCapability', () => {
  it('keeps the first rule claiming a name and shadows the rest', () => {
    const winner = rule('shared')
    const loser = rule('shared', {}, 'cursor')
    const result = loadCapability([providerResult('native', [winner]), providerResult('cursor', [loser])])

    expect(result.items).toEqual([winner])
    expect(result.all).toHaveLength(2)
    expect(loser._shadowed).toBe(true)
    expect(winner._shadowed).toBeUndefined()
  })

  it('keeps distinct names in provider order', () => {
    const result = loadCapability([providerResult('native', [rule('a')]), providerResult('cursor', [rule('b')])])
    expect(result.items.map(item => item.name)).toEqual(['a', 'b'])
  })

  it('collects provider warnings', () => {
    const result = loadCapability([{ provider: 'github', rules: [], warnings: ['w'] }])
    expect(result.warnings).toEqual(['w'])
  })

  it('re-decides shadowing per pass instead of reading a stale flag', () => {
    const winner = rule('shared')
    const loser = rule('shared', {}, 'cursor')
    const first = loadCapability([providerResult('native', [winner]), providerResult('cursor', [loser])])
    expect(first.items).toEqual([winner])

    // The same objects, priorities reversed: the loser wins this time, and the
    // flag the previous pass wrote on it must not decide otherwise.
    const second = loadCapability([providerResult('cursor', [loser]), providerResult('native', [winner])])
    expect(second.items).toEqual([loser])
  })

  it('recovers a rule that a previous pass had shadowed', () => {
    const winner = rule('shared')
    const loser = rule('shared', {}, 'cursor')
    loadCapability([providerResult('native', [winner]), providerResult('cursor', [loser])])

    const alone = loadCapability([providerResult('cursor', [loser])])
    expect(alone.items).toEqual([loser])
    expect(loser._shadowed).toBeUndefined()
  })
})

describe('hasTrigger', () => {
  it('detects each trigger family', () => {
    expect(hasTrigger(rule('a', { condition: ['x'] }))).toBe(true)
    expect(hasTrigger(rule('a', { astCondition: ['x'] }))).toBe(true)
    expect(hasTrigger(rule('a', { question: 'q' }))).toBe(true)
    expect(hasTrigger(rule('a'))).toBe(false)
    expect(hasTrigger(rule('a', { condition: [] }))).toBe(false)
  })
})

describe('agentMatches', () => {
  it('admits every agent when no filter is declared', () => {
    expect(agentMatches(rule('a'), 'main')).toBe(true)
    expect(agentMatches(rule('a', { agents: [] }), 'main')).toBe(true)
  })

  it('matches the literal sentinels', () => {
    expect(agentMatches(rule('a', { agents: ['main'] }), 'main')).toBe(true)
    expect(agentMatches(rule('a', { agents: ['main'] }), 'sub')).toBe(false)
  })

  it('matches a glob against the agent name', () => {
    expect(agentMatches(rule('a', { agents: ['foreman-*'] }), 'foreman-a')).toBe(true)
    expect(agentMatches(rule('a', { agents: ['{scout,reviewer}'] }), 'reviewer')).toBe(true)
  })
})

describe('bucketRules', () => {
  const options = {
    builtinRules: true,
    disabledRules: [] as string[],
    agentName: 'main',
    registerTtsr: () => true,
  }

  it('routes a described rule to the rulebook', () => {
    const buckets = bucketRules([rule('a', { description: 'd' })], options)
    expect(buckets.rulebookRules.map(item => item.name)).toEqual(['a'])
  })

  it('routes an always-apply rule ahead of the rulebook', () => {
    const buckets = bucketRules([rule('a', { description: 'd', alwaysApply: true })], options)
    expect(buckets.alwaysApplyRules.map(item => item.name)).toEqual(['a'])
    expect(buckets.rulebookRules).toEqual([])
  })

  it('gives an accepted TTSR rule priority over every other bucket', () => {
    const buckets = bucketRules([rule('a', { description: 'd', alwaysApply: true, condition: ['x'] })], options)
    expect(buckets.ttsrRules.map(item => item.name)).toEqual(['a'])
    expect(buckets.alwaysApplyRules).toEqual([])
    expect(buckets.rulebookRules).toEqual([])
  })

  it('falls back to always-apply when the manager refuses the TTSR registration', () => {
    const buckets = bucketRules([rule('a', { alwaysApply: true, condition: ['x'] })], { ...options, registerTtsr: () => false })
    expect(buckets.alwaysApplyRules.map(item => item.name)).toEqual(['a'])
  })

  it('drops disabled rules from every bucket', () => {
    const buckets = bucketRules([rule('a', { description: 'd' })], { ...options, disabledRules: ['a'] })
    expect(buckets.dropped.map(item => item.name)).toEqual(['a'])
    expect(buckets.rulebookRules).toEqual([])
  })

  it('drops builtin rules when they are disabled', () => {
    const buckets = bucketRules([rule('a', { description: 'd' }, 'builtin-defaults')], { ...options, builtinRules: false })
    expect(buckets.dropped.map(item => item.name)).toEqual(['a'])
  })

  it('drops a rule whose agent filter does not match', () => {
    const buckets = bucketRules([rule('a', { description: 'd', agents: ['scout'] })], options)
    expect(buckets.dropped.map(item => item.name)).toEqual(['a'])
  })

  it('drops a rule with neither trigger, always-apply, nor description', () => {
    const buckets = bucketRules([rule('a')], options)
    expect(buckets.dropped.map(item => item.name)).toEqual(['a'])
  })
})
