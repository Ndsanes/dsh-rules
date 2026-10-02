/**
 * Minimal glob matcher shared by rule globs, `agents` filters, and scoped tool
 * path gates.
 *
 * Supports `*` (within one segment), `**` (across segments), `?`, and brace
 * alternation `{a,b}`. Matching is anchored and case-insensitive, which is what
 * OMP applies to agent names and path gates alike.
 */

const cache = new Map<string, RegExp>()

/** Regexp that can never match, used when a glob fails to compile. */
const NEVER_MATCH = /(?!)/

/** Escape the regex metacharacters that stay literal inside a glob. */
function escapeLiteral(text: string): string {
  return text.replace(/[.+^$()|[\]\\]/g, '\\$&')
}

/**
 * Translate a glob into regex source without `^`/`$` anchors.
 *
 * The same translator serves both the top-level pattern and every piece inside
 * a brace group: brace alternatives are glob fragments, so their wildcards must
 * keep glob meaning (`**` -> `.*`) instead of becoming regex quantifiers.
 */
function translateGlob(pattern: string): string {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === undefined) break
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 1
        if (pattern[index + 1] === '/') index += 1
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '{') {
      source += expandBraces(pattern.slice(index))
      index = pattern.length
      continue
    }
    source += escapeLiteral(char)
  }
  return source
}

/** Split a brace body on top-level commas so nested groups stay intact. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of body) {
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/** Expand one brace group into its alternation source. */
function expandBraces(pattern: string): string {
  const open = pattern.indexOf('{')
  if (open === -1) return translateGlob(pattern)
  let depth = 0
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth !== 0) continue
      const body = pattern.slice(open + 1, index)
      const alternatives = splitAlternatives(body)
      const head = translateGlob(pattern.slice(0, open))
      const tail = translateGlob(pattern.slice(index + 1))
      const joined = alternatives.map(translateGlob).join('|')
      return `${head}(?:${joined})${tail}`
    }
  }
  // Unbalanced `{` is literal text, so fall back to the plain glob translation
  // instead of treating the rest of the pattern as an alternation.
  return translateGlob(pattern)
}

/** Translate a glob into anchored regex source. */
function toRegExpSource(pattern: string): string {
  return `^${translateGlob(pattern)}$`
}

/**
 * Test one value against a glob.
 *
 * A pattern without a separator also matches a value's trailing path segment,
 * which is how OMP lets `*.ts` match a bare basename as well as a full path.
 *
 * Patterns come from user-authored rules, so a glob that cannot compile as a
 * regex (for example `'[unclosed'`) resolves to a never-matching regexp instead
 * of throwing: a bad rule must fail to match, not break rule loading for the
 * whole session.
 */
export function matchGlob(pattern: string, value: string): boolean {
  let regexp = cache.get(pattern)
  if (regexp === undefined) {
    try {
      regexp = new RegExp(toRegExpSource(pattern), 'i')
    } catch {
      regexp = NEVER_MATCH
    }
    cache.set(pattern, regexp)
  }
  if (regexp.test(value)) return true
  if (pattern.includes('/')) return false
  const lastSegment = value.split('/').pop()
  return lastSegment !== undefined && regexp.test(lastSegment)
}

/** Test a value against any pattern in the list. */
export function matchAnyGlob(patterns: readonly string[], value: string): boolean {
  return patterns.some(pattern => matchGlob(pattern, value))
}
