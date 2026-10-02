/**
 * Judge for `question` rules.
 *
 * A question rule is answered after the output it judges, never while it
 * streams, so it can only warn. Every question sharing one output is asked in a
 * single request, which is what keeps judging an order of magnitude cheaper
 * than asking per rule.
 *
 * OMP resolves its judge through a probabilistic `noul` verdict with a 0.7
 * threshold. A generic dsh deployment has no such role, so this asks the
 * configured route for an explicit yes/no per question and treats anything
 * unparseable as "not violated" — a judge that cannot answer must not invent a
 * violation.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Rule } from './rule.ts'

/** Answer format the judge is asked to produce. */
const JUDGE_INSTRUCTIONS = `You verify output against project rules.

For each numbered rule, answer YES if the output violates that rule, NO if it does not.
Answer with exactly one line per rule, formatted "<number>: YES" or "<number>: NO".
Add no other text.`

/** Bound on the judged output, so one request cannot exceed the context window. */
const OUTPUT_LIMIT = 8000

/**
 * Deadline for one judge request.
 *
 * `ctx.llm.stream` carries no deadline of its own — the host's only time bound
 * is the retry backoff, which hooks the agent's failed-step extension point and
 * so never applies to this direct call — and the judged output is delivered
 * fire-and-forget from an `assistant/message` handler. Without a deadline a
 * provider that stalls mid-stream leaves this `for await` pending forever, and
 * the next assistant message starts another one, so pending requests accumulate
 * without bound. 60s is generous for a numbered yes/no answer while still
 * bounding the pile-up: a slower route is treated as "cannot answer", which the
 * parse contract already maps to "not violated".
 */
const JUDGE_TIMEOUT_MS = 60_000

/** The judge boundary, narrow enough to fake in tests. */
export interface Judge {
  /**
   * Ask every question about one completed output.
   *
   * Resolves within a bounded time whether or not `signal` is supplied: the
   * request carries its own deadline, and a stalled provider settles as a
   * rejection rather than an eternally pending promise.
   *
   * @param output - the completed text under judgement.
   * @param rules - question rules whose scope and prefilter admitted this output.
   * @param signal - caller cancellation, optional; the deadline applies anyway.
   * @returns the rules the judge flagged, deduplicated.
   */
  ask(rules: readonly Rule[], output: string, signal?: AbortSignal): Promise<Rule[]>
}

/** Route and model the judge calls; both come from plugin configuration. */
export interface JudgeRoute {
  provider: string
  model: string
}

/** Build the judge prompt for one output and its candidate rules. */
function buildPrompt(rules: readonly Rule[], output: string): string {
  const questions = rules.map((rule, index) => `${index + 1}. ${rule.question ?? ''}`).join('\n')
  const body = output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n[truncated]` : output
  return `Rules:\n${questions}\n\nOutput:\n${body}\n\nAnswer every rule number.`
}

/**
 * Parse the numbered answer block into the one-based indices answered YES.
 *
 * @param answer - the judge's raw text.
 * @param questionCount - how many questions were asked; anything outside that
 * range is a hallucinated line and is ignored rather than mapped onto a rule.
 */
export function parseVerdicts(answer: string, questionCount: number): number[] {
  const flagged: number[] = []
  for (const line of answer.split('\n')) {
    const matched = /^\s*(\d+)\s*:\s*(yes|no)\b/i.exec(line)
    if (matched === null) continue
    if (matched[2]?.toLowerCase() !== 'yes') continue
    const index = Number(matched[1])
    if (Number.isInteger(index) && index >= 1 && index <= questionCount) flagged.push(index)
  }
  return flagged
}

/**
 * Collect the concatenated text of one streamed model call.
 *
 * Two bounds apply, because aborting a request and settling a promise are
 * different guarantees. The deadline is handed to the adapter as `signal` so
 * the provider call is actually cancelled, and the consumption is raced against
 * it so `ask` still settles when an adapter's iterator never observes the abort
 * — which is what stops pending judge requests from accumulating one per
 * assistant message. A caller's `signal` is combined rather than replaced, so
 * explicit cancellation keeps applying and still wins the reported reason.
 */
async function collectText(ctx: Context, route: JudgeRoute, prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const deadline = AbortSignal.timeout(timeoutMs)
  const bounded = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system: JUDGE_INSTRUCTIONS,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    signal: bounded,
  })

  const consumed = (async () => {
    let text = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    // A stream that ends early because it was aborted carries only part of the
    // answer; treating that as a verdict would let a half-read line flag a rule.
    if (bounded.aborted) throw new Error('judge request exceeded its deadline')
    return text
  })()

  let onAbort: (() => void) | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new Error('judge request exceeded its deadline'))
    if (bounded.aborted) fail()
    else bounded.addEventListener('abort', fail, { once: true })
    onAbort = fail
  })

  try {
    return await Promise.race([consumed, expiry])
  } finally {
    // Whichever side lost the race would otherwise leave a listener behind or
    // surface an unhandled rejection once the aborted stream finally unwinds.
    if (onAbort !== undefined) bounded.removeEventListener('abort', onAbort)
    void consumed.catch(() => undefined)
  }
}

/**
 * Build a judge bound to one configured route.
 *
 * @param ctx - host context carrying the LLM runtime.
 * @param route - provider and model to call; absent when judging is disabled.
 * @param timeoutMs - deadline for one request; the production default bounds an
 *   unbounded `ask`, and tests shorten it to keep a stall observable.
 */
export function createJudge(ctx: Context, route: JudgeRoute | undefined, timeoutMs: number = JUDGE_TIMEOUT_MS): Judge {
  return {
    async ask(rules, output, signal) {
      if (route === undefined || rules.length === 0) return []
      const answer = await collectText(ctx, route, buildPrompt(rules, output), timeoutMs, signal)
      const flagged = new Set(parseVerdicts(answer, rules.length))
      return rules.filter((rule, index) => flagged.has(index + 1))
    },
  }
}
