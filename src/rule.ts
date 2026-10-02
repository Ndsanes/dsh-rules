/**
 * Canonical rule shape and the metadata normalization every provider shares.
 *
 * Field semantics follow OMP's `rulebook-matching-pipeline`: one `Rule` shape
 * for all sources, kebab- and legacy-`ttsr_trigger` spellings folded in here,
 * and the three TTSR trigger fields (`condition`, `astCondition`, `question`)
 * kept distinct because they gate different matching surfaces.
 */

import { isAstExtensionSupported } from './ast.ts'
import { parseFrontmatter } from './frontmatter.ts'

/** Which matching surfaces a TTSR rule may interrupt. */
export type InterruptMode = 'never' | 'prose-only' | 'tool-only' | 'always'

/** One entry of a rule's stream-scope allowlist. */
export interface ScopeToken {
  /** Stream surface the entry selects. */
  surface: 'text' | 'thinking' | 'tool'
  /** Tool name for `tool` entries; absent means every tool. */
  tool?: string
  /** Optional per-tool path glob. */
  glob?: string
}

/** Where one discovered rule came from. */
export interface RuleSource {
  /** Provider id, matching OMP's discovery provider names. */
  provider: string
  /** Absolute file path the rule body was read from. */
  path: string
  /** Provider priority; higher wins during deduplication. */
  priority: number
  /**
   * Short name of the tree the rule was found in.
   *
   * The provider alone cannot name a rule's origin: every project on disk puts
   * its rules in `.omp/rules`, so two projects produce two identically labelled
   * buckets. This is the project directory's own name — `Modu`, say — or `~` for
   * the user directory, so the label says which project a rule came from.
   */
  scope?: string
}

/** One normalized rule, regardless of which provider discovered it. */
export interface Rule {
  /** Capability identity; deduplication and `rule://` lookup use this alone. */
  name: string
  /** Absolute source path. */
  path: string
  /** Body with frontmatter stripped. */
  content: string
  globs?: string[]
  alwaysApply?: boolean
  description?: string
  /** Regex triggers evaluated against every in-scope stream delta. */
  condition?: string[]
  /** ast-grep structural triggers, evaluated against tool source snapshots. */
  astCondition?: string[]
  /** Natural-language question judged after an output completes. */
  question?: string
  scope?: ScopeToken[]
  agents?: string[]
  interruptMode?: InterruptMode
  _source: RuleSource
  /** True when a higher-priority provider already supplied this name. */
  _shadowed?: boolean
  /**
   * Frontmatter problems that cost this rule metadata, such as a YAML block
   * that only survived line-wise recovery.
   */
  _warnings?: string[]
}

/** Inputs for {@link buildRuleFromMarkdown}. */
export interface RuleInput {
  name: string
  path: string
  content: string
  source: RuleSource
  /** Applied after metadata parsing, e.g. a sticky rule's forced alwaysApply. */
  overrides?: Partial<Pick<Rule, 'alwaysApply' | 'name'>>
}

const INTERRUPT_MODES: readonly InterruptMode[] = ['never', 'prose-only', 'tool-only', 'always']
const TOOL_SCOPE = /^tool(?::([\w.-]+))?\((.*)\)$/
const INLINE_FLAGS = /^\(\?([imsu]+)\)/

/**
 * Split a comma-separated field, leaving commas inside `{…}` or `[…]` alone.
 *
 * A brace group is one glob alternative set, so splitting inside it would turn
 * `{scout, reviewer}` into two broken patterns. One layer of surrounding
 * quotes is stripped because a value that YAML rejected outright — a regex
 * carrying `\d`, say — survives frontmatter recovery as its raw quoted text.
 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
    .map(part => part.trim().replace(/^["']|["']$/g, '').trim())
    .filter(part => part !== '')
}

/** Accept a YAML sequence, a comma-separated string, or one bare string. */
function toStringList(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const parts = splitTopLevel(value)
    return parts.length > 0 ? parts : undefined
  }
  if (!Array.isArray(value)) return undefined
  const parts = value.filter((item): item is string => typeof item === 'string').map(item => item.trim())
  return parts.length > 0 ? parts : undefined
}

/**
 * Parse one `scope` value into allowlist entries.
 *
 * Accepts a comma-separated string, a YAML sequence, and the degraded
 * fallback spelling `scope: "text","thinking"` that the line-wise frontmatter
 * recovery can produce.
 */
export function parseScope(value: unknown): ScopeToken[] | undefined {
  const { tokens } = parseScopeWithUnknown(value)
  return tokens.length > 0 ? tokens : undefined
}

/**
 * Parse one `scope` value, reporting the tokens nothing recognized.
 *
 * `scope` is an enforcement field: a typo there silently drops the author's
 * restriction and the rule applies to every surface. The unknown pieces are
 * therefore handed back so the caller can record them, rather than discarded.
 */
export function parseScopeWithUnknown(value: unknown): { tokens: ScopeToken[]; unknown: string[] } {
  if (typeof value !== 'string' && !Array.isArray(value)) return { tokens: [], unknown: [] }
  const raw = Array.isArray(value) ? value : [value]
  const tokens: ScopeToken[] = []
  const unknown: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    for (const piece of splitTopLevel(entry)) {
      const lowered = piece.toLowerCase()
      if (lowered === 'text' || lowered === 'thinking') {
        tokens.push({ surface: lowered })
        continue
      }
      if (lowered === 'tool' || lowered === 'toolcall') {
        tokens.push({ surface: 'tool' })
        continue
      }
      const scoped = TOOL_SCOPE.exec(lowered)
      if (scoped !== null) {
        tokens.push({ surface: 'tool', tool: scoped[1], glob: scoped[2] })
        continue
      }
      unknown.push(piece)
    }
  }
  return { tokens, unknown }
}

/**
 * Normalize the `agents` field: lowercase patterns, no whitespace after commas
 * inside a brace group, so `{a, b}` and `{a,b}` compare equal.
 */
export function parseAgents(value: unknown): string[] | undefined {
  const list = toStringList(value)
  if (list === undefined) return undefined
  return list.map(pattern =>
    pattern.toLowerCase().replace(/\{\s*([^}]*?)\s*\}/g, (_, group: string) => `{${group.replace(/\s*,\s*/g, ',')}}`),
  )
}

/** Read `condition`, accepting the legacy `ttsr_trigger` spellings. */
function readCondition(data: Record<string, unknown>): string[] | undefined {
  return toStringList(data.condition) ?? toStringList(data.ttsr_trigger) ?? toStringList(data.ttsrTrigger)
}

/** Read `astCondition` as verbatim ast-grep patterns; no glob inference. */
function readAstCondition(data: Record<string, unknown>): string[] | undefined {
  return toStringList(data.astCondition)
}

/**
 * Translate a leading `(?i)`/`(?m)`/`(?s)` group into JavaScript regex flags.
 * @param pattern - the raw condition token.
 * @returns the pattern without the inline group plus its flags.
 */
export function splitInlineFlags(pattern: string): { source: string; flags: string } {
  const matched = INLINE_FLAGS.exec(pattern)
  if (matched === null) return { source: pattern, flags: '' }
  const flags = [...(matched[1] ?? '')].filter(flag => flag === 'i' || flag === 'm' || flag === 's').join('')
  return { source: pattern.slice(matched[0].length), flags }
}

/**
 * Report whether a `condition` token is really a file glob.
 *
 * A glob is a path pattern: a wildcard plus path shape, and none of the syntax
 * that only a regular expression has. The path-shape requirement is what keeps
 * a plain word with an optional character — `colou?r`, `foo.*bar`, `.*` — and
 * an import path such as `io/ioutil` or `math/rand` out of the rewrite below:
 * that rewrite replaces the author's real trigger with a catch-all, which under
 * the default `interruptMode: always` would then fire on every delta. `*.ts` is
 * kept as a glob because it is a path pattern; an extension list such as
 * `*.{ts,tsx}` carries its separator through the brace group.
 */
export function looksLikeGlob(token: string): boolean {
  if (/[[\]()\\]/.test(token) || /\\[dwsbp]/.test(token)) return false
  if (token.startsWith('^') || token.startsWith('$') || token.startsWith('(?')) return false
  if (/^\*(\.[^*/]+)+$/.test(token)) return true
  if (!token.includes('/')) return false
  return /[*?{]/.test(token) || token.endsWith('/')
}

/**
 * Strip one layer of surrounding quotes from a scalar.
 *
 * A value YAML rejected outright — a regex carrying `\d`, say — survives
 * frontmatter recovery as its raw quoted text, and a description rendered with
 * its quotes is not the text the author wrote.
 */
function unquote(value: string): string {
  const trimmed = value.trim()
  // Paired only: a recovered description such as `Prefer the authors'` ends in
  // an apostrophe without starting with one, and a loose strip would eat it.
  const wrapped = /^(["'])([\s\S]*)\1$/.exec(trimmed)
  return wrapped === null ? trimmed : (wrapped[2] ?? '').trim()
}

/**
 * Expand one layer of `{a,b}` alternation, so `*.{ts,tsx}` reads as two globs.
 * @param pattern - a glob that may carry a brace group.
 * @returns one string per alternative.
 */
function expandBraces(pattern: string): string[] {
  const group = /\{([^{}]*)\}/.exec(pattern)
  if (group === null) return [pattern]
  const alternatives = (group[1] ?? '').split(',').map(part => part.trim()).filter(part => part !== '')
  if (alternatives.length === 0) return [pattern]
  return alternatives.flatMap(part => expandBraces(pattern.replace(group[0], part)))
}

/**
 * Report whether ast-grep can parse the files a rule's own path gate names.
 *
 * A rule that declares `astCondition` but gates itself on extensions no bundled
 * grammar covers can never fire, and the skip is otherwise invisible: the
 * author sees a rule that simply never matches. `unknown` means the gate names
 * no extension at all, which is not evidence of anything.
 */
function astConditionReachable(globs: readonly string[]): 'reachable' | 'unreachable' | 'unknown' {
  const extensions = new Set<string>()
  for (const glob of globs) {
    for (const expanded of expandBraces(glob)) {
      const base = expanded.split('/').pop() ?? expanded
      const extension = /\.([A-Za-z0-9]+)$/.exec(base)
      if (extension === null) return 'unknown'
      extensions.add((extension[1] ?? '').toLowerCase())
    }
  }
  if (extensions.size === 0) return 'unknown'
  return [...extensions].every(extension => !isAstExtensionSupported(extension)) ? 'unreachable' : 'reachable'
}

/**
 * Build one rule from Markdown source text.
 *
 * Glob-shaped `condition` tokens are rewritten the way OMP does: the glob
 * becomes `tool:edit(<glob>)` and `tool:write(<glob>)` scope entries and the
 * regex becomes a catch-all, so a path rule still matches pathless streams.
 * Each rewrite is recorded as a warning, since it replaces the trigger the
 * author actually wrote.
 */
export function buildRuleFromMarkdown(input: RuleInput): Rule {
  const parsed = parseFrontmatter(input.content)
  const data = parsed.data
  const warnings = [...parsed.warnings]

  const rule: Rule = {
    name: input.overrides?.name ?? input.name,
    // The file the body was actually read from, when the caller knew it. The
    // provider's own directory was the fallback before, which is empty for the
    // native provider and so left project rules with no file at all — the editor
    // then read `''`. Embedded rules and sticky files carry no per-rule path and
    // still resolve through the source.
    path: input.path ?? input.source.path,
    content: parsed.body,
    _source: input.source,
  }

  const globs = toStringList(data.globs)
  if (globs !== undefined) rule.globs = globs

  // A quoted `alwaysApply` is how the value reads after frontmatter recovery,
  // and dropping it there would silently keep the body out of the prompt
  // forever. Only the two words YAML would have read as booleans are accepted;
  // anything else is a typo, not a switch.
  if (typeof data.alwaysApply === 'boolean') rule.alwaysApply = data.alwaysApply
  else if (typeof data.alwaysApply === 'string') {
    const lowered = data.alwaysApply.trim().toLowerCase()
    if (lowered === 'true' || lowered === 'false') rule.alwaysApply = lowered === 'true'
    else warnings.push(`alwaysApply: ${data.alwaysApply} is not true or false; ignored`)
  } else if (data.alwaysApply !== undefined) {
    warnings.push('alwaysApply: not a boolean; ignored')
  }

  const description = typeof data.description === 'string' ? unquote(data.description) : ''
  if (description !== '') rule.description = description
  const question = typeof data.question === 'string' ? unquote(data.question) : ''
  if (question !== '') rule.question = question

  const agents = parseAgents(data.agents)
  if (agents !== undefined) rule.agents = agents

  // Compared case-insensitively and trimmed: an unrecognized spelling used to
  // fall through to the default `always`, which inverts an author's intent when
  // the value they wrote was `Never`.
  if (typeof data.interruptMode === 'string') {
    const mode = data.interruptMode.trim().toLowerCase() as InterruptMode
    if (INTERRUPT_MODES.includes(mode)) rule.interruptMode = mode
    else warnings.push(`interruptMode: ${data.interruptMode} is not one of ${INTERRUPT_MODES.join(', ')}; ignored`)
  }

  const scope = parseScopeWithUnknown(data.scope)
  if (scope.unknown.length > 0) {
    warnings.push(`scope: ${scope.unknown.join(', ')} is not a surface; dropped, so the rule applies more widely than written`)
  }
  // The glob rewrite below appends to this list, so it must not be the array
  // held by the parsed scope: each token would otherwise re-expand the ones
  // added before it and drop all but the last.
  const scopeTokens: ScopeToken[] = [...scope.tokens]

  const conditions = readCondition(data)
  if (conditions !== undefined) {
    const expanded: string[] = []
    for (const token of conditions) {
      if (!looksLikeGlob(token)) {
        expanded.push(token)
        continue
      }
      scopeTokens.push({ surface: 'tool', tool: 'edit', glob: token }, { surface: 'tool', tool: 'write', glob: token })
      expanded.push('.*')
      warnings.push(`condition: ${token} read as a path glob; its trigger became .* and it now gates edit and write scope`)
    }
    rule.condition = expanded
  }
  if (scopeTokens.length > 0) rule.scope = scopeTokens

  const astCondition = readAstCondition(data)
  if (astCondition !== undefined) {
    rule.astCondition = astCondition
    // The patterns stay on the rule rather than being dropped: they are the
    // author's, and dropping them would also move the rule out of the streaming
    // bucket into the rulebook, changing where its text is injected. The
    // warning is what makes the inert state visible instead of silent.
    const gated = [...(rule.globs ?? []), ...scopeTokens.flatMap(token => (token.glob === undefined ? [] : [token.glob]))]
    if (astConditionReachable(gated) === 'unreachable') {
      warnings.push('astCondition: no bundled ast-grep grammar covers the files this rule gates on, so it cannot fire here')
    }
  }

  if (warnings.length > 0) rule._warnings = warnings
  if (input.overrides?.alwaysApply !== undefined) rule.alwaysApply = input.overrides.alwaysApply
  return rule
}
