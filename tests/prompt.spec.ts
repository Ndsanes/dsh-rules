import { describe, expect, it } from 'vitest'
import { buildRuleFromMarkdown, type Rule } from '../src/rule.ts'
import { dedupeDuplicateBodies, renderAlwaysApply, renderRulebook } from '../src/prompt.ts'

const SOURCE = { provider: 'native', path: '/tmp/x.md', priority: 100 }

function rule(content: string): Rule {
  return buildRuleFromMarkdown({ name: 'my-rule', path: '/tmp/x.md', content, source: SOURCE })
}

describe('renderAlwaysApply', () => {
  it('renders each body inside a generic-rules block', () => {
    const text = renderAlwaysApply([rule('---\nalwaysApply: true\n---\nbody text\n')])
    expect(text).toContain('<generic-rules>')
    expect(text).toContain('<rule name="my-rule">')
    expect(text).toContain('body text')
  })

  it('renders nothing when the layer is empty', () => {
    expect(renderAlwaysApply([])).toBe('')
  })

  it('escapes a name that would break the attribute', () => {
    const text = renderAlwaysApply([rule('---\nalwaysApply: true\n---\nb\n')])
    expect(text).toContain('name="my-rule"')
  })
})

describe('renderRulebook', () => {
  it('renders name, globs, and description as one line per rule', () => {
    const text = renderRulebook([rule('---\ndescription: guard the seam\nglobs: "**/*.ts"\n---\nbody\n')])
    expect(text).toContain('- my-rule (**/*.ts): guard the seam')
  })

  it('omits the glob segment when the rule declares none', () => {
    const text = renderRulebook([rule('---\ndescription: plain\n---\nbody\n')])
    expect(text).toContain('- my-rule: plain')
  })

  it('tells the model how to load the body', () => {
    const text = renderRulebook([rule('---\ndescription: plain\n---\n')])
    expect(text).toContain('rule://<name>')
    expect(text).toContain('`rule` tool')
    expect(text).toContain('<domain-rules>')
  })

  it('renders nothing when the layer is empty', () => {
    expect(renderRulebook([])).toBe('')
  })
})

describe('dedupeDuplicateBodies', () => {
  it('drops a rule whose body an earlier rule already carries', () => {
    const first = rule('---\nalwaysApply: true\n---\nshared body\n')
    const second = { ...rule('---\nalwaysApply: true\n---\nshared body\n'), name: 'other' }
    expect(dedupeDuplicateBodies([first, second])).toEqual([first])
  })

  it('keeps distinct bodies', () => {
    const first = rule('---\nalwaysApply: true\n---\nbody one\n')
    const second = rule('---\nalwaysApply: true\n---\nbody two\n')
    expect(dedupeDuplicateBodies([first, second])).toHaveLength(2)
  })

  it('ignores surrounding whitespace when comparing bodies', () => {
    const first = rule('---\nalwaysApply: true\n---\nshared body\n')
    const second = { ...rule('---\nalwaysApply: true\n---\nshared body\n\n'), name: 'other' }
    expect(dedupeDuplicateBodies([first, second])).toEqual([first])
  })

  it('keeps a rule whose body is empty', () => {
    const subject = rule('---\nalwaysApply: true\n---\n\n')
    expect(dedupeDuplicateBodies([subject, { ...subject, name: 'other' }])).toHaveLength(2)
  })
})
