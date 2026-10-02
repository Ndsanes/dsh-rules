/**
 * Time Traveling Stream Rules: the matching engine.
 *
 * Rules are registered once per session, compiled against their scope and
 * trigger fields, and then consulted on every stream delta and tool snapshot.
 * A match passes four gates in order — stream scope, the rule's path globs, the
 * trigger itself, and the repeat policy — so a rule that cannot act never
 * costs work beyond its gate.
 */

import { matchAnyGlob } from './glob.ts'
import { splitInlineFlags, type InterruptMode, type Rule, type ScopeToken } from './rule.ts'

/** Runtime settings the manager reads on every check. */
export interface TtsrSettings {
  enabled: boolean
  interruptMode: InterruptMode
  repeatMode: 'once' | 'after-gap'
  repeatGap: number
}

/** Which stream a match came from. */
export type MatchSource = 'text' | 'thinking' | 'tool'

/** What is known about the stream being matched. */
export interface MatchContext {
  source: MatchSource
  /** Tool name when `source` is `tool`. */
  tool?: string
  /** The tool call's identity, which is what its result is keyed by. */
  callId?: string
  /**
   * Candidate file paths the rule's globs may gate on. Callers supply every
   * form a rule might have written the path in, not just the literal argument.
   */
  paths?: readonly string[]
}

/** One registered rule with its compiled trigger state. */
interface CompiledRule {
  rule: Rule
  interruptMode: InterruptMode
  scope: ScopeToken[]
  regexps: RegExp[]
  astPatterns: string[]
  question: string | undefined
  globGate: string[] | undefined
  lastInjectedAt: number | undefined
}

/** Why a registration was refused; every value is a warning, never a failure. */
export type Rejection =
  | 'disabled'
  | 'no-trigger'
  | 'invalid-regex'
  | 'duplicate-name'
  | 'unreachable-scope'

/** Outcome of one {@link TtsrManager.addRule} call. */
export interface Registration {
  accepted: boolean
  reason?: Rejection
}

/** Default scope: assistant prose and every tool argument, never thinking. */
const DEFAULT_SCOPE: ScopeToken[] = [{ surface: 'text' }, { surface: 'tool' }]

/**
 * Report whether one scope entry admits a match context.
 *
 * A `tool` entry without a name admits every tool; a named entry additionally
 * requires its optional path glob to match one of the context paths.
 */
function scopeAdmits(scope: readonly ScopeToken[], context: MatchContext): boolean {
  for (const token of scope) {
    if (token.surface !== context.source) continue
    if (context.source !== 'tool') return true
    if (token.tool !== undefined && token.tool !== context.tool) continue
    if (token.glob === undefined || token.glob === '') return true
    const paths = context.paths ?? []
    if (paths.some(path => matchAnyGlob([token.glob!], path))) return true
  }
  return false
}

/**
 * Report whether a scope can ever admit anything.
 *
 * Every parsed token names a surface the harness produces, so the only
 * unreachable scope is an empty one. Narrowness — a named tool, a path glob —
 * is deliberately not treated as dead here: registration cannot know which
 * tools or paths a session will actually use, so a narrow scope simply goes
 * unmatched instead of being silently retired.
 */
function scopeReachable(scope: readonly ScopeToken[]): boolean {
  return scope.length > 0
}

/**
 * Resolve whether one rule's `interruptMode` allows interrupting this match.
 *
 * `never` never interrupts; the prose-only and tool-only modes gate on the
 * matched surface; `always` interrupts any surface.
 */
export function interrupts(mode: InterruptMode, source: MatchSource): boolean {
  if (mode === 'never') return false
  if (mode === 'always') return true
  const isProse = source === 'text' || source === 'thinking'
  return mode === 'prose-only' ? isProse : !isProse
}

/** Per-session registry and matcher for streaming rules. */
export class TtsrManager {
  readonly #settings: () => TtsrSettings
  readonly #compiled = new Map<string, CompiledRule>()
  readonly #warnings: string[] = []
  #messageCount = 0

  /**
   * @param settings - live settings accessor; changes apply on the next check.
   */
  constructor(settings: () => TtsrSettings) {
    this.#settings = settings
  }

  /** Non-fatal problems collected while registering and matching. */
  get warnings(): readonly string[] {
    return this.#warnings
  }

  /** Rules currently registered, in registration order. */
  getRules(): Rule[] {
    return [...this.#compiled.values()].map(entry => entry.rule)
  }

  /** Whether any regex or AST rule is registered and matching is enabled. */
  hasRules(): boolean {
    if (!this.#settings().enabled) return false
    return [...this.#compiled.values()].some(entry => entry.question === undefined && (entry.regexps.length > 0 || entry.astPatterns.length > 0))
  }

  /** Whether any AST rule is registered, so snapshot matching is worth doing. */
  hasAstRules(): boolean {
    if (!this.#settings().enabled) return false
    return [...this.#compiled.values()].some(entry => entry.question === undefined && entry.astPatterns.length > 0)
  }

  /**
   * Register one rule as a streaming rule.
   *
   * Registration is skipped, with a recorded reason, when streaming rules are
   * disabled, the rule declares no trigger, every regex fails to compile and no
   * AST pattern or question remains, the name is already registered, or the
   * parsed scope can never admit a stream.
   */
  addRule(rule: Rule): Registration {
    if (!this.#settings().enabled) return { accepted: false, reason: 'disabled' }
    if (this.#compiled.has(rule.name)) return { accepted: false, reason: 'duplicate-name' }

    const settings = this.#settings()
    const scope = rule.scope ?? DEFAULT_SCOPE
    if (!scopeReachable(scope)) {
      this.#warn(rule.name, 'scope can never match a stream')
      return { accepted: false, reason: 'unreachable-scope' }
    }

    const regexps: RegExp[] = []
    for (const token of rule.condition ?? []) {
      const { source, flags } = splitInlineFlags(token)
      // No `g` flag: a global regexp carries `lastIndex` between calls, which
      // would make a rule stop matching after its first hit in a session.
      try {
        regexps.push(new RegExp(source, flags))
      } catch (error) {
        this.#warn(rule.name, `invalid condition ${JSON.stringify(token)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const astPatterns = rule.astCondition ?? []
    const question = rule.question
    if (regexps.length === 0 && astPatterns.length === 0 && question === undefined) {
      this.#warn(rule.name, 'no usable trigger')
      return { accepted: false, reason: regexps.length === 0 && (rule.condition?.length ?? 0) > 0 ? 'invalid-regex' : 'no-trigger' }
    }

    this.#compiled.set(rule.name, {
      rule,
      interruptMode: rule.interruptMode ?? settings.interruptMode,
      scope,
      regexps,
      astPatterns,
      question,
      globGate: rule.globs,
      lastInjectedAt: undefined,
    })
    return { accepted: true }
  }

  /** Count one completed turn, which is what `after-gap` measures. */
  countTurn(): void {
    this.#messageCount += 1
  }

  /**
   * Restore injected rule names after a session reload.
   *
   * Persistence stores names only, so every restored rule is recorded at turn
   * zero and becomes eligible again after `repeatGap` newly completed turns.
   */
  restoreInjected(names: readonly string[]): void {
    for (const name of names) {
      const entry = this.#compiled.get(name)
      if (entry !== undefined) entry.lastInjectedAt = 0
    }
  }

  /**
   * Test one rule against the repeat policy.
   *
   * `once` blocks every rule that already has an injection record; `after-gap`
   * blocks until `repeatGap` further turns have completed.
   */
  #repeatAllows(entry: CompiledRule): boolean {
    if (entry.lastInjectedAt === undefined) return true
    const settings = this.#settings()
    if (settings.repeatMode === 'once') return false
    return this.#messageCount - entry.lastInjectedAt >= settings.repeatGap
  }

  /** Mark one rule injected in memory and report whether it was eligible. */
  claim(rule: Rule): boolean {
    const entry = this.#compiled.get(rule.name)
    if (entry === undefined || !this.#repeatAllows(entry)) return false
    entry.lastInjectedAt = this.#messageCount
    return true
  }

  /** Rule names with an injection record in this session. */
  injectedNames(): string[] {
    return [...this.#compiled.values()].filter(entry => entry.lastInjectedAt !== undefined).map(entry => entry.rule.name)
  }

  /**
   * Test one chunk of text against every eligible rule.
   *
   * Gates run in OMP's order: stream scope, the rule's path globs, then the
   * regex. The repeat policy is not applied here — {@link claim} owns it, so a
   * batch can be inspected before one rule is spent.
   */
  checkDelta(delta: string, context: MatchContext): Rule[] {
    if (!this.#settings().enabled || delta === '') return []
    const matched: Rule[] = []
    for (const entry of this.#compiled.values()) {
      if (entry.question !== undefined) continue
      if (!scopeAdmits(entry.scope, context)) continue
      if (entry.globGate !== undefined && !this.#passesGlobGate(entry, context)) continue
      if (!entry.regexps.some(regexp => regexp.test(delta))) continue
      matched.push(entry.rule)
    }
    return matched
  }

  /**
   * Test a reconstructed source snapshot against every eligible rule.
   *
   * Used for tool arguments, where the payload is the tool's own source rather
   * than a wire delta, so a partial stream cannot split a construct.
   */
  checkSnapshot(snapshot: string, context: MatchContext): Rule[] {
    return this.checkDelta(snapshot, context)
  }

  /** Candidates for AST matching on one tool snapshot. */
  astCandidates(snapshot: string, context: MatchContext): Array<{ rule: Rule; patterns: string[] }> {
    if (!this.hasAstRules()) return []
    const candidates: Array<{ rule: Rule; patterns: string[] }> = []
    for (const entry of this.#compiled.values()) {
      if (entry.question !== undefined) continue
      if (entry.astPatterns.length === 0) continue
      if (!scopeAdmits(entry.scope, context)) continue
      if (entry.globGate !== undefined && !this.#passesGlobGate(entry, context)) continue
      candidates.push({ rule: entry.rule, patterns: entry.astPatterns })
    }
    return candidates
  }

  /**
   * Rule names whose question should be asked about one completed output.
   *
   * The repeat policy is claimed here, not left to the caller, because on this
   * path the two orders are not equivalent: claiming after the verdict would let
   * a `once` rule be asked about on *every* assistant message while its single
   * budget was still unspent, so the judge LLM call — the bill — would repeat
   * forever. Candidates are collected first and claimed afterwards, so the whole
   * batch is inspected before any rule is spent, exactly as in
   * {@link checkDelta}'s contract states.
   *
   * The cost of that choice is that the ledger records the *question*, not the
   * warning: a judge that answers "not violated", times out, or fails spends a
   * `once` rule without injecting anything. That is deliberate, since the
   * alternative is an unbounded judge bill, and it is why `deliverWarnings` must
   * not claim a second time.
   *
   * `enabled` is checked for the same reason as in {@link checkDelta}: with TTSR
   * switched off nothing returned here could ever be delivered, so the judge must
   * not be asked at all.
   */
  judgedCandidates(content: string, context: MatchContext): Rule[] {
    if (!this.#settings().enabled || content === '') return []
    const candidates: Rule[] = []
    for (const entry of this.#compiled.values()) {
      if (entry.question === undefined) continue
      if (!scopeAdmits(entry.scope, context)) continue
      if (entry.globGate !== undefined && !this.#passesGlobGate(entry, context)) continue
      if (entry.regexps.length > 0 && !entry.regexps.some(regexp => regexp.test(content))) continue
      candidates.push(entry.rule)
    }
    return candidates.filter(candidate => this.claim(candidate))
  }

  /** The path-glob gate: at least one candidate path must match the rule. */
  #passesGlobGate(entry: CompiledRule, context: MatchContext): boolean {
    const paths = context.paths ?? []
    if (paths.length === 0) return false
    return paths.some(path => matchAnyGlob(entry.globGate!, path))
  }

  /** Record one non-fatal problem. */
  #warn(ruleName: string, message: string): void {
    this.#warnings.push(`${ruleName}: ${message}`)
  }
}
