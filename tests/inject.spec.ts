import { describe, expect, it } from 'vitest'
import { dedupeViolations, renderInterrupt, renderReminder } from '../src/inject.ts'
import { buildRuleFromMarkdown, type Rule } from '../src/rule.ts'
import { parseVerdicts } from '../src/judge.ts'

function rule(name: string, body: string): Rule {
  return buildRuleFromMarkdown({
    name,
    path: `/tmp/${name}.md`,
    content: `---\ndescription: d\n---\n${body}\n`,
    source: { provider: 'native', path: `/tmp/${name}.md`, priority: 1 },
  })
}

describe('renderInterrupt', () => {
  it('carries the rule body and its attributes', () => {
    const text = renderInterrupt([{ rule: rule('a', 'do not do this'), path: 'src/x.ts' }])
    expect(text).toBe(
      '<system-interrupt reason="rule_violation" rule="a" path="src/x.ts">\ndo not do this\n</system-interrupt>',
    )
  })

  it('renders an empty path attribute when none is known', () => {
    expect(renderInterrupt([{ rule: rule('a', 'b') }])).toContain('path=""')
  })

  it('separates multiple rules with a blank line', () => {
    const text = renderInterrupt([{ rule: rule('a', 'first') }, { rule: rule('b', 'second') }])
    expect(text.split('\n\n')).toHaveLength(2)
  })
})

describe('renderReminder', () => {
  it('uses the reminder frame', () => {
    expect(renderReminder([{ rule: rule('a', 'body') }])).toContain('<system-reminder reason="rule_violation" rule="a"')
  })
})

describe('dedupeViolations', () => {
  it('keeps the first occurrence of a repeated rule name', () => {
    const first = rule('a', 'first')
    const second = rule('a', 'second')
    const unique = dedupeViolations([{ rule: first }, { rule: rule('b', 'other') }, { rule: second }])
    expect(unique).toHaveLength(2)
    expect(unique[0]?.rule.content).toContain('first')
  })
})

describe('parseVerdicts', () => {
  it('collects the numbers answered YES', () => {
    expect(parseVerdicts('1: YES\n2: NO\n3: YES', 3)).toEqual([1, 3])
  })

  it('is case-insensitive and tolerates spacing', () => {
    expect(parseVerdicts('  2 :  yes ', 2)).toEqual([2])
  })

  it('ignores prose and out-of-range numbers', () => {
    expect(parseVerdicts('Sure!\n1: YES\n99: YES', 2)).toEqual([1])
  })

  it('returns nothing for an unparseable answer', () => {
    expect(parseVerdicts('the model rambled', 1)).toEqual([])
  })
})
