/**
 * Injection and reminder rendering.
 *
 * An interrupt aborts the violating turn and re-queues a message that carries
 * the rule body back to the model; a non-interrupting tool match instead folds
 * a reminder into the tool's own result, so the model sees it at the point the
 * violation happened without a second turn.
 */

import type { Rule } from './rule.ts'

/** Escape the characters that would break out of a template attribute. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** One rule rendered into an injection or reminder block. */
export interface RenderedViolation {
  rule: Rule
  /** File path the violation was attributed to, when known. */
  path?: string
}

/**
 * Render the abort-and-retry message body.
 * @param violations - deduplicated rules that interrupted the turn.
 */
export function renderInterrupt(violations: readonly RenderedViolation[]): string {
  return violations
    .map(({ rule, path }) =>
      `<system-interrupt reason="rule_violation" rule="${escapeAttribute(rule.name)}" path="${escapeAttribute(path ?? '')}">\n${rule.content}\n</system-interrupt>`,
    )
    .join('\n\n')
}

/**
 * Render the in-band reminder folded into a tool result.
 * @param violations - deduplicated rules matched on that tool call.
 */
export function renderReminder(violations: readonly RenderedViolation[]): string {
  return violations
    .map(({ rule, path }) =>
      `<system-reminder reason="rule_violation" rule="${escapeAttribute(rule.name)}" path="${escapeAttribute(path ?? '')}">\n${rule.content}\n</system-reminder>`,
    )
    .join('\n\n')
}

/**
 * Deduplicate a violation batch by rule name, keeping the first occurrence.
 * @param violations - rules matched within one delivery window.
 */
export function dedupeViolations(violations: readonly RenderedViolation[]): RenderedViolation[] {
  const seen = new Set<string>()
  const unique: RenderedViolation[] = []
  for (const violation of violations) {
    if (seen.has(violation.rule.name)) continue
    seen.add(violation.rule.name)
    unique.push(violation)
  }
  return unique
}
