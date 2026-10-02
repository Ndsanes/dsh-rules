/**
 * Embedded `builtin-defaults` rules.
 *
 * The Markdown under `src/builtin-rules/` is the source of truth and is
 * generated into a module by `scripts/embed-builtin-rules.mts`, so the shipped
 * bundle needs no asset loader. Every rule carries `interruptMode: never` or a
 * path-scoped trigger, which is the point: they inform the model without
 * turning into walls. `ttsr.builtinRules: false` or `ttsr.disabledRules`
 * retires any of them.
 */

import { BUILTIN_RULE_SOURCES } from './generated/builtin-rules.ts'
import { buildRuleFromMarkdown, type Rule } from './rule.ts'

/** The synthetic path a bundled rule reports, matching OMP's own convention. */
function bundledPath(name: string): string {
  return `builtin-defaults:${name}.md`
}

/**
 * Build the bundled rule set.
 *
 * Names are the file basenames, so a user or project rule with the same name
 * shadows the bundled copy at the capability layer, exactly as it does in OMP.
 */
export function builtinRules(): Rule[] {
  return Object.entries(BUILTIN_RULE_SOURCES).map(([file, content]) => {
    const name = file.replace(/\.md$/, '')
    return buildRuleFromMarkdown({
      name,
      path: bundledPath(name),
      content,
      source: { provider: 'builtin-defaults', path: bundledPath(name), priority: 1 },
    })
  })
}

/** Name of every bundled rule, in load order. */
export function builtinRuleNames(): string[] {
  return Object.keys(BUILTIN_RULE_SOURCES).map(file => file.replace(/\.md$/, ''))
}
