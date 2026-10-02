import { describe, expect, it } from 'vitest'
import { matchAnyGlob, matchGlob } from '../src/glob.ts'

describe('matchGlob', () => {
  it('matches within one segment', () => {
    expect(matchGlob('*.ts', 'a.ts')).toBe(true)
    expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/*.ts', 'src/nested/a.ts')).toBe(false)
  })

  it('matches a bare pattern against a trailing path segment', () => {
    expect(matchGlob('*.ts', 'src/deep/a.ts')).toBe(true)
  })

  it('spans segments with a double star', () => {
    expect(matchGlob('src/**/*.ts', 'src/a/b/c.ts')).toBe(true)
    expect(matchGlob('src/**/*.ts', 'lib/a.ts')).toBe(false)
  })

  it('matches a single character with a question mark', () => {
    expect(matchGlob('a?.ts', 'ab.ts')).toBe(true)
    expect(matchGlob('a?.ts', 'abc.ts')).toBe(false)
  })

  it('expands brace alternation', () => {
    expect(matchGlob('*.{ts,tsx}', 'a.tsx')).toBe(true)
    expect(matchGlob('*.{ts,tsx}', 'a.js')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(matchGlob('Scout', 'scout')).toBe(true)
  })

  it('anchors both ends', () => {
    expect(matchGlob('src', 'src/a')).toBe(false)
    expect(matchGlob('src/a', 'x/src/a')).toBe(false)
  })

  it('keeps glob semantics for wildcards inside a brace group', () => {
    expect(matchGlob('{src,lib}/**', 'src/a.ts')).toBe(true)
    expect(matchGlob('{src,lib}/**', 'lib/a.ts')).toBe(true)
    expect(matchGlob('{src,lib}/**', 'test/a.ts')).toBe(false)
  })

  it('spans segments from inside a brace group', () => {
    expect(matchGlob('{src,lib}/**/*.ts', 'lib/deep/a.ts')).toBe(true)
  })

  it('keeps a single star segment-bound inside a brace group', () => {
    expect(matchGlob('{src,lib}/*.ts', 'src/a.ts')).toBe(true)
    expect(matchGlob('{src,lib}/*.ts', 'src/deep/a.ts')).toBe(false)
  })

  it('still matches a bare basename after a brace group', () => {
    expect(matchGlob('*.ts', 'src/a.ts')).toBe(true)
    expect(matchGlob('*.ts', 'a.ts')).toBe(true)
  })

  it('expands nested brace groups', () => {
    expect(matchGlob('{a,{b,c}}/*.ts', 'a/d.ts')).toBe(true)
    expect(matchGlob('{a,{b,c}}/*.ts', 'c/d.ts')).toBe(true)
    expect(matchGlob('{a,{b,c}}/*.ts', 'e/d.ts')).toBe(false)
  })

  it('treats an unbalanced brace as literal text', () => {
    expect(() => matchGlob('{unclosed/*.ts', 'x.ts')).not.toThrow()
    expect(matchGlob('{unclosed/*.ts', 'x.ts')).toBe(false)
  })

  it('does not throw on a glob that cannot compile', () => {
    expect(() => matchGlob('[unclosed', 'a.ts')).not.toThrow()
    expect(matchGlob('[unclosed', 'a.ts')).toBe(false)
  })
})

describe('matchAnyGlob', () => {
  it('is true when any pattern matches', () => {
    expect(matchAnyGlob(['*.md', '*.ts'], 'a.ts')).toBe(true)
    expect(matchAnyGlob(['*.md'], 'a.ts')).toBe(false)
  })

  it('is false for an empty list', () => {
    expect(matchAnyGlob([], 'a.ts')).toBe(false)
  })
})
