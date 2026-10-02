/**
 * OMP-compatible frontmatter parsing.
 *
 * Reproduces the documented `parseFrontmatter` semantics: frontmatter is only
 * recognized when the document opens with `---` and contains a closing
 * `\n---`; a whole-document YAML failure degrades to line-wise `key: value`
 * extraction whose values are reparsed individually; keys normalize from
 * kebab-case to camelCase on both paths.
 */

import { load as loadYaml } from 'js-yaml'

/** One parsed frontmatter block plus the document body that followed it. */
export interface Frontmatter {
  /** Normalized camelCase keys; values keep their YAML-parsed shape. */
  data: Record<string, unknown>
  /** Document body with the frontmatter block removed and outer space trimmed. */
  body: string
  /** Non-fatal parse problems, in encounter order. */
  warnings: string[]
}

const BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/
const LINE = /^([\w-]+):[ \t]*(.*)$/

/** Normalize one frontmatter key to camelCase. */
function normalizeKey(key: string): string {
  return key.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase())
}

/** Reparse a single value, leaving malformed input as its raw trimmed text. */
function parseValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  try {
    return loadYaml(trimmed)
  } catch {
    return trimmed
  }
}

/**
 * Count unclosed brackets and braces, ignoring anything inside quotes.
 *
 * Used only to decide whether a value continues onto the next physical line;
 * a quoted regex such as `'[<>]'` must not read as an open collection.
 */
function bracketDepth(text: string): number {
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
  }
  return depth
}

/**
 * Line-wise recovery for a document whose YAML block did not parse.
 *
 * A value that spans several physical lines is rejoined before it is reparsed:
 * committing `globs: [src/**,` on its own both throws inside the reparse and
 * drops the continuation line that carried the rest of the pattern, so the
 * author is left with a truncated glob that matches nothing. Continuation
 * stops at the next `key:` line, which is where the author started a new field.
 */
function parseLines(block: string): { data: Record<string, unknown>; warnings: string[] } {
  const data: Record<string, unknown> = {}
  const warnings = ['frontmatter YAML parse failed; recovered line-wise']
  const lines = block.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = LINE.exec(lines[index] ?? '')
    if (match === null) continue
    const key = match[1]
    let value = match[2]
    if (key === undefined || value === undefined) continue
    while (bracketDepth(value) > 0 && index + 1 < lines.length) {
      const next = lines[index + 1] ?? ''
      if (LINE.test(next)) {
        warnings.push(`${normalizeKey(key)}: value never closes its brackets; kept up to the next key`)
        break
      }
      index += 1
      value += `\n${next}`
    }
    data[normalizeKey(key)] = parseValue(value)
    if (value.includes('\n')) warnings.push(`${normalizeKey(key)}: value spans several lines; rejoined`)
  }
  return { data, warnings }
}

/**
 * Split one Markdown document into frontmatter data and body.
 * @param content - the complete rule file text.
 * @returns normalized data, the trimmed body, and any recovery warnings.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const matched = BLOCK.exec(content)
  if (matched === null) return { data: {}, body: content.trim(), warnings: [] }

  const block = matched[1] ?? ''
  const body = (matched[2] ?? '').trim()
  const warnings: string[] = []
  let data: Record<string, unknown>
  try {
    const parsed: unknown = loadYaml(block)
    if (parsed === null || parsed === undefined) {
      data = {}
    } else if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      data = {}
      warnings.push('frontmatter is not a mapping; ignored')
    } else {
      data = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        data[normalizeKey(key)] = value
      }
    }
  } catch (error) {
    const recovered = parseLines(block)
    data = recovered.data
    warnings.push(...recovered.warnings, error instanceof Error ? error.message : String(error))
  }

  return { data, body, warnings }
}
