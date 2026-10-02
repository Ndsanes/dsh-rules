import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseFrontmatter } from '../src/frontmatter.ts'
// @ts-ignore the browser half is plain JS and ships no bundled .d.ts yet
import * as frontmatter from '../src/client/frontmatter.js'

/** One field the editor renders as a labelled control. */
interface FieldSpec {
  key: string
  kind: 'text' | 'lines' | 'bool'
  label: string
  help: string
  options?: string[]
  aliases?: string[]
  deprecated?: string
}

/** What the form holds: one value per known field, in the order the file used. */
type Fields = Record<string, string | boolean | string[]>

/** The module's own contract, spelled out here so the tests stay typed. */
interface FrontmatterApi {
  FIELD_SPECS: FieldSpec[]
  parseRuleFile(
    text: string,
  ):
    | { ok: true; fields: Fields; body: string; frontmatterLines: string[]; unknownKeys: string[] }
    | { ok: false; reason: string }
  serialiseRuleFile(fields: Fields, body: string, frontmatterLines?: string[]): string
  hasFields(text: string): boolean
}

const { FIELD_SPECS, parseRuleFile, serialiseRuleFile, hasFields } = frontmatter as unknown as FrontmatterApi

/** A value for one field kind, chosen to exercise quoting and typing. */
const SAMPLE: Record<FieldSpec['kind'], string | boolean | string[]> = {
  text: 'Use for: b.Loop() in benchmarks (Go 1.24)',
  bool: true,
  lines: ['tool:edit(*.go)', 'has # hash', 'a \\d+ pattern', '@mention'],
}

/** Assert a document parsed, and hand back its fields and body. */
function parsed(text: string): { fields: Fields; body: string } {
  const result = parseRuleFile(text)
  if (!result.ok) throw new Error(`expected the file to parse, but it was refused: ${result.reason}`)
  return { fields: result.fields, body: result.body }
}

/** Assert a document parsed, and hand back everything the editor would hold. */
function opened(text: string): { fields: Fields; body: string; frontmatterLines: string[]; unknownKeys: string[] } {
  const result = parseRuleFile(text)
  if (!result.ok) throw new Error(`expected the file to parse, but it was refused: ${result.reason}`)
  return { fields: result.fields, body: result.body, frontmatterLines: result.frontmatterLines, unknownKeys: result.unknownKeys }
}

/** Parse, edit the form the way the editor would, and write the file back. */
function edit(text: string, changes: Fields): string {
  const open = opened(text)
  return serialiseRuleFile({ ...open.fields, ...changes }, open.body, open.frontmatterLines)
}

/** Assert a document was refused, and hand back the reason. */
function refused(text: string): string {
  const result = parseRuleFile(text)
  if (result.ok) throw new Error(`expected a refusal, but it parsed as ${JSON.stringify(result.fields)}`)
  return result.reason
}

/** Build a document from raw block lines and a body. */
function file(block: string, body = 'rule text\n'): string {
  return `---\n${block}\n---\n${body}`
}


describe('parseFrontmatter', () => {
  it('splits a well-formed block from the body', () => {
    const parsed = parseFrontmatter('---\ndescription: hello\n---\nbody text\n')
    expect(parsed.data).toEqual({ description: 'hello' })
    expect(parsed.body).toBe('body text')
    expect(parsed.warnings).toEqual([])
  })

  it('treats a document without a closing delimiter as all body', () => {
    const parsed = parseFrontmatter('---\ndescription: hello\nbody text')
    expect(parsed.data).toEqual({})
    expect(parsed.body).toBe('---\ndescription: hello\nbody text')
  })

  it('normalizes hyphenated keys to camelCase', () => {
    const parsed = parseFrontmatter('---\nalways-apply: true\n---\n')
    expect(parsed.data).toEqual({ alwaysApply: true })
  })

  it('keeps an unterminated document empty but body intact', () => {
    expect(parseFrontmatter('no frontmatter here').body).toBe('no frontmatter here')
  })

  it('recovers line-wise when the YAML block is malformed', () => {
    const parsed = parseFrontmatter('---\ndescription: ok\n  bad: [unclosed\nscope: "text","thinking"\n---\nbody')
    expect(parsed.data.description).toBe('ok')
    expect(parsed.warnings.length).toBeGreaterThan(0)
  })

  it('keeps a malformed value as its raw trimmed string', () => {
    const parsed = parseFrontmatter('---\nalwaysApply: yes\n---\n')
    expect(typeof parsed.data.alwaysApply).toBe('string')
  })

  it('ignores a frontmatter block that is not a mapping', () => {
    const parsed = parseFrontmatter('---\n- one\n- two\n---\nbody')
    expect(parsed.data).toEqual({})
    expect(parsed.warnings).toContain('frontmatter is not a mapping; ignored')
  })

  it('parses block-style sequences', () => {
    const parsed = parseFrontmatter('---\nscope:\n  - text\n  - thinking\n---\n')
    expect(parsed.data.scope).toEqual(['text', 'thinking'])
  })

  it('rejoins a flow sequence that spans several lines', () => {
    const parsed = parseFrontmatter('---\nglobs: [src/**,\n       lib/**]\n---\n')
    expect(parsed.data.globs).toEqual(['src/**', 'lib/**'])
  })

  it('rejoins a multi-line flow sequence while recovering from a bad value', () => {
    const parsed = parseFrontmatter('---\ndescription: "bad \\d here"\nglobs: [src/**,\n       lib/**]\n---\nbody')
    expect(parsed.data.globs).toEqual(['src/**', 'lib/**'])
    expect(parsed.data.description).toBe('"bad \\d here"')
    expect(parsed.warnings.length).toBeGreaterThan(0)
  })

  it('stops a continuation at the next key line', () => {
    const parsed = parseFrontmatter('---\nglobs: [src/**,\nscope: text\nagents: main\n---\nbody')
    expect(parsed.data.scope).toBe('text')
    expect(parsed.data.agents).toBe('main')
    expect(parsed.warnings.join('\n')).toContain('never closes its brackets')
  })

  it('does not read a bracketed character class as an open collection', () => {
    const parsed = parseFrontmatter('---\ncondition: "[<>]=?\\s*time"\nscope: text\n---\nbody')
    expect(parsed.data.condition).toBe('"[<>]=?\\s*time"')
    expect(parsed.data.scope).toBe('text')
  })
})

describe('rule-file frontmatter for the editor form', () => {
  describe('FIELD_SPECS', () => {
    it('describes exactly the frontmatter fields src/rule.ts reads', () => {
      expect(FIELD_SPECS.map(spec => spec.key)).toEqual([
        'description',
        'alwaysApply',
        'globs',
        'condition',
        'astCondition',
        'question',
        'agents',
        'scope',
        'interruptMode',
        'ttsr_trigger',
        'ttsrTrigger',
      ])
    })

    it('gives every field a unique key, a label and one plain sentence of help', () => {
      for (const spec of FIELD_SPECS) {
        expect(spec.key, 'field name').toMatch(/^\w+$/)
        expect(['text', 'lines', 'bool'], `kind of ${spec.key}`).toContain(spec.kind)
        expect(spec.label.trim(), `label of ${spec.key}`).not.toBe('')
        expect(spec.help.trim(), `help of ${spec.key}`).toMatch(/^[A-Za-z].*[.!?]$/)
        expect(spec.help.length, `help of ${spec.key} has to explain itself`).toBeGreaterThan(40)
        expect(spec.help, `help of ${spec.key} must not leak source symbols`).not.toMatch(/data\.|rule\.ts|_source|Rule\b/)
      }
      expect(new Set(FIELD_SPECS.map(spec => spec.key)).size).toBe(FIELD_SPECS.length)
    })

    it('offers the four interrupt modes as a closed set of choices', () => {
      const mode = FIELD_SPECS.find(spec => spec.key === 'interruptMode')
      expect(mode?.options).toEqual(['never', 'prose-only', 'tool-only', 'always'])
      expect(mode?.help).toContain('never')
      expect(mode?.help).toContain('always')
    })

    it('gives every field kind at least one control, and alwaysApply the only switch', () => {
      const kinds = FIELD_SPECS.map(spec => spec.kind)
      expect(FIELD_SPECS.filter(spec => spec.kind === 'bool').map(spec => spec.key)).toEqual(['alwaysApply'])
      expect(FIELD_SPECS.filter(spec => spec.kind === 'lines').map(spec => spec.key)).toEqual([
        'globs',
        'condition',
        'astCondition',
        'agents',
        'scope',
        'ttsr_trigger',
        'ttsrTrigger',
      ])
      expect(FIELD_SPECS.filter(spec => spec.kind === 'text').map(spec => spec.key)).toEqual([
        'description',
        'question',
        'interruptMode',
      ])
      expect(new Set(kinds).size).toBe(3)
    })
  })

  describe('parseRuleFile refusals', () => {
    it('refuses a file with no frontmatter block', () => {
      expect(refused('Just a rule, no metadata.\n')).toMatch(/no frontmatter block/)
      expect(refused('')).toMatch(/no frontmatter block/)
      expect(refused('\n---\ndescription: x\n---\n')).toMatch(/no frontmatter block/)
    })

    it('refuses a block that is never closed', () => {
      expect(refused('---\ndescription: hello\nbody text')).toMatch(/never closed/)
      expect(refused('---\ndescription: hello\n')).toMatch(/never closed/)
    })

    it('no longer refuses an unknown key: a file only the author reads still opens the form', () => {
      const result = parseRuleFile(file('description: fine\nbacking: some note\ncondition:\n  - x'))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.fields).toEqual({ description: 'fine', condition: ['x'] })
      expect(result.unknownKeys).toEqual(['backing'])
    })

    it('refuses a nested mapping under an unknown key only when a known field carries it', () => {
      // The unknown key's indented lines are copied back untouched, so they
      // cannot be the thing that goes wrong; a known field's still can.
      expect(refused(file('backing:\n  owner: someone\nscope:\n  surface: text'))).toMatch(/nested mapping|indented block/)
    })

    it('refuses a nested mapping, naming the key', () => {
      const reason = refused(file('description: fine\nscope:\n  surface: text'))
      expect(reason).toContain('line 3')
      expect(reason).toContain('scope')
      expect(reason).toMatch(/nested mapping|indented block/)
    })

    it('refuses a value YAML would read back as a number', () => {
      for (const [block, word] of [
        ['description: 42', 'a number'],
        ['description: 1.5e3', 'a number'],
        ['question: 0x1f', 'a number'],
        ['question: .inf', 'a number'],
        ['description: 2026-10-01', 'a date'],
      ] as const) {
        expect(refused(file(block)), block).toContain(word)
      }
      expect(refused(file('description: 42'))).toContain('line 2')
    })

    it('refuses a value YAML would read back as a boolean or null', () => {
      expect(refused(file('description: true'))).toMatch(/reads as true or false/)
      expect(refused(file('description: NULL'))).toMatch(/reads as null/)
      expect(refused(file('description: ~'))).toMatch(/reads as null/)
      expect(refused(file('globs: null'))).toContain('globs')
    })

    it('refuses a list where the field is a single line of text', () => {
      const reason = refused(file('description:\n  - one\n  - two'))
      expect(reason).toContain('line 2')
      expect(reason).toContain('description')
      expect(reason).toMatch(/is a list/)
    })

    it('refuses a block scalar', () => {
      expect(refused(file('description: |\n  two lines\n  of text'))).toMatch(/block scalar/)
      expect(refused(file('description: >-\n  folded'))).toMatch(/block scalar/)
      expect(refused(file('description: |'))).toContain('line 2')
    })

    it('refuses a flow mapping', () => {
      expect(refused(file('description: {a: b}'))).toMatch(/\{ mapping\}/)
      expect(refused(file('scope: [text, {tool: bash}]'))).toMatch(/mapping inside a list/)
    })

    it('refuses a mapping nested inside a list', () => {
      const reason = refused(file('scope:\n  - surface: text'))
      expect(reason).toContain('line 3')
      expect(reason).toContain('scope')
      expect(reason).toMatch(/nested mapping/)
    })

    it('refuses a field with no value at all', () => {
      expect(refused(file('description:'))).toMatch(/has no value/)
      expect(refused(file('description:   '))).toMatch(/has no value/)
      expect(refused(file('description: # a note'))).toMatch(/has no value/)
    })

    it('refuses a field that is set twice', () => {
      const reason = refused(file('scope:\n  - text\nscope:\n  - thinking'))
      expect(reason).toContain('line 4')
      expect(reason).toMatch(/set twice/)
      expect(reason).toContain('line 2')
    })

    it('refuses a frontmatter block that is not a mapping', () => {
      const reason = refused('---\n- one\n- two\n---\nbody')
      expect(reason).toMatch(/not a "key: value" field/)
      expect(reason).toContain('line 2')
    })

    it('refuses a switch spelled as text', () => {
      expect(refused(file('alwaysApply: yes'))).toMatch(/must be true or false/)
      expect(refused(file('alwaysApply: yes'))).toContain('alwaysApply')
      expect(refused(file('alwaysApply:\n  - true'))).toMatch(/must be true or false/)
    })

    it('refuses YAML sugar it cannot write back', () => {
      expect(refused(file('description: &anchor text'))).toMatch(/anchor or alias/)
      expect(refused(file('description: !!str text'))).toMatch(/YAML tag/)
      expect(refused(file('description: "unterminated'))).toMatch(/never closed/)
      expect(refused(file('description: "bad \\q escape"'))).toMatch(/not valid YAML/)
    })

    it('refuses a value with trailing junk after it', () => {
      expect(refused(file('description: "quoted" and more'))).toMatch(/after its closing quote/)
      expect(refused(file('scope: [a, b] extra'))).toMatch(/after its closing bracket/)
      expect(refused(file('scope:\n  - "a" and more'))).toMatch(/after its closing quote/)
    })

    it('never throws, whatever it is handed', () => {
      const junk = [
        undefined,
        null,
        42,
        {},
        [],
        true,
        '',
        '---',
        '--- ',
        '--- \n',
        '--- \n---',
        '--- \n--- \nbody',
        '\r\n',
        '﻿---\ndescription: x\n---\n',
        '---\ndescription: x\n---\n﻿',
        '---\ndescription: "unclosed\n---\n',
        '---\ndescription: [unclosed\n---\n',
        '---\ndescription: "bad \\q"\n---\n',
      ]
      for (const value of junk) {
        expect(() => parseRuleFile(value as unknown as string), JSON.stringify(value) ?? 'undefined').not.toThrow()
        const result = parseRuleFile(value as unknown as string)
        expect(typeof result.ok === 'boolean').toBe(true)
        if (!result.ok) expect(typeof result.reason).toBe('string')
      }
    })
  })

  describe('parseRuleFile reading', () => {
    it('accepts a block whose only content is blank lines', () => {
      expect(parsed('---\n---\nbody\n')).toEqual({ fields: {}, body: 'body\n' })
      expect(parsed('---\n\n\n---\nbody\n')).toEqual({ fields: {}, body: 'body\n' })
    })

    it('reads quoted text, single quotes, lists and switches', () => {
      expect(parsed(file('description: "Use for: b.Loop()"\nquestion: \'is it right?\''))).toEqual({
        fields: { description: 'Use for: b.Loop()', question: 'is it right?' },
        body: 'rule text\n',
      })
      expect(parsed(file('alwaysApply: true\ninterruptMode: never')).fields).toEqual({
        alwaysApply: true,
        interruptMode: 'never',
      })
      expect(parsed(file('scope:\n  - text\n  - "tool:edit(*.go)"')).fields).toEqual({
        scope: ['text', 'tool:edit(*.go)'],
      })
      expect(parsed(file('scope: [text, thinking]')).fields).toEqual({ scope: ['text', 'thinking'] })
      expect(parsed(file("question: 'it''s fine'")).fields).toEqual({ question: "it's fine" })
      expect(parsed(file('description: "tab\\there"')).fields).toEqual({ description: 'tab\there' })
      expect(parsed(file('description: "\\x41\\u00e9"')).fields).toEqual({ description: 'Aé' })
      expect(parsed(file('description: ""')).fields).toEqual({ description: '' })
    })

    it('splits a comma-separated list the way the engine does', () => {
      expect(parsed(file('scope: "tool:edit(*.ts), tool:write(*.ts)"')).fields).toEqual({
        scope: ['tool:edit(*.ts)', 'tool:write(*.ts)'],
      })
      expect(parsed(file('scope: "tool:edit(**/*.{ts,tsx}), tool:write(**/*.{ts,tsx})"')).fields).toEqual({
        scope: ['tool:edit(**/*.{ts,tsx})', 'tool:write(**/*.{ts,tsx})'],
      })
      expect(parsed(file('agents: "{scout, reviewer}"')).fields).toEqual({ agents: ['{scout, reviewer}'] })
    })

    it('normalizes the engine kebab-case keys', () => {
      expect(parsed(file('always-apply: true\ninterrupt-mode: always\nast-condition:\n  - "new(expr)"')).fields).toEqual({
        alwaysApply: true,
        interruptMode: 'always',
        astCondition: ['new(expr)'],
      })
    })

    it('keeps the body byte-identical, blank lines and all', () => {
      for (const body of [
        '\n\nrule text\n\n',
        '\n',
        '',
        'no trailing newline',
        '\nfirst\n\n\nthird\n\n',
        '```\ncode\n```\n\n---\n\nnot a delimiter\n',
        '\r\nwindows\r\n',
      ]) {
        expect(parsed(file('description: x', body)).body, JSON.stringify(body)).toBe(body)
      }
    })

    it('ignores comments and blank lines inside the block', () => {
      const { fields } = parsed(file('# leading note\n\ndescription: x   # trailing note\n\n# another\nscope:\n  - text\n'))
      expect(fields).toEqual({ description: 'x', scope: ['text'] })
    })
  })

  describe('serialiseRuleFile round trip', () => {
    for (const spec of FIELD_SPECS) {
      it(`round-trips ${spec.key} on its own`, () => {
        const fields: Fields = { [spec.key]: SAMPLE[spec.kind] }
        const written = serialiseRuleFile(fields, '\n\nbody\n\n')
        expect(parsed(written)).toEqual({ fields, body: '\n\nbody\n\n' })
        expect(parsed(written).body).toBe('\n\nbody\n\n')
      })
    }

    it('round-trips every kind in one file with the body untouched', () => {
      const fields: Fields = {
        description: 'Use for: b.Loop() in benchmarks (Go 1.24)',
        alwaysApply: false,
        globs: ['src/**/*.ts', 'src/**/*.tsx'],
        condition: ['(?i)\\bany\\b', ': any'],
        astCondition: ['func $F($V $T) *$T { return &$V }'],
        question: 'Does this leak a Box::leak?',
        agents: ['{scout,reviewer}', 'reviewer'],
        scope: ['text', 'tool:edit(*.go)', 'tool:write(*.go)'],
        interruptMode: 'prose-only',
      }
      const body = '\nTwo blank lines above.\n\n\nand a run below.\n\n'
      const result = parsed(serialiseRuleFile(fields, body))
      expect(result).toEqual({ fields, body })
    })

    it('round-trips an unusual key order unchanged', () => {
      const fields: Fields = { scope: ['text'], description: 'x', alwaysApply: true, condition: ['y'] }
      const written = serialiseRuleFile(fields, 'body\n')
      expect(Object.keys(parsed(written).fields)).toEqual(['scope', 'description', 'alwaysApply', 'condition'])
      expect(parsed(written).fields).toEqual(fields)
    })

    it('keeps a body with leading, trailing and internal blank lines byte-identical', () => {
      for (const body of ['\n\nrule\n\n', '\n\n\n', '', '\n\n# heading\n\n\ntext\n\n\n', 'trailing spaces   \n\n']) {
        const written = serialiseRuleFile({ description: 'x' }, body)
        expect(parsed(written).body, JSON.stringify(body)).toBe(body)
        expect(parsed(written).fields).toEqual({ description: 'x' })
      }
    })

    it('survives values that need quoting to stay text', () => {
      const nasty = [
        '',
        ' leading space',
        'trailing space ',
        'has: a colon',
        'colon:inside',
        'a # comment marker',
        '#starts with a hash',
        '- starts with a dash',
        'starts with a quote "',
        "ends with a quote '",
        'brace {group}',
        'bracket [list]',
        '*star',
        '&amp',
        '|pipe',
        '>gt',
        '!bang',
        '%percent',
        '`tick',
        '@at',
        'null',
        'Null',
        'true',
        'False',
        '123',
        '-4.5',
        '0x1f',
        '1e5',
        '.inf',
        '.nan',
        '2026-10-01',
        'back\\slash',
        'escape \\n not a newline',
        'tab\there',
        'new\nline',
        'carriage\rreturn',
        'two  spaces',
        'trailing\n',
        'unicode — dash and 中文',
        'bell\u0007and\u0085next',
      ]
      for (const value of nasty) {
        const written = serialiseRuleFile({ description: value, scope: [value] }, 'body\n')
        const result = parseRuleFile(written)
        expect(result.ok ? '' : result.reason, `description ${JSON.stringify(value)}`).toBe('')
        if (!result.ok) continue
        expect(result.fields, `text ${JSON.stringify(value)}`).toEqual({ description: value, scope: [value] })
        expect(parsed(written).fields, `stable ${JSON.stringify(value)}`).toEqual(result.fields)
      }
    })

    it('survives comments and odd spacing in the block, keeping the meaning', () => {
      const source = file('# top note\n\ndescription: "Use for: x"   # why\n\nscope:\n\n  - text\n  - thinking\n\n# tail note\n')
      const first = parsed(source)
      expect(first.fields).toEqual({ description: 'Use for: x', scope: ['text', 'thinking'] })
      const written = serialiseRuleFile(first.fields, first.body)
      expect(written).not.toContain('#')
      expect(parsed(written).fields).toEqual(first.fields)
    })

    it('round-trips every bundled rule file', () => {
      const dir = fileURLToPath(new URL('../src/builtin-rules/', import.meta.url))
      const names = readdirSync(join(dir)).filter(name => name.endsWith('.md'))
      expect(names.length).toBeGreaterThan(10)
      for (const name of names) {
        const source = readFileSync(join(dir, name), 'utf8')
        const first = parsed(source)
        expect(first.fields, `${name} fields`).not.toEqual({})
        const again = parsed(serialiseRuleFile(first.fields, first.body))
        expect(again.fields, `${name} fields after a round trip`).toEqual(first.fields)
        expect(again.body, `${name} body after a round trip`).toBe(first.body)
        expect(again.body, `${name} body keeps its blank lines`).toContain('\n\n')
      }
    })

    it('is stable when written twice', () => {
      const fields: Fields = { description: 'x: y', scope: ['a', 'b'], alwaysApply: false, interruptMode: 'never' }
      const once = serialiseRuleFile(fields, '\nbody\n')
      expect(serialiseRuleFile(parsed(once).fields, parsed(once).body)).toBe(once)
    })
  })

  describe('serialiseRuleFile refusals', () => {
    it('throws on a key it cannot read back', () => {
      expect(() => serialiseRuleFile({ bogus: 'x' }, 'body\n')).toThrow(/bogus/)
      expect(() => serialiseRuleFile({ description: 'x', bogus: true }, 'body\n')).toThrow(TypeError)
    })

    it('throws on a value that is not text, a switch, or a list of lines', () => {
      const bad = [42, null, undefined, {}, { a: 1 }, ['a', 2], [null], new Date(0)]
      for (const value of bad) {
        expect(
          () => serialiseRuleFile({ description: value as string }, 'b\n'),
          `description ${String(value)}`,
        ).toThrow(/description/)
        expect(() => serialiseRuleFile({ globs: value as string[] }, 'b\n'), `globs ${String(value)}`).toThrow(/globs/)
      }
      expect(() => serialiseRuleFile({ globs: ['a', 2] as unknown as string[] }, 'b\n')).toThrow(/globs.*list of lines/)
    })

    it('throws when a value does not match its field kind', () => {
      expect(() => serialiseRuleFile({ alwaysApply: 'true' }, 'b\n')).toThrow(/must be true or false/)
      expect(() => serialiseRuleFile({ alwaysApply: 1 as unknown as boolean }, 'b\n')).toThrow(/must be true or false/)
      expect(() => serialiseRuleFile({ description: ['a'] }, 'b\n')).toThrow(/single line of text/)
      expect(() => serialiseRuleFile({ scope: 'text' }, 'b\n')).toThrow(/list of lines/)
      expect(() => serialiseRuleFile({ scope: ['a', 'b'] as string[] }, 'b\n')).not.toThrow()
    })

    it('throws when the body is not a string', () => {
      for (const body of [undefined, null, 42, {}]) {
        expect(() => serialiseRuleFile({ description: 'x' }, body as unknown as string), String(body)).toThrow(TypeError)
      }
    })

    it('throws when the fields are not an object', () => {
      for (const fields of [undefined, null, 'description: x', 42, ['description']]) {
        expect(() => serialiseRuleFile(fields as unknown as Fields, 'b\n'), String(fields)).toThrow(TypeError)
      }
    })

    it('throws when frontmatterLines is not a list of lines', () => {
      for (const lines of [null, 'description: x', 42, ['ok', 7]]) {
        expect(
          () => serialiseRuleFile({ description: 'x' }, 'b\n', lines as unknown as string[]),
          String(lines),
        ).toThrow(/frontmatterLines/)
      }
    })

    it('throws when frontmatterLines are not a block this editor could read', () => {
      expect(() => serialiseRuleFile({ description: 'x' }, 'b\n', ['scope:', '  surface: text'])).toThrow(
        /frontmatterLines are not the block of a file this editor could read/,
      )
    })

    it('still refuses a wrong-typed value on the verbatim path', () => {
      const open = opened(file('description: fine\nbacking: note'))
      expect(() => serialiseRuleFile({ ...open.fields, alwaysApply: 'true' as unknown as boolean }, open.body, open.frontmatterLines)).toThrow(
        /must be true or false/,
      )
    })
  })

  describe('keys the editor does not know', () => {
    const WITH_BACKING = file(['description: Use new(expr)', 'backing: some note', 'scope: text, tool:edit(*.go)'].join('\n'))

    it('hands back an unknown key the file author wrote', () => {
      const open = opened(WITH_BACKING)
      expect(open.unknownKeys).toEqual(['backing'])
      expect(open.fields).toEqual({ description: 'Use new(expr)', scope: ['text', 'tool:edit(*.go)'] })
      expect(open.frontmatterLines).toEqual([
        'description: Use new(expr)',
        'backing: some note',
        'scope: text, tool:edit(*.go)',
      ])
    })

    it('brings an unknown key back byte-identically through an untouched round trip', () => {
      const open = opened(WITH_BACKING)
      const written = serialiseRuleFile(open.fields, open.body, open.frontmatterLines)
      expect(written).toBe(WITH_BACKING)
    })

    it('keeps an unknown key untouched and in place when a known field changes', () => {
      const written = edit(WITH_BACKING, { description: 'Prefer new(expr)' })
      expect(written).toBe(file(['description: Prefer new(expr)', 'backing: some note', 'scope: text, tool:edit(*.go)'].join('\n')))
      expect(written.indexOf('backing: some note')).toBeGreaterThan(written.indexOf('description: Prefer'))
    })

    it('changes only the edited field line, leaving every other line byte-identical', () => {
      const before = WITH_BACKING.split('\n')
      const after = edit(WITH_BACKING, { description: 'Prefer new(expr)' }).split('\n')
      expect(after.length).toBe(before.length)
      const differing = before.map((line, index) => (line === after[index] ? null : index)).filter(index => index !== null)
      expect(differing).toEqual([1])
      expect(after[1]).toBe('description: Prefer new(expr)')
    })

    it('rewrites a changed list in canonical form and nothing else', () => {
      const written = edit(WITH_BACKING, { scope: ['text'] })
      expect(written).toBe(file(['description: Use new(expr)', 'backing: some note', 'scope:', '  - text'].join('\n')))
    })

    it('parses a file whose keys are all unknown, and writes it back unchanged', () => {
      const source = file('backing: a note\nother-key: 42')
      const open = opened(source)
      expect(open.fields).toEqual({})
      expect(open.unknownKeys).toEqual(['backing', 'other-key'])
      expect(serialiseRuleFile(open.fields, open.body, open.frontmatterLines)).toBe(source)
    })

    it('keeps an unknown key that carries an indented block this form cannot draw', () => {
      const source = file('description: fine\nbacking:\n  owner: someone\nscope: text')
      const open = opened(source)
      expect(open.unknownKeys).toEqual(['backing'])
      expect(serialiseRuleFile(open.fields, open.body, open.frontmatterLines)).toBe(source)
      expect(edit(source, { description: 'other' })).toBe(
        file('description: other\nbacking:\n  owner: someone\nscope: text'),
      )
    })

    it('drops a known field the caller removed, and leaves the unknown key alone', () => {
      const open = opened(WITH_BACKING)
      const { description: _gone, ...rest } = open.fields
      const written = serialiseRuleFile(rest, open.body, open.frontmatterLines)
      expect(written).toBe(file(['backing: some note', 'scope: text, tool:edit(*.go)'].join('\n')))
    })

    it('adds a field the caller introduced, after the lines the file already had', () => {
      const source = file('backing: a note')
      expect(edit(source, { description: 'new' })).toBe(file('backing: a note\ndescription: new'))
    })

    it('still refuses what the form genuinely cannot represent', () => {
      expect(refused(file('backing: a note\nscope:\n  surface: text'))).toMatch(/line 3/)
      expect(refused(file('backing: a note\nscope: |\n  two lines\n  of text'))).toMatch(/line 3/)
      expect(refused(file('backing: a note\ndescription: {a: b}'))).toMatch(/line 3/)
      expect(refused(file('backing: a note\ndescription: "unclosed'))).toMatch(/line 3/)
      expect(refused(file('backing: a note\ndescription: &anchor text'))).toMatch(/line 3/)
      // A stray indented line is not part of any key: it is the block itself
      // drifting out of shape, which no amount of copying can repair.
      expect(refused(file('description: fine\n  stray: line'))).toMatch(/line 3/)
      expect(refused(file('description: fine\n  stray: line'))).toMatch(/indented/)
      expect(refused('no frontmatter at all\n')).toMatch(/no frontmatter block/)
      expect(refused('---\nbacking: a note\ndescription: x')).toMatch(/never closed/)
      expect(refused(file('- one\n- two'))).toMatch(/not a "key: value" field/)
    })

    it('keeps an unknown key whose block scalar holds a blank line', () => {
      // The blank line is inside the block scalar, so it does not end the
      // unknown key's entry the way a blank line between fields would.
      const source = file(['description: d', 'backing: |', '  first line', '', '  second line', 'scope: text'].join('\n'))
      const open = opened(source)
      expect(open.unknownKeys).toEqual(['backing'])
      expect(open.fields).toEqual({ description: 'd', scope: ['text'] })
      expect(serialiseRuleFile(open.fields, open.body, open.frontmatterLines), 'untouched').toBe(source)
      expect(edit(source, { description: 'other' })).toBe(
        file(['description: other', 'backing: |', '  first line', '', '  second line', 'scope: text'].join('\n')),
      )
    })

    it('keeps a known field in the spelling the author wrote, not the canonical one', () => {
      // `description` is quoted with single quotes and `always-apply` is
      // kebab-case: both read back as the values the form holds, and both must
      // come back the way they were rather than in this module's own spelling.
      const source = file(["description: 'Use new(expr)'", 'always-apply: true', 'backing: a note'].join('\n'))
      const open = opened(source)
      expect(open.fields).toEqual({ description: 'Use new(expr)', alwaysApply: true })
      expect(serialiseRuleFile(open.fields, open.body, open.frontmatterLines), 'untouched').toBe(source)
      expect(edit(source, { alwaysApply: false }), 'one edit').toBe(
        file(["description: 'Use new(expr)'", 'alwaysApply: false', 'backing: a note'].join('\n')),
      )
    })

    it('keeps the comment and blank lines that follow a list the caller changed', () => {
      const source = file(['scope:', '  - text', '', '# keep me', 'description: d'].join('\n'))
      const written = edit(source, { scope: ['text', 'thinking'] })
      expect(written).toBe(file(['scope:', '  - text', '  - thinking', '', '# keep me', 'description: d'].join('\n')))
    })

    it('brings a block of nothing but blank lines back byte-identically', () => {
      for (const source of ['---\n---\nbody\n', '---\n\n\n---\nbody\n']) {
        const open = opened(source)
        expect(open.fields).toEqual({})
        expect(open.unknownKeys).toEqual([])
        expect(serialiseRuleFile(open.fields, open.body, open.frontmatterLines), source).toBe(source)
      }
    })

    it('brings every bundled rule file back byte-identically', () => {
      const dir = fileURLToPath(new URL('../src/builtin-rules/', import.meta.url))
      const names = readdirSync(dir).filter(name => name.endsWith('.md')).map(name => name.split('.')[0])
      expect(names.length).toBeGreaterThanOrEqual(10)
      for (const name of names) {
        const source = readFileSync(join(dir, `${name}.md`), 'utf8')
        const open = opened(source)
        expect(serialiseRuleFile(open.fields, open.body, open.frontmatterLines), `${name} unchanged`).toBe(source)
      }
    })
  })

  describe('hasFields', () => {
    it('is true for a file with at least one field the form can edit', () => {
      expect(hasFields(file('description: x'))).toBe(true)
      expect(hasFields(file('always-apply: true'))).toBe(true)
      expect(hasFields(file('backing: note\ncondition:\n  - x'))).toBe(true)
    })

    it('is false when the block holds nothing the form can edit', () => {
      expect(hasFields(file('# just a note'))).toBe(false)
      expect(hasFields(file('backing: a note\nother-key: 42'))).toBe(false)
      expect(hasFields('---\n---\nbody\n')).toBe(false)
      expect(hasFields('---\n\n\n---\nbody\n')).toBe(false)
    })

    it('is false for a file with no usable frontmatter block', () => {
      expect(hasFields('Just a rule, no metadata.\n')).toBe(false)
      expect(hasFields('---\ndescription: x\n')).toBe(false)
      expect(hasFields('')).toBe(false)
      for (const junk of [undefined, null, 42, {}]) {
        expect(hasFields(junk as unknown as string), String(junk)).toBe(false)
      }
    })
  })
})
