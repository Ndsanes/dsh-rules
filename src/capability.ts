/**
 * Capability assembly for the `rules` capability.
 *
 * Providers arrive in priority order and identity is the rule name alone, so
 * merging is a first-wins pass: the first rule claiming a name is kept and
 * every later rule with the same name is marked `_shadowed` and excluded from
 * the usable items.
 */

import type { ProviderResult } from './discovery.ts'
import type { Rule } from './rule.ts'

/** Merged view of one capability load. */
export interface CapabilityResult {
  /** Winning rules, in first-seen order. */
  items: Rule[]
  /** Every discovered rule, with losers marked `_shadowed`. */
  all: Rule[]
  /** Discovery warnings collected across providers. */
  warnings: string[]
}

/**
 * Merge provider results, keeping the first rule for each name.
 *
 * Shadowing is decided from the names in this pass, not from a `_shadowed` flag
 * left on the rule by an earlier one: the flag is written onto objects the
 * caller still owns, so a second load over the same objects — a re-discovery, or
 * the same batch in another order — would read the stale flag and drop rules
 * that actually won this time.
 *
 * @param results - provider contributions already ordered by descending priority.
 */
export function loadCapability(results: readonly ProviderResult[]): CapabilityResult {
  const all: Rule[] = []
  const warnings: string[] = []
  const winners = new Map<string, Rule>()
  const shadowed = new Set<Rule>()

  for (const result of results) {
    warnings.push(...result.warnings)
    for (const rule of result.rules) {
      all.push(rule)
      if (winners.has(rule.name)) {
        rule._shadowed = true
        shadowed.add(rule)
        continue
      }
      winners.set(rule.name, rule)
      delete rule._shadowed
    }
  }

  return { items: all.filter(rule => !shadowed.has(rule)), all, warnings }
}
