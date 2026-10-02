/**
 * The bundled rule catalog, as the browser half sees it.
 *
 * The page needs the rule names and their descriptions to draw a toggle list,
 * and it cannot ask the Host for them: the discovery report would have to cross
 * a generated Remote contract. Baking the catalog in keeps the client half free
 * of dsh client dependencies and lets the page render before discovery has run.
 *
 * Regenerate with `pnpm run embed:rules`; this file is derived from the same
 * Markdown as the Host's rules.
 */

import { BUILTIN_RULE_SOURCES } from './generated/builtin-rules.ts'

/** One bundled rule as the settings page lists it. */
export interface BundledRuleSummary {
  name: string
  description: string
}

/** Bundled rules with their descriptions, in load order. */
export const BUNDLED_RULES: readonly BundledRuleSummary[] = Object.entries(BUILTIN_RULE_SOURCES).map(
  ([file, content]) => ({
    name: file.replace(/\.md$/, ''),
    description: /^description:\s*(.*)$/m.exec(content)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '',
  }),
)
