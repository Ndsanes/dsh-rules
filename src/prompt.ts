/**
 * System-prompt rendering for the two injected rule layers.
 *
 * Always-apply bodies render first inside `<generic-rules>`; the rulebook
 * renders as a name/description index inside `<domain-rules>`, because a rule
 * body is fetched on demand and must not occupy resident context.
 */

import type { Rule } from './rule.ts'

/** Escape the characters that would break out of an XML-ish attribute. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Render the always-apply layer.
 * @param rules - always-apply rules whose bodies are not already in the prompt.
 */
export function renderAlwaysApply(rules: readonly Rule[]): string {
  if (rules.length === 0) return ''
  const bodies = rules.map(rule => `<rule name="${escapeAttribute(rule.name)}">\n${rule.content}\n</rule>`)
  return `<generic-rules>\n${bodies.join('\n\n')}\n</generic-rules>`
}

/**
 * Render the rulebook index.
 *
 * Each line carries the name, the globs it is scoped to, and the description;
 * the model resolves the body by name through the `rule` tool.
 */
export function renderRulebook(rules: readonly Rule[]): string {
  if (rules.length === 0) return ''
  const lines = rules.map(rule => {
    const globs = rule.globs !== undefined && rule.globs.length > 0 ? ` (${rule.globs.join(', ')})` : ''
    return `- ${rule.name}${globs}: ${rule.description ?? ''}`
  })
  return [
    '<domain-rules>',
    ...lines,
    'Before acting on a rule subject, load its full text: call the `rule` tool',
    'with that rule name (addressed as rule://<name>). Its body is not in context until you load it.',
    // The write path exists but nothing reaches it unless the model is told the
    // rules are its to extend. Without this the tool's `create` action is
    // unreachable in practice: the model can read rules and obey them, and has
    // no reason to believe a correction belongs in one.
    'When the user states a constraint that will still hold next week — how they',
    'want something done, what must never happen, a convention this project follows',
    '— write it down instead of only obeying it this once. Call the `rule` tool with',
    'action "create", a name, a `frontmatter` block and a `body`, then tell the user',
    'where it was written so they can review, edit, or delete it.',
    'Do not create a rule that only restates what is already in this prompt.',
    '</domain-rules>',
  ].join('\n')
}

/**
 * Drop always-apply rules whose body another kept rule already carries.
 *
 * Two providers can surface the same file under different names — a project
 * `.omp/rules/style.md` and the user's `~/.omp/agent/rules/style.md` — and both
 * survive name deduplication, so the identical body would otherwise be injected
 * twice and occupy resident context twice.
 *
 * This used to be a cross-source dedupe against AGENTS.md and other prompt
 * sections. That is not reachable from here: `PromptSection.text` receives an
 * `AssembleContext`, and that context carries only a scope key and a signal —
 * a section provider never sees the text of the sections around it. A helper
 * that was always handed an empty list looked like it prevented double
 * injection while preventing nothing, so it is gone rather than left as
 * decoration.
 *
 * @param rules - always-apply rules in the order they would be rendered.
 * @returns the rules to render, first occurrence of each body wins.
 */
export function dedupeDuplicateBodies(rules: readonly Rule[]): Rule[] {
  const seen = new Set<string>()
  return rules.filter(rule => {
    const body = rule.content.trim()
    if (body === '') return true
    if (seen.has(body)) return false
    seen.add(body)
    return true
  })
}
