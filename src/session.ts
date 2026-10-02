/**
 * Per-agent rule coordination.
 *
 * Owns everything that is true for one session: the bucketed rule set, the
 * addressable snapshot, the streaming buffers, the pending injections, and the
 * retry that resumes a turn an interrupt aborted.
 */

import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isAbsolute, relative as relativePath } from 'node:path'
import { recordTrigger } from './audit.ts'
import { astMatch } from './ast.ts'
import { dedupeViolations, renderInterrupt, renderReminder, type RenderedViolation } from './inject.ts'
import type { InterruptMode, Rule } from './rule.ts'
import { interrupts, TtsrManager, type MatchContext, type MatchSource } from './ttsr.ts'
import { RULE_MESSAGE_SOURCE } from './source.ts'
import type { RuleSnapshot } from './tool.ts'

/** How much buffered text a stream keeps for cross-chunk matching. */
const BUFFER_LIMIT = 64 * 1024

/** Tools whose arguments carry the source a tool call would write. */
const SOURCE_BEARING_TOOLS: Readonly<Record<string, string[]>> = {
  write: ['content'],
  edit: ['new_string'],
  str_replace: ['new_string'],
  multi_edit: ['edits'],
}

/** What one finalized tool call violates, split by what happens next. */
export interface ToolViolations {
  /** Rules whose interrupt mode covers the tool surface; the call is denied. */
  blocking: Rule[]
  /** Rules that only warn, already claimed and bucketed for their result. */
  warnings: Rule[]
}

/** One violation batch waiting for its delivery moment. */
interface PendingInjection {
  violations: RenderedViolation[]
}

/** Everything the runtime needs to serve one agent. */
export class RuleSession {
  readonly #ttsr: TtsrManager
  readonly #snapshot: RuleSnapshot
  readonly #buffers = new Map<string, string>()
  readonly #toolInjections = new Map<string, PendingInjection>()
  #prosePending: PendingInjection | undefined
  /** Turn whose generation was already aborted, so one violation aborts once. */
  #abortedTurn: number | undefined
  #turn = 0

  /**
   * @param rules - rules already bucketed for this agent.
   * @param addressable - rules reachable by name, rulebook plus always-apply plus TTSR.
   * @param ttsr - the shared streaming-rule manager for this session.
   * @param cwd - the session workspace root, used to resolve path globs.
   * @param defaultInterruptMode - live default mode, read per violation so a
   *   toggle applies to the next step instead of the next restart.
   */
  constructor(
    readonly rules: readonly Rule[],
    addressable: readonly Rule[],
    /** Every discovered rule, including ones that joined no bucket. */
    readonly discovered: readonly Rule[],
    /** Why a discovered rule joined no bucket, keyed by name. */
    readonly inactive: ReadonlyMap<string, string>,
    ttsr: TtsrManager,
    private readonly cwd: string,
    private readonly defaultInterruptMode: () => InterruptMode,
  ) {
    this.#ttsr = ttsr
    this.#snapshot = {
      rules: new Map(addressable.map(rule => [rule.name, rule])),
      all: discovered,
      inactive,
    }
  }

  /**
   * Expand tool-supplied paths into the forms a rule glob may be written in.
   *
   * A rule declares its globs the way a human writes them — a `Docs` prefix
   * followed by a recursive wildcard — but a tool call may name the same file
   * absolutely. Matching only the literal string would leave every path rule
   * silently inert under absolute paths, so each path contributes itself, its
   * workspace-relative form, and its basename.
   */
  pathCandidates(paths: readonly string[]): string[] {
    const expanded = new Set<string>()
    for (const path of paths) {
      expanded.add(path)
      if (isAbsolute(path)) {
        const relative = relativePath(this.cwd, path)
        if (relative !== '' && !relative.startsWith('..')) expanded.add(relative)
      }
      const basename = path.split('/').pop()
      if (basename !== undefined && basename !== '') expanded.add(basename)
    }
    return [...expanded]
  }

  /** The addressable `rule://` snapshot for this session. */
  get snapshot(): RuleSnapshot {
    return this.#snapshot
  }

  /** The streaming-rule manager backing this session. */
  get manager(): TtsrManager {
    return this.#ttsr
  }

  /** Open a new turn: drop buffers and refuse a stale retry from the last one. */
  beginTurn(turn: number): void {
    this.#turn = turn
    this.#buffers.clear()
    this.#toolInjections.clear()
    this.#prosePending = undefined
    this.#abortedTurn = undefined
  }

  /** Count a completed turn for the `after-gap` repeat policy. */
  endTurn(): void {
    this.#ttsr.countTurn()
  }

  /**
   * Match one stream delta and act on the result.
   *
   * A match that may interrupt aborts the turn immediately and schedules the
   * retry; a prose match without interruption is queued for the end of the
   * assistant message; a tool match is bucketed against its tool call id so the
   * reminder lands on that call's own result.
   *
   * @param agent - the agent producing the stream.
   * @param source - which stream surface the delta came from.
   * @param delta - the newly produced text.
   * @param context - tool name and candidate paths, when known.
   */
  observeDelta(agent: Agent, source: MatchSource, delta: string, context: Omit<MatchContext, 'source'> = {}): void {
    if (delta === '') return
    const key = this.#bufferKey(source, context)
    const buffered = `${this.#buffers.get(key) ?? ''}${delta}`.slice(-BUFFER_LIMIT)
    this.#buffers.set(key, buffered)

    const matched = this.#ttsr.checkDelta(buffered, { source, ...context })
    if (matched.length === 0) return

    const claimed = matched.filter(rule => this.#ttsr.claim(rule))
    if (claimed.length === 0) return

    for (const rule of claimed) recordTrigger(rule.name)
    const violations: RenderedViolation[] = claimed.map(rule => ({ rule, path: context.paths?.[0] }))
    const interrupting = claimed.some(rule => interrupts(this.#effectiveMode(rule), source))
    if (interrupting && source !== 'tool') {
      this.#abortAndSchedule(agent, violations)
      return
    }
    if (source === 'tool' && context.callId !== undefined) {
      const existing = this.#toolInjections.get(context.callId)
      this.#toolInjections.set(context.callId, {
        violations: existing === undefined ? violations : dedupeViolations([...existing.violations, ...violations]),
      })
      return
    }
    this.#prosePending = {
      violations: dedupeViolations([...(this.#prosePending?.violations ?? []), ...violations]),
    }
  }

  /**
   * Re-check a finalized tool call against both trigger families.
   *
   * Regex triggers run against the reconstructed source rather than the wire
   * delta so a partially streamed payload cannot split a construct, and AST
   * triggers apply only where a candidate path yields a grammar.
   *
   * The two outcomes are kept apart. A rule whose interrupt mode covers the
   * tool surface blocks the call, and a block spends nothing on the repeat
   * ledger: refusing a write is not a delivery, and a one-shot rule must not
   * turn into a wall that opens on the second attempt. A rule that only warns
   * is claimed and bucketed for the reminder channel instead, which is the
   * designed role of a path-scoped rule whose body merely injects a contract.
   */
  toolViolations(snapshot: string, context: MatchContext): ToolViolations {
    const matched = this.#ttsr.checkSnapshot(snapshot, context)
    const path = context.paths?.[0]
    if (path !== undefined) {
      for (const candidate of this.#ttsr.astCandidates(snapshot, context)) {
        if (astMatch(snapshot, path, candidate.patterns)) matched.push(candidate.rule)
      }
    }

    const unique = matched.filter((rule, index) => matched.indexOf(rule) === index)
    const blocking = unique.filter(rule => interrupts(this.#effectiveMode(rule), 'tool'))
    const warnings = unique.filter(rule => !interrupts(this.#effectiveMode(rule), 'tool'))

    const claimed: RenderedViolation[] = []
    for (const rule of warnings) {
      if (!this.#ttsr.claim(rule)) continue
      recordTrigger(rule.name)
      claimed.push({ rule, path })
    }
    for (const rule of blocking) recordTrigger(rule.name)
    if (claimed.length > 0 && context.callId !== undefined) {
      const existing = this.#toolInjections.get(context.callId)
      this.#toolInjections.set(context.callId, {
        violations: existing === undefined ? claimed : dedupeViolations([...existing.violations, ...claimed]),
      })
    }

    return { blocking, warnings: claimed.map(entry => entry.rule) }
  }

  /**
   * Collect the question rules worth asking about one completed output.
   *
   * Judged rules never interrupt: the question is answered after the output is
   * complete, and any `condition` or `astCondition` on the same rule only
   * pre-filters which outputs are worth the cost of asking.
   */
  judged(content: string, context: MatchContext): Rule[] {
    return this.#ttsr.judgedCandidates(content, context)
  }

  /**
   * Deliver judged warnings as non-waking context.
   *
   * A verdict arrives after the output it judges, so the warning joins the next
   * step rather than interrupting anything.
   *
   * No `claim` here: the rules were already claimed by `judgedCandidates` when
   * they were proposed to the judge, and claiming a second time would report
   * them ineligible and silently drop the warning they paid for.
   */
  deliverWarnings(agent: Agent, rules: readonly Rule[]): void {
    if (rules.length === 0) return
    for (const rule of rules) recordTrigger(rule.name)
    agent.inject(reminderMessage(renderReminder(rules.map(rule => ({ rule })))))
  }

  /**
   * Abort the active turn and hand the rule body back to the model.
   *
   * The cancellation and the retry are issued together: cancelling stops the
   * violating stream, and steering queues the rule for the turn the loop runs
   * next. Steering must be synchronous — a timer would let a one-shot run reach
   * idle and exit before the retry was ever queued, losing the interruption.
   * `keepInbox` is what makes the queued message survive the abort itself.
   */
  #abortAndSchedule(agent: Agent, violations: RenderedViolation[]): void {
    if (this.#abortedTurn === this.#turn) return
    this.#abortedTurn = this.#turn
    const names = violations.map(violation => violation.rule.name).join(', ')

    agent.cancel({ kind: 'hook', reason: `TTSR rule violation: ${names}` }, { keepInbox: true })
    agent.steer(injectionMessage(renderInterrupt(violations)))
  }

  /** Deliver the pending prose reminder after a completed assistant message. */
  flushProsePending(agent: Agent): void {
    const pending = this.#prosePending
    if (pending === undefined) return
    this.#prosePending = undefined
    agent.inject(reminderMessage(renderReminder(pending.violations)))
  }

  /**
   * Prepend the pending reminder to one tool call's result.
   *
   * The tool's own content is preserved verbatim and the reminder is inserted
   * ahead of it as a leading text block, so the violation is the first thing
   * the model reads about that call.
   *
   * @param callId - the matched tool call identity.
   * @returns the reminder text, or undefined when nothing is pending.
   */
  takeToolReminder(callId: string): string | undefined {
    const pending = this.#toolInjections.get(callId)
    if (pending === undefined) return undefined
    this.#toolInjections.delete(callId)
    return renderReminder(pending.violations)
  }

  /** Effective interrupt mode for one rule, falling back to the session default. */
  #effectiveMode(rule: Rule): InterruptMode {
    return rule.interruptMode ?? this.defaultInterruptMode()
  }

  /**
   * Buffer key isolating one stream surface and tool call.
   *
   * The call id belongs in the key because that is what the reminder is
   * attributed to. Two calls of one tool stream their arguments back to back,
   * and a buffer shared between them lets a rule match across the seam between
   * two unrelated writes — attributing the hit to the current call and
   * spending a one-shot rule's single budget on a phrase present in neither.
   *
   * Switching call id also releases the previous buffer for that tool: the call
   * it belonged to is over and no later delta can extend it, so keeping it
   * would only hold text nothing can match again. Other tools keep their own
   * buffers, so interleaved tools are unaffected; and a buffer dropped this way
   * only weakens the streaming warning, since the finalized call is re-checked
   * against the reconstructed snapshot in {@link toolViolations}.
   */
  #bufferKey(source: MatchSource, context: Omit<MatchContext, 'source'>): string {
    if (source !== 'tool') return source
    const key = `tool:${context.tool ?? '*'}:${context.callId ?? '*'}`
    const prefix = key.slice(0, key.lastIndexOf(':') + 1)
    for (const buffered of this.#buffers.keys()) {
      // Never the key about to be read: that is the buffer this delta extends.
      if (buffered !== key && buffered.startsWith(prefix)) this.#buffers.delete(buffered)
    }
    return key
  }
}

/** Build the steering message that resumes an interrupted turn. */
function injectionMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: RULE_MESSAGE_SOURCE,
  })
}

/** Build the non-waking context message carrying a prose reminder. */
function reminderMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: RULE_MESSAGE_SOURCE,
  })
}

/** Reconstruct the source a tool call would write, from its arguments. */
export function toolSnapshot(name: string, args: Record<string, unknown>): string {
  const fields = SOURCE_BEARING_TOOLS[name]
  if (fields === undefined) return JSON.stringify(args)
  const parts: string[] = []
  for (const field of fields) {
    const value = args[field]
    if (typeof value === 'string') parts.push(value)
    else if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== null && typeof entry === 'object' && 'new_string' in entry && typeof entry.new_string === 'string') {
          parts.push(entry.new_string)
        }
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : JSON.stringify(args)
}

/** Candidate file paths a tool call touches, scanned from its arguments. */
export function toolPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const key of ['file_path', 'path', 'paths', 'filePath']) {
    const value = args[key]
    if (typeof value === 'string') paths.push(value)
    else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') paths.push(entry)
      }
    }
  }
  return paths
}
