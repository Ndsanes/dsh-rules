import { describe, expect, it } from 'vitest'
import { buildRuleFromMarkdown, looksLikeGlob, parseAgents, parseScope, parseScopeWithUnknown, splitInlineFlags, withModeOverrides } from '../src/rule.ts'

const SOURCE = { provider: 'native', path: '/tmp/x.md', priority: 100 }

function build(content: string) {
  return buildRuleFromMarkdown({ name: 'x', path: '/tmp/x.md', content, source: SOURCE })
}

describe('buildRuleFromMarkdown', () => {
  it('strips frontmatter and keeps the body', () => {
    const rule = build('---\ndescription: d\n---\nthe body\n')
    expect(rule.content).toBe('the body')
    expect(rule.description).toBe('d')
  })

  it('loads a file without frontmatter with empty metadata', () => {
    const rule = build('plain body')
    expect(rule.description).toBeUndefined()
    expect(rule.content).toBe('plain body')
  })

  it('reads the trigger fields', () => {
    const rule = build('---\ncondition: ["a", "b"]\nastCondition: ["return $X"]\nquestion: did it?\n---\n')
    expect(rule.condition).toEqual(['a', 'b'])
    expect(rule.astCondition).toEqual(['return $X'])
    expect(rule.question).toBe('did it?')
  })

  it('accepts the legacy ttsr trigger spellings', () => {
    expect(build('---\nttsr_trigger: legacy\n---\n').condition).toEqual(['legacy'])
    expect(build('---\nttsrTrigger: legacy\n---\n').condition).toEqual(['legacy'])
  })

  it('applies overrides after parsing', () => {
    const rule = buildRuleFromMarkdown({
      name: 'RULES',
      path: '/tmp/RULES.md',
      content: 'body',
      source: SOURCE,
      overrides: { name: 'RULES', alwaysApply: true },
    })
    expect(rule.name).toBe('RULES')
    expect(rule.alwaysApply).toBe(true)
  })

  it('ignores an unknown interrupt mode', () => {
    expect(build('---\ninterruptMode: sometimes\n---\n').interruptMode).toBeUndefined()
  })

  it('rewrites a glob-shaped condition into edit and write scope entries', () => {
    const rule = build('---\ncondition: "**/*.surql"\n---\n')
    expect(rule.condition).toEqual(['.*'])
    expect(rule.scope).toEqual([
      { surface: 'tool', tool: 'edit', glob: '**/*.surql' },
      { surface: 'tool', tool: 'write', glob: '**/*.surql' },
    ])
  })

  it('keeps declared scope when expanding a glob condition', () => {
    const rule = build('---\nscope: text\ncondition: "src/**"\n---\n')
    expect(rule.scope).toEqual([
      { surface: 'text' },
      { surface: 'tool', tool: 'edit', glob: 'src/**' },
      { surface: 'tool', tool: 'write', glob: 'src/**' },
    ])
  })

  it('does not rewrite an astCondition token that looks like a glob', () => {
    const rule = build('---\nastCondition: "$A.$B"\n---\n')
    expect(rule.astCondition).toEqual(['$A.$B'])
    expect(rule.scope).toBeUndefined()
  })

  it('keeps a character-class condition as a regex beside its declared scope', () => {
    const rule = build('---\ncondition:\n  - "[<>]=?\\\\s*time::now\\\\(\\\\)"\n  - "NONE\\\\s*[<>]"\nscope: "tool:edit(*.surql), tool:write(*.surql)"\n---\n')
    expect(rule.condition).toEqual(['[<>]=?\\s*time::now\\(\\)', 'NONE\\s*[<>]'])
    expect(rule.scope).toEqual([
      { surface: 'tool', tool: 'edit', glob: '*.surql' },
      { surface: 'tool', tool: 'write', glob: '*.surql' },
    ])
  })

  it('ignores an unrelated frontmatter key', () => {
    expect(build('---\nbacking: tools/modu/services/rules-layer.test.ts\n---\n').description).toBeUndefined()
  })

  it('keeps every glob of a multi-token glob condition', () => {
    const rule = build('---\ncondition: "src/**, lib/**"\n---\n')
    expect(rule.scope).toEqual([
      { surface: 'tool', tool: 'edit', glob: 'src/**' },
      { surface: 'tool', tool: 'write', glob: 'src/**' },
      { surface: 'tool', tool: 'edit', glob: 'lib/**' },
      { surface: 'tool', tool: 'write', glob: 'lib/**' },
    ])
  })

  it('keeps declared scope and every glob of a multi-token glob condition', () => {
    const rule = build('---\nscope: text\ncondition: "src/**, lib/**"\n---\n')
    expect(rule.scope).toEqual([
      { surface: 'text' },
      { surface: 'tool', tool: 'edit', glob: 'src/**' },
      { surface: 'tool', tool: 'write', glob: 'src/**' },
      { surface: 'tool', tool: 'edit', glob: 'lib/**' },
      { surface: 'tool', tool: 'write', glob: 'lib/**' },
    ])
  })

  it('leaves a regex that merely contains a wildcard or a slash alone', () => {
    for (const token of ['colou?r', 'foo.*bar', '.*', 'api/v1', 'def .* class']) {
      const rule = build(`---\ncondition: "${token}"\n---\n`)
      expect(rule.condition).toEqual([token])
      expect(rule.scope).toBeUndefined()
    }
  })

  it('leaves an import path condition alone instead of matching everything', () => {
    const rule = build('---\ncondition: \'"io/ioutil"\'\n---\n')
    expect(rule.condition).toEqual(['io/ioutil'])
    expect(rule.scope).toBeUndefined()
  })

  it('still reads a real path glob as a glob', () => {
    expect(build('---\ncondition: "Database/**"\n---\n').scope).toEqual([
      { surface: 'tool', tool: 'edit', glob: 'Database/**' },
      { surface: 'tool', tool: 'write', glob: 'Database/**' },
    ])
  })

  it('warns when a condition was rewritten into a path glob', () => {
    const rule = build('---\ncondition: "src/**"\n---\n')
    expect(rule._warnings?.join('\n')).toContain('condition: src/** read as a path glob')
  })

  it('accepts an interrupt mode whatever its case or padding', () => {
    expect(build('---\ninterruptMode: Never\n---\n').interruptMode).toBe('never')
    expect(build('---\ninterruptMode: "  Tool-Only "\n---\n').interruptMode).toBe('tool-only')
  })

  it('warns about an interrupt mode it cannot read', () => {
    const rule = build('---\ninterruptMode: sometimes\n---\n')
    expect(rule.interruptMode).toBeUndefined()
    expect(rule._warnings?.join('\n')).toContain('interruptMode: sometimes')
  })

  it('reads alwaysApply written as text', () => {
    expect(build('---\nalwaysApply: "true"\n---\n').alwaysApply).toBe(true)
    expect(build('---\nalwaysApply: "False"\n---\n').alwaysApply).toBe(false)
    expect(build('---\nalwaysApply: yes\n---\n').alwaysApply).toBeUndefined()
    expect(build('---\nalwaysApply: yes\n---\n')._warnings?.join('\n')).toContain('alwaysApply: yes')
  })

  it('keeps the scope it recognized and names the token it dropped', () => {
    const rule = build('---\nscope: "tool:edit(*.ts), typo"\n---\n')
    expect(rule.scope).toEqual([{ surface: 'tool', tool: 'edit', glob: '*.ts' }])
    expect(rule._warnings?.join('\n')).toContain('scope: typo is not a surface')
  })

  it('reports every unknown scope token', () => {
    expect(parseScopeWithUnknown('text, typo, nonsense').unknown).toEqual(['typo', 'nonsense'])
  })

  it('reports a scope it recognized nothing in at all', () => {
    expect(parseScopeWithUnknown('code').unknown).toEqual(['code'])
  })

  it('recovers the whole glob list of a rule whose YAML block did not parse', () => {
    const rule = build('---\ndescription: "bad \\d here"\nglobs: [src/**,\n       lib/**]\ncondition: \'"io/ioutil"\'\n---\n\nbody\n')
    expect(rule.globs).toEqual(['src/**', 'lib/**'])
    expect(rule.condition).toEqual(['io/ioutil'])
  })

  it('drops the quotes a recovered description keeps', () => {
    expect(build('---\ndescription: "bad \\d here"\n---\n').description).toBe('bad \\d here')
    expect(build('---\nquestion: "did it \\d work"\n---\n').question).toBe('did it \\d work')
  })

  it('keeps an apostrophe that only closes a description', () => {
    // The `\d` is what forces the line-wise recovery path the raw quotes come from.
    expect(build('---\ndescription: "the authors\' pick, \\d here"\n---\n').description).toBe("the authors' pick, \\d here")
  })

  it('warns when astCondition cannot fire on the files the rule gates on', () => {
    const rule = build('---\nscope: "tool:edit(*.go)"\nastCondition:\n  - "for $I := 0; $I < $N; $I++ { $$$BODY }"\n---\n')
    expect(rule.astCondition).toEqual(['for $I := 0; $I < $N; $I++ { $$$BODY }'])
    expect(rule._warnings?.join('\n')).toContain('no bundled ast-grep grammar')
  })

  it('says nothing about an astCondition a bundled grammar can check', () => {
    const rule = build('---\nscope: "tool:edit(*.ts)"\nastCondition:\n  - "return $X"\n---\n')
    expect(rule._warnings).toBeUndefined()
  })
})

describe('parseScope', () => {
  it('accepts a comma-separated string', () => {
    expect(parseScope('text, thinking')).toEqual([{ surface: 'text' }, { surface: 'thinking' }])
  })

  it('accepts a YAML sequence', () => {
    expect(parseScope(['text', 'toolcall'])).toEqual([{ surface: 'text' }, { surface: 'tool' }])
  })

  it('tolerates the degraded fallback spelling', () => {
    expect(parseScope('"text","thinking"')).toEqual([{ surface: 'text' }, { surface: 'thinking' }])
  })

  it('parses a named tool with a path glob', () => {
    expect(parseScope('tool:edit(*.ts)')).toEqual([{ surface: 'tool', tool: 'edit', glob: '*.ts' }])
  })

  it('parses a named tool without a glob', () => {
    expect(parseScope('tool:edit(*)')).toEqual([{ surface: 'tool', tool: 'edit', glob: '*' }])
  })

  it('drops unknown tokens', () => {
    expect(parseScope('nonsense')).toBeUndefined()
  })

  it('keeps the tokens it did recognize beside one it dropped', () => {
    expect(parseScope('tool:edit(*.ts), typo')).toEqual([{ surface: 'tool', tool: 'edit', glob: '*.ts' }])
  })
})

describe('parseAgents', () => {
  it('lowercases and normalizes brace whitespace', () => {
    expect(parseAgents('{Scout, REVIEWER}')).toEqual(['{scout,reviewer}'])
  })

  it('accepts a bare string', () => {
    expect(parseAgents('main')).toEqual(['main'])
  })

  it('returns undefined for an empty filter', () => {
    expect(parseAgents([])).toBeUndefined()
  })
})

describe('splitInlineFlags', () => {
  it('moves a leading flag group into flags', () => {
    expect(splitInlineFlags('(?i)abc')).toEqual({ source: 'abc', flags: 'i' })
  })

  it('drops unsupported flags', () => {
    expect(splitInlineFlags('(?u)abc')).toEqual({ source: 'abc', flags: '' })
  })

  it('leaves an unflagged pattern alone', () => {
    expect(splitInlineFlags('abc')).toEqual({ source: 'abc', flags: '' })
  })
})

describe('looksLikeGlob', () => {
  it('recognizes wildcard and path shapes', () => {
    expect(looksLikeGlob('**/*.ts')).toBe(true)
    expect(looksLikeGlob('src/')).toBe(true)
    expect(looksLikeGlob('Database/**')).toBe(true)
    expect(looksLikeGlob('*.ts')).toBe(true)
    expect(looksLikeGlob('src/**')).toBe(true)
  })

  it('rejects anchored and inline-flag regexes', () => {
    expect(looksLikeGlob('^abc$')).toBe(false)
    expect(looksLikeGlob('(?i)abc')).toBe(false)
  })

  it('rejects a regex that only carries a wildcard or a slash', () => {
    expect(looksLikeGlob('colou?r')).toBe(false)
    expect(looksLikeGlob('foo.*bar')).toBe(false)
    expect(looksLikeGlob('.*')).toBe(false)
    expect(looksLikeGlob('def .* class')).toBe(false)
    expect(looksLikeGlob('api/v1')).toBe(false)
    expect(looksLikeGlob('io/ioutil')).toBe(false)
  })
})

describe('withModeOverrides', () => {
  it('gives a named rule the override as its mode', () => {
    const [applied] = withModeOverrides([{ name: 'ts-set-map' }], { 'ts-set-map': 'never' })
    expect(applied?.interruptMode).toBe('never')
  })

  it('copies the rule instead of mutating it', () => {
    // The 27 rules that ship with the plugin are module-level constants shared
    // by every session; writing to one would leak an override into a session
    // that never asked for it.
    const original = { name: 'ts-set-map' }
    withModeOverrides([original], { 'ts-set-map': 'never' })
    expect(original.interruptMode).toBeUndefined()
  })

  it('leaves every other rule exactly as discovery produced it', () => {
    const other = { name: 'other', interruptMode: 'always' as const }
    const [same] = withModeOverrides([other], { 'ts-set-map': 'never' })
    expect(same).toBe(other)
  })

  it('returns the rules untouched when nothing is overridden', () => {
    const rules = [{ name: 'a' }, { name: 'b' }]
    expect(withModeOverrides(rules, {})).toEqual(rules)
  })
})
