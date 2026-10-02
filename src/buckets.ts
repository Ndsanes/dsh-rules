/**
 * Rule bucketing.
 *
 * Reproduces OMP's `bucketRules`: settings and agent filtering run first, an
 * accepted TTSR registration wins over every other bucket, and the remainder
 * falls to always-apply when `alwaysApply` is set and to the rulebook when the
 * rule carries a description.
 */

import { matchAnyGlob } from './glob.ts'
import type { Rule } from './rule.ts'

/** Session-level inputs that decide bucketing. */
export interface BucketOptions {
  /** Whether the embedded `builtin-defaults` rules stay enabled. */
  builtinRules: boolean
  /** Rule names excluded from every bucket. */
  disabledRules: readonly string[]
  /** Agent name the session evaluates `agents` filters under. */
  agentName: string
  /**
   * Offer a rule to the TTSR manager.
   * @returns true when the manager accepted it, which makes the rule TTSR-only.
   */
  registerTtsr: (rule: Rule) => boolean
}

/** The three buckets plus the rules that joined none of them. */
export interface Buckets {
  rulebookRules: Rule[]
  alwaysApplyRules: Rule[]
  ttsrRules: Rule[]
  /** Rules excluded by settings or agent filtering. */
  dropped: Rule[]
}

/** Report whether a rule declares any TTSR trigger field. */
export function hasTrigger(rule: Rule): boolean {
  const hasCondition = (rule.condition?.length ?? 0) > 0
  const hasAst = (rule.astCondition?.length ?? 0) > 0
  const hasQuestion = typeof rule.question === 'string' && rule.question.trim() !== ''
  return hasCondition || hasAst || hasQuestion
}

/**
 * Report whether `agents` admits the session's agent name.
 *
 * An absent or empty filter admits every agent. `main` is the top-level session
 * and `sub` the unnamed-subagent sentinel; both are reserved names that no
 * agent definition can claim.
 */
export function agentMatches(rule: Rule, agentName: string): boolean {
  if (rule.agents === undefined || rule.agents.length === 0) return true
  return matchAnyGlob(rule.agents, agentName.toLowerCase())
}

/**
 * Sort discovered rules into the rulebook, always-apply, and TTSR buckets.
 * @param rules - winning rules from the capability load.
 * @param options - settings and agent name for this session.
 */
export function bucketRules(rules: readonly Rule[], options: BucketOptions): Buckets {
  const disabled = new Set(options.disabledRules)
  const buckets: Buckets = { rulebookRules: [], alwaysApplyRules: [], ttsrRules: [], dropped: [] }

  for (const rule of rules) {
    if (disabled.has(rule.name)) {
      buckets.dropped.push(rule)
      continue
    }
    if (rule._source.provider === 'builtin-defaults' && !options.builtinRules) {
      buckets.dropped.push(rule)
      continue
    }
    if (!agentMatches(rule, options.agentName)) {
      buckets.dropped.push(rule)
      continue
    }
    if (hasTrigger(rule) && options.registerTtsr(rule)) {
      buckets.ttsrRules.push(rule)
      continue
    }
    if (rule.alwaysApply === true) {
      buckets.alwaysApplyRules.push(rule)
      continue
    }
    if (rule.description !== undefined) {
      buckets.rulebookRules.push(rule)
      continue
    }
    buckets.dropped.push(rule)
  }

  return buckets
}
