/**
 * Per-agent rule session lookup.
 *
 * `agent/created` is the warm path, but it is not the only one: a plugin can
 * mount into a harness whose agents already exist, and those agents must still
 * get their rules rather than silently running ungoverned. Every surface that
 * can name an agent therefore asks this store, which builds a session on first
 * use and remembers the result for the agent's lifetime.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RuleSession } from './session.ts'

/** Builds one agent's rule session; discovery reads the filesystem. */
export type SessionBuilder = (agent: Agent) => Promise<RuleSession>

/** Store of rule sessions, built eagerly where possible and lazily otherwise. */
export class RuleSessionStore {
  readonly #agents = new Map<string, Agent>()
  readonly #resolved = new Map<string, RuleSession>()
  readonly #pending = new Map<string, Promise<RuleSession>>()

  constructor(private readonly build: SessionBuilder) {}

  /** Remember an agent so a later id-only lookup can find it. */
  note(agent: Agent): void {
    this.#agents.set(agent.id, agent)
  }

  /** The agent behind a session id, once any surface has named it. */
  agentFor(id: SessionId): Agent | undefined {
    return this.#agents.get(id)
  }

  /**
   * The finished session, starting the build when there is none yet.
   * @returns the session, or undefined while the first build is still running.
   */
  get(agent: Agent | undefined): RuleSession | undefined {
    if (agent === undefined) return undefined
    this.note(agent)

    const ready = this.#resolved.get(agent.id)
    if (ready !== undefined) return ready

    // `ensure` re-throws so the next surface gets a fresh attempt, which leaves
    // this rejection with nobody to handle it. Node's default
    // `--unhandled-rejections=throw` would turn one unreadable rule file into an
    // uncaught exception that kills the whole dsh process, so the failure is
    // swallowed here and surfaces on the next synchronous surface as another
    // build attempt instead.
    void this.ensure(agent).catch(() => {})
    return undefined
  }

  /** The finished session for a session id, or undefined while it builds. */
  getById(id: SessionId): RuleSession | undefined {
    return this.get(this.#agents.get(id))
  }

  /** Await the session, building it on first use. */
  async ready(agent: Agent | undefined): Promise<RuleSession | undefined> {
    if (agent === undefined) return undefined
    this.note(agent)

    const ready = this.#resolved.get(agent.id)
    return ready ?? this.ensure(agent)
  }

  /** Start a build unless one is already running or finished. */
  ensure(agent: Agent): Promise<RuleSession> {
    const finished = this.#resolved.get(agent.id)
    if (finished !== undefined) return Promise.resolve(finished)

    const running = this.#pending.get(agent.id)
    if (running !== undefined) return running

    // Identity, not a generation counter: dropping a pending build has to be
    // per-agent, because `release` and `invalidate` discard different scopes —
    // a global counter would let one agent leaving evict another agent's
    // perfectly good in-flight result.
    let pending!: Promise<RuleSession>
    pending = this.build(agent)
      .then(session => {
        // An `invalidate` or `release` cleared this entry while the build was
        // still walking the filesystem, so a newer build owns the slot now.
        // Committing here would reinstate the pre-change rule set — exactly the
        // staleness the invalidation exists to prevent. The caller that awaits
        // this promise still gets its session; only the store's memory of it is
        // dropped.
        if (this.#pending.get(agent.id) !== pending) return session
        this.#resolved.set(agent.id, session)
        this.#pending.delete(agent.id)
        return session
      })
      .catch((error: unknown) => {
        // Drop the rejection so the next surface to ask gets a fresh attempt
        // instead of inheriting one failed discovery forever. The identity check
        // keeps this from evicting the newer build that replaced this one.
        if (this.#pending.get(agent.id) === pending) this.#pending.delete(agent.id)
        throw error
      })
    this.#pending.set(agent.id, pending)
    return pending
  }

  /**
   * Drop every built session, keeping the agent identities.
   *
   * A rule set is fixed when a session is built, so a live configuration change
   * has to invalidate the built set: otherwise a toggle writes cleanly and then
   * changes nothing until the next session.
   */
  invalidate(): void {
    this.#resolved.clear()
    this.#pending.clear()
  }

  /**
   * Invalidate every session and immediately start a build for each known agent.
   *
   * The host calls this on `loader/volatile-update`. Invalidating alone is not
   * enough there: the system prompt's rule layers come from a
   * `PromptSection` whose `text` is evaluated **synchronously** (it is typed
   * `string | ((context: AssembleContext) => string)` and cannot be awaited), so
   * the step right after a configuration change would render an empty string —
   * not the updated rules, but no rule layer at all — and only the step after
   * that would find the rebuilt session.
   *
   * The builds are fire-and-forget, so their rejections are swallowed exactly as
   * in {@link get}: an unhandled rejection here would take the process down.
   */
  rebuildAll(): void {
    this.invalidate()
    for (const agent of this.#agents.values()) {
      void this.ensure(agent).catch(() => {})
    }
  }

  /**
   * Whether no agent is left.
   *
   * The audit page is driven by whichever workspace a session last opened, so it
   * needs to know when the last one has gone: otherwise archiving every session
   * leaves the panel serving a dead workspace's rules with nothing on screen
   * saying which workspace they belong to.
   */
  get empty(): boolean {
    return this.#agents.size === 0
  }

  /** Forget an agent that has left the registry. */
  release(agent: Agent): void {
    // The `#pending` delete is what stops a build already in flight from
    // repopulating `#resolved` for an id the registry no longer knows.
    this.#agents.delete(agent.id)
    this.#resolved.delete(agent.id)
    this.#pending.delete(agent.id)
  }
}
