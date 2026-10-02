/**
 * The model-facing `rule` tool: the `rule://<name>` addressing surface, plus
 * the management surface for bundled rules.
 *
 * dsh has no internal-URL protocol registry, so the addressable form lives in
 * the tool contract instead: the prompt advertises `rule://<name>` and this
 * tool resolves that exact name against the rulebook, always-apply, and
 * registered-TTSR snapshot, returning the rule body as Markdown.
 *
 * `list` reports which rules are in force and why an inactive one is not, and
 * `enable`/`disable` turn a bundled rule off or on. Only bundled rules are
 * toggleable: a user or project rule is governed by its file, and editing that
 * file behind the user's back would be worse than saying so.
 */

import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Rule } from './rule.ts'

const TOOL_DESCRIPTION = `Load the full text of one rule, list the rules in force, or turn a bundled rule off.

Actions:
- load (default): read one rule's body. Names come from the domain-rules listing
  in your system prompt. A rule's body is not in context until you load it.
- list: report every rule in this session, whether it is in force, and why not.
- enable / disable: turn one bundled rule off or on. Applies to the next step.

Parameters:
- action: one of load, list, enable, disable. Defaults to load.
- name: exact rule name (addressed as rule://<name>). Required for load,
  enable, and disable; ignored by list.`

/** One addressable snapshot for a single agent. */
export interface RuleSnapshot {
  /** Rulebook, always-apply, and registered-TTSR rules, keyed by name. */
  readonly rules: ReadonlyMap<string, Rule>
  /** Every discovered rule, including the ones that joined no bucket. */
  readonly all: readonly Rule[]
  /** Why an inactive rule is inactive, keyed by rule name. */
  readonly inactive: ReadonlyMap<string, string>
}

/**
 * Why a lookup did or did not produce a snapshot.
 *
 * `building` is its own state on purpose: it means discovery for this session
 * is still in flight, which is what a session created before the rules layer
 * mounted looks like on its first turn. Reporting that as "no rules" would be
 * indistinguishable from a broken rule directory.
 */
export type RuleLookup =
  | { state: 'ready'; snapshot: RuleSnapshot }
  | { state: 'building' }
  | { state: 'no-agent' }

/** What the tool needs in order to change a rule's state. */
export interface RuleToggle {
  /**
   * Persist a change to the disabled set.
   *
   * The intent is resolved against the set as the settings service reports it at
   * write time, not against the plugin's own copy: two toggles in one turn both
   * read the same stale list, and whichever wrote last would erase the other.
   *
   * @returns the guidance to show when the change could not be persisted.
   */
  setDisabled: (intent: (current: readonly string[]) => readonly string[]) => Promise<{ ok: true } | { ok: false; guidance: string }>
  /** Bundled rule names that may be toggled, in load order. */
  readonly toggleable: readonly string[]
  /** The disabled set as configured right now. */
  readonly disabled: readonly string[]
}

/**
 * Reason codes rendered as prose for the model.
 *
 * The Host sends codes so the browser can localize them; this tool's output is
 * read by a model, so it spells them out instead of leaking the codes.
 */
const REASON_PHRASE: Readonly<Record<string, string>> = {
  disabled: 'listed in ttsr.disabledRules',
  'builtins-off': 'bundled rules are disabled by ttsr.builtinRules',
  'agent-filter': 'its agents filter does not match this session',
  'no-trigger': 'it declares no trigger, no alwaysApply, and no description',
  shadowed: 'shadowed by a higher-priority rule of the same name',
}

/** Render the in-force list, marking what is inactive and why. */
function renderList(snapshot: RuleSnapshot, toggleable: readonly string[]): string {
  const lines = snapshot.all
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(rule => {
      const state = (snapshot.rules.has(rule.name) ? 'on' : 'off').padEnd(4)
      const origin = rule._source.provider === 'builtin-defaults' ? ' [bundled]' : ''
      const code = snapshot.inactive.get(rule.name)
      const reason = code === undefined ? '' : ` (inactive: ${REASON_PHRASE[code] ?? code})`
      const summary = rule.description ?? ''
      return `${state} ${rule.name}${origin}${reason}${summary === '' ? '' : ` — ${summary}`}`
    })

  const toggleHint = toggleable.length === 0
    ? 'No bundled rules are toggleable in this deployment.'
    : `Toggle a bundled rule with action "enable" or "disable" and name="${toggleable[0]}" (${toggleable.length} bundled).`
  return [`${lines.length} rule(s) discovered:`, ...lines, '', toggleHint].join('\n')
}

/**
 * Build the `rule` tool bound to one agent's rule snapshot.
 *
 * @param registerTool - host tool registration, returning its disposer.
 * @param resolve - per-call snapshot lookup for the calling agent.
 * @param toggle - state change surface for bundled rules.
 * An unknown name reports the available names, matching OMP's `rule://`
 * failure message.
 */
export function createRuleTool(
  registerTool: (tool: ToolDefinition) => () => void,
  resolve: (exec: ToolRunContext) => RuleLookup,
  toggle: () => RuleToggle,
): { name: string; dispose: () => void } {
  const dispose = registerTool(defineTool({
    name: 'rule',
    description: TOOL_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        description: 'load (default), list, enable, or disable.',
      },
      name: {
        type: 'string',
        description: 'Exact rule name from the listing (addressed as rule://<name>).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec: ToolRunContext): Promise<string> => {
      const lookup = resolve(exec)
      const name = args.name ?? ''
      const action = args.action ?? 'load'

      if (lookup.state === 'no-agent') {
        return `Cannot ${action} rule "${name}": this tool call is not bound to a session, so no rules are in force.`
      }
      if (lookup.state === 'building') {
        return `Rules are not available yet: this session's rules are still being discovered. ` +
          'Call the rule tool again on the next step. A session created before the rules layer was mounted ' +
          'loads its rules on first use rather than none at all.'
      }

      const snapshot = lookup.snapshot

      if (action === 'list') {
        return renderList(snapshot, toggle().toggleable)
      }

      if (action === 'enable' || action === 'disable') {
        const control = toggle()
        if (!control.toggleable.includes(name)) {
          return `"${name}" is not a bundled rule, so it cannot be toggled here. ` +
            `Bundled rules: ${control.toggleable.join(', ') || 'none'}. ` +
            'User and project rules are governed by their own files; edit that file to change them.'
        }

        // Compose against whatever is actually stored, not against
        // `control.disabled`, which is the plugin's view and may be one write
        // behind a sibling call in the same turn.
        const written = await control.setDisabled(current =>
          action === 'disable'
            ? [...new Set([...current, name])]
            : current.filter(entry => entry !== name))
        if (!written.ok) return written.guidance
        return action === 'disable'
          ? `Rule "${name}" is now disabled. It stops applying on the next step.`
          : `Rule "${name}" is now enabled. It applies from the next step.`
      }

      const rule = snapshot.rules.get(name)
      if (rule === undefined) {
        const available = [...snapshot.rules.keys()].sort()
        const reason = snapshot.inactive.get(name)
        if (reason !== undefined) {
          return `Rule "${name}" is known but not in force: ${reason}.`
        }
        return available.length === 0
          ? `Unknown rule "${name}". No rules are addressable in this session.`
          : `Unknown rule "${name}". Available rules: ${available.join(', ')}`
      }
      return rule.content
    },
  }))

  return { name: 'rule', dispose }
}
