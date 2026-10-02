/**
 * Cordis activation: discovery, prompt injection, `rule://` addressing, and
 * the streaming interception loop.
 *
 * Every seam this plugin needs is a documented extension point, so the kernel
 * stays untouched: `agent/created` for per-session discovery,
 * `ctx.systemPrompt.section()` for the injected layers, `ctx.tools.register()`
 * for rule addressing, `agent/assistant-stream` for live deltas, and
 * `tools/pre-execute` plus `tools/result` for the tool surface.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: brings the loader's `loader/volatile-update` declaration.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { join } from 'node:path'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SettingsForms, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { directoryExists, provideAuditService, recordTrigger, totalTriggers, triggerCounts, type AuditPublisher, type RuleAuditRow, type ReadRuleResult, type RuleAuditReport, type RuleSourceFile, type ToggleResult, type WorkspaceRef } from './audit.ts'
import { bucketRules, type Buckets } from './buckets.ts'
import { createJudge, type Judge } from './judge.ts'
import { builtinRuleNames, builtinRules } from './builtin.ts'
import { loadCapability } from './capability.ts'
import { expandHome, liveTtsr, resolveConfig, type Config, type ResolvedConfig, type ResolvedTtsrConfig } from './config.ts'
import { discoverAll } from './discovery.ts'
import { dedupeDuplicateBodies, renderAlwaysApply, renderRulebook } from './prompt.ts'
import { RuleSession, toolPaths, toolSnapshot } from './session.ts'
import { RuleSessionStore } from './sessions.ts'
import type { Rule } from './rule.ts'
import { createRuleTool, ruleFilePath, type RuleLookup, type RuleToggle, type RuleWriteResult } from './tool.ts'
import { ensureRuleDir, resolveRuleDir, ruleDirPair, type RuleScope } from './rulesdir.ts'
import { migrateRules, type MigrationResult } from './migrate.ts'
import { TtsrManager, type TtsrSettings } from './ttsr.ts'

/** Prompt order band for domain rules, above the tool-guidance band. */
const SECTION_ORDER = 200
const SECTION_NAME = 'dsh-rules'

/** Minimal structural view of the session header this plugin reads. */
interface SessionHeaderView {
  cwd?: string
  origin?: 'subagent'
}

/** Minimal structural view of the live agent this plugin drives. */
interface AgentView {
  session?: { header?: SessionHeaderView }
}

/**
 * Apply the plugin to its Cordis context.
 * @param ctx - scoped plugin context; registrations are owned by its effects.
 * @param config - configuration resolved by the Cordis loader.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const namespace = resolved.settingsNamespace
  const judge = createJudge(ctx, judgeRoute(resolved))
  const persistDisabled = disabledRulesWriter(ctx, namespace)
  let auditCwd: string | undefined
  /**
   * Bumped whenever the audited workspace changes.
   *
   * Discovery walks every ancestor and reads every rule file, so it is slow
   * enough that two passes overlap. Without this, a pass started for workspace A
   * could resolve *after* the page moved to B and publish A's report over B's —
   * leaving `report.cwd` disagreeing with `auditCwd`, so every subsequent read,
   * toggle and edit would act on a workspace the page is no longer showing.
   */
  let auditEpoch = 0
  /** Whether the reader closed the audit themselves; cleared by opening one. */
  let auditDismissed = false

  /**
   * Drop back to the no-workspace state instead of serving a dead one.
   *
   * `explicit` marks a close the reader asked for, which is not the same thing
   * as having no workspace to describe. Losing the last session leaves nothing
   * to audit and the next session should light the panel up again; a reader who
   * closed it meant the panel to stay empty, so an in-flight session build must
   * not put a workspace back under it.
   */
  const closeWorkspace = (explicit = false): void => {
    auditCwd = undefined
    auditEpoch += 1
    if (explicit) auditDismissed = true
    publishAudit(EMPTY_AUDIT)
  }

  /** Audit one workspace by absolute path, republishing immediately. */
  const openWorkspace = async (path: string): Promise<ToggleResult> => {
    // Published only on success, so a path that cannot be discovered never
    // becomes the audit's cwd: the panel would otherwise keep showing the
    // previous workspace's rules under the name of the one that failed. Failing
    // leaves the page where it was rather than closing it — closing is its own
    // explicit action.
    const epoch = (auditEpoch += 1)
    const previous = auditCwd
    // Discovery tolerates a missing directory — it reports a warning and finds
    // nothing — so opening one would silently succeed and blank the panel.
    // Refusing it outright says what actually happened.
    if (!directoryExists(path)) {
      return {
        ok: false,
        guidance: `${path} is not a directory this machine can read.`,
        disabled: [...liveTtsr(config).disabledRules],
      }
    }
    try {
      const next = await discoverAudit(path, resolved, () => liveTtsr(config))
      // Discarded if the page moved on while this ran: publishing it would put
      // the old workspace's rules back under the new one's name.
      if (auditEpoch !== epoch) {
        return { ok: false, guidance: 'the workspace changed while this one was being read.', disabled: [] }
      }
      auditCwd = path
      // Opening is the reader choosing a workspace again, so a later session
      // build is free to follow it rather than being blocked by an earlier close.
      auditDismissed = false
      publishAudit(next)
      return { ok: true, disabled: [...liveTtsr(config).disabledRules] }
    } catch (error) {
      // Unreachable through the filesystem, which discovery tolerates by
      // design, but a throw here would otherwise surface as an opaque
      // `gateway/internal` and leave `auditCwd` naming a path that was never
      // published. Restoring is the honest answer either way.
      if (auditEpoch === epoch) {
        auditCwd = previous
        if (previous === undefined) publishAudit(EMPTY_AUDIT)
      }
      return {
        ok: false,
        guidance: `could not read the rules under ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        disabled: [...liveTtsr(config).disabledRules],
      }
    }
  }

  /**
   * Write a new rule file into the calling session's workspace.
   *
   * Deliberately not `writeRule`: that one overwrites a file discovery already
   * found, and refuses when nothing is there. A rule the model just proposed
   * has no file yet, so this writes into `.omp/rules/` — the project's own
   * directory, where the rule shows up in the audit and can be edited or
   * deleted like any other project rule.
   *
   * The file is checked for existence rather than merged with the discovered
   * set: discovery skips a file it cannot parse, so a rule that failed to load
   * would be invisible to a name check and silently overwritten by this.
   */
  const createRule = async (
    exec: ToolRunContext,
    scope: RuleScope,
    name: string,
    frontmatter: string,
    body: string,
  ): Promise<RuleWriteResult> => {
    // The session's own workspace, not the audit's: the model is writing for
    // the conversation it is in, and the audit panel may be pointed elsewhere.
    const cwd = exec.agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      return { ok: false, guidance: 'this session has no workspace, so there is nowhere to write the rule.', disabled: [] }
    }
    const target = await resolveRuleDir(scope, cwd, resolved.userRulesDir)
    await ensureRuleDir(target.path)
    const path = ruleFilePath(target.path, name)
    try {
      // `wx` fails rather than truncating, and the directory may not exist yet:
      // a workspace with no rules has none of these paths.
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(`---\n${frontmatter.trim()}\n---\n\n${body.trim()}\n`, 'utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        return { ok: false, guidance: `${path} already exists. Edit that file rather than replacing it.`, disabled: [] }
      }
      return {
        ok: false,
        guidance: `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
        disabled: [],
      }
    }
    // The snapshot this turn was built from does not contain the new rule, so
    // saying it applies now would be a lie. Rebuild before the next step runs.
    sessions.rebuildAll()
    return { ok: true, disabled: [...liveTtsr(config).disabledRules], path }
  }

  /**
  /**
   * Move rule files between the two conventions for one scope.
   *
   * Both sides come from the directory pair, so a move is between two
   * directories discovery already reads: the rule keeps its name, its body and
   * what it does, and only its location changes.
   */
  const migrateRulesFor = async (
    exec: ToolRunContext,
    scope: RuleScope,
    to: 'omp' | 'dsh',
  ): Promise<MigrationResult> => {
    // The session's workspace, exactly as `createRule` resolves it. Reading
    // `auditCwd` instead would move whichever project's rules the Settings panel
    // happened to be left pointing at — which is not the project the user asked
    // about, and is nothing at all for a reader who never opened the panel.
    const cwd = exec.agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      return { from: '', to: '', moved: [], empty: true }
    }
    const pair = await ruleDirPair(scope, cwd, resolved.userRulesDir)
    const plan = to === 'omp'
      ? { from: pair.dsh.path, to: pair.omp.path, fromConvention: 'dsh' as const, toConvention: 'omp' as const }
      : { from: pair.omp.path, to: pair.dsh.path, fromConvention: 'omp' as const, toConvention: 'dsh' as const }
    const result = await migrateRules(plan)
    sessions.rebuildAll()
    return result
  }

  /**
 * Registered workspaces, read through the host's own registry.
   *
   * `ctx.get` rather than property access: the workspace service is not in this
   * plugin's `inject`, and Cordis refuses undeclared service reads outright.
   */
  /** The backing file of one rule, resolved through the current report. */
  const readRule = async (name: string): Promise<ReadRuleResult> => {
    // Refused outright with no workspace open. Discovery treats `''` as a real
    // directory: `join('', '.cursor', 'rules')` is a *relative* path, so passing
    // an empty cwd resolves rules against whatever directory the dsh process
    // was launched in — and `writeRule` reuses whatever path comes back. That
    // would let a page write rule files outside the workspace it is showing.
    if (auditCwd === undefined) {
      return { ok: false, guidance: 'open a workspace first: there is nothing here to edit.' }
    }
    // Re-discovered rather than read from the published report: the report is a
    // snapshot, and an edit must never be written to the file a stale row names.
    const next = await discoverAudit(auditCwd, resolved, () => liveTtsr(config))
    const row = next.rules.find(rule => rule.name === name)
    if (row === undefined) {
      return { ok: false, guidance: `no rule named ${name} in this workspace, so there is nothing to edit.` }
    }
    if (row.provider === 'builtin-defaults') {
      // A bundled rule is compiled into the plugin; there is no file to edit,
      // and pretending otherwise would send the reader looking for one.
      return { ok: true, file: { name, path: '', content: '', editable: false } }
    }
    try {
      const content = await readFile(row.path, 'utf8')
      return { ok: true, file: { name, path: row.path, content, editable: true } }
    } catch (error) {
      return {
        ok: false,
        guidance: `could not read ${row.path}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * Overwrite a rule's file.
   *
   * Re-resolved through discovery rather than trusting the caller's path, so a
   * save can only ever land on the file that rule was discovered in.
   */
  const writeRule = async (name: string, content: string): Promise<ToggleResult> => {
    const read = await readRule(name)
    if (!read.ok) return { ok: false, guidance: read.guidance, disabled: [] }
    const file = read.file
    if (!file.editable) {
      return { ok: false, guidance: `${name} ships with the plugin and has no file to edit.`, disabled: [] }
    }
    try {
      await writeFile(file.path, content, 'utf8')
    } catch (error) {
      return {
        ok: false,
        guidance: `could not write ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
        disabled: [],
      }
    }
    // The file just changed underneath the report, so republish before telling
    // the page the save worked.
    if (auditCwd !== undefined) {
      publishAudit(await discoverAudit(auditCwd, resolved, () => liveTtsr(config)))
    }
    return { ok: true, disabled: [...liveTtsr(config).disabledRules] }
  }

  const listWorkspaces = (): WorkspaceRef[] => {
    const registry = (ctx as Context).get('workspaceRegistry') as { list?: () => unknown[] } | undefined
    if (registry?.list === undefined) return []
    try {
      // The registry hands back `WorkspaceEntity` class instances, whose `path`
      // and `title` are prototype getters. Serialising one crosses the wire with
      // only its own fields — `{ id, record }` — so the browser saw no path and
      // no title at all. Flatten here, where the declared type is a plain
      // `WorkspaceRef`, rather than hoping the client copes.
      return registry.list().map(entry => ({
        id: String((entry as { id?: unknown })?.id ?? ''),
        path: String((entry as { path?: unknown })?.path ?? ''),
        title: String((entry as { title?: unknown })?.title ?? ''),
      }))
    } catch {
      // The registry needs a running host; a page opened without one simply has
      // no workspace to offer.
      return []
    }
  }

  const publishAudit = provideAuditService(
    ctx,
    () => (auditCwd === undefined
      ? Promise.resolve(EMPTY_AUDIT)
      : discoverAudit(auditCwd, resolved, () => liveTtsr(config))),
    () => liveTtsr(config).disabledRules,
    async names => {
      // The page replaces the whole set deliberately — it filters and
      // multi-selects, so a stale selection must not half-apply. One user
      // drives it, so there is no intent to compose here.
      const written = await persistDisabled(() => names)
      return written.ok
        ? { ok: true, disabled: [...written.names] }
        : { ok: false, guidance: written.guidance, disabled: [...names] }
    },
    readRule,
    writeRule,
    listWorkspaces,
    openWorkspace,
    closeWorkspace)

  const sessions = new RuleSessionStore(agent => {
    // A build takes seconds, so it can easily resolve after the page has been
    // pointed somewhere else. The epoch is captured here rather than read at
    // publish time: a stale build reading the value *now* would always match,
    // since whatever moved the page on has already advanced it. Captured at
    // start, it detects exactly the overlap `openWorkspace` guards against —
    // otherwise a session for the workspace the user just left would republish
    // its rules under the new one's name, and since `readRule` and `writeRule`
    // both re-resolve through `auditCwd`, an edit the page started against one
    // workspace would be written into the other.
    //
    // An empty `auditCwd` still adopts: that is the state left behind once the
    // last session is gone, and the panel is documented to follow whichever
    // workspace a session last opened. What it must not override is a close the
    // reader asked for — `auditCwd` is empty there too, and treating that as
    // "nothing chosen yet" is exactly what resurrects a workspace the reader
    // just dismissed. Decided once and remembered, because the two callbacks run
    // back to back and must not disagree: adopting the cwd and then declining to
    // publish would leave the panel naming a workspace it is not showing.
    const startedAt = auditEpoch
    let adopted: boolean | undefined
    const mayAdopt = (): boolean => {
      adopted ??= !auditDismissed && (auditCwd === undefined || auditEpoch === startedAt)
      return adopted
    }
    return buildSession(
      agent,
      resolved,
      () => liveTtsr(config),
      report => {
        if (mayAdopt()) publishAudit(report)
      },
      cwd => {
        if (mayAdopt()) auditCwd = cwd
      },
    )
  })

  // The audit page has no agent of its own, so nothing would rebuild the report
  // after a toggle. Remembering the workspace lets a configuration change
  // republish it without waiting for the next session.
  const republishAudit = (): void => {
    const cwd = auditCwd
    if (cwd === undefined) return
    const epoch = auditEpoch
    void discoverAudit(cwd, resolved, () => liveTtsr(config)).then(next => {
      // A close or a switch since this started makes this the wrong workspace.
      if (auditEpoch !== epoch || auditCwd !== cwd) return
      publishAudit(next)
    })
  }

  ctx.effect(() => {
    const disposeSection = ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: (context: AssembleContext) => renderFor(context, sessions),
    })

    const ruleTool = createRuleTool(
      tool => ctx.tools.register(tool),
      exec => lookup(sessions, exec.agent),
      () => toggle(config, persistDisabled),
      exec => ({
        create: (scope, name, frontmatter, body) => createRule(exec, scope, name, frontmatter, body),
        migrate: (scope, to) => migrateRulesFor(exec, scope, to),
      }),
    )

    // Warm path only. Every other surface below falls back to building on
    // demand, so an agent that already existed when this plugin mounted still
    // gets its rules instead of running ungoverned.
    ctx.on('agent/created', async ({ agent }) => {
      sessions.note(agent)
      await sessions.ensure(agent)
    })

    ctx.on('agent/disposed', ({ agent }) => {
      sessions.release(agent)
      // The audit follows whichever workspace a session last opened. Once the
      // last one is gone there is no workspace to describe, and keeping the old
      // report would leave the page showing a dead workspace's rules — the
      // numbers stay truthful for that path, so nothing on screen looks wrong.
      if (sessions.empty) closeWorkspace()
    })

    // A rule set is fixed when a session is built. The `ttsr` block is volatile,
    // so a change lands on the running plugin immediately — but the built
    // session still holds the old set, and rebuilding is what makes a toggle
    // take effect on the next step rather than the next session.
    //
    // Invalidating alone is not enough: a section's `text` is evaluated
    // synchronously during assembly (`PromptSection.text` is
    // `string | (context) => string`, there is nothing to await), so the step
    // right after the toggle would find no built session and render an empty
    // layer — no `<domain-rules>`, no `<generic-rules>`, and no `rule` tool
    // advertisement. Less governed than before the toggle, rather than governed
    // by the new set. Kicking the rebuild here starts that walk while the
    // model is still assembling, so the step lands on the new rules.
    ctx.on('loader/volatile-update', () => {
      sessions.rebuildAll()
      republishAudit()
    })

    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const session = sessions.get(agent)
      if (session === undefined) return

      if (frame.type === 'start') {
        session.beginTurn(frame.turn)
        return
      }
      if (frame.type === 'end') {
        session.flushProsePending(agent)
        return
      }
      if (frame.type !== 'chunk') return

      const { chunk } = frame
      if (chunk.type === 'text-delta') {
        session.observeDelta(agent, 'text', chunk.text)
        return
      }
      if (chunk.type === 'reasoning-delta') {
        session.observeDelta(agent, 'thinking', chunk.text)
        return
      }
      if (chunk.type === 'tool-call-delta' && chunk.name !== undefined) {
          session.observeDelta(agent, 'tool', chunk.argumentsDelta, { tool: chunk.name, callId: chunk.id })
      }
    })

    ctx.on('tools/pre-execute', async (exec: ToolExecution, next) => {
      const session = await sessions.ready(exec.agent)
      if (session === undefined) return next()

      const args = exec.arguments as Record<string, unknown>
      const { blocking } = session.toolViolations(toolSnapshot(exec.name, args), {
        source: 'tool',
        tool: exec.name,
        callId: exec.callId,
        paths: session.pathCandidates(toolPaths(args)),
      })
      if (blocking.length === 0) return next()

      return {
        kind: 'deny' as const,
        reason: `Blocked by rule ${blocking.map(rule => rule.name).join(', ')}. Load the rule with the rule tool and follow it.`,
      }
    })

    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (result.isError || decision.kind === 'block') return decision

      const reminder = sessions.get(exec.agent)?.takeToolReminder(exec.callId)
      if (reminder === undefined) return decision

      // The reminder leads, and whatever content the pipeline settled on is
      // preserved verbatim behind it. A consumer that assumes `content[0]` is
      // the tool's primary output must skip a rule_violation reminder block.
      const content = decision.content ?? result.content
      return {
        kind: 'accept',
        content: [{ type: 'text', text: reminder }, ...content],
        additionalContexts: decision.additionalContexts,
      }
    })

    ctx.on('session/event', (sessionEvent, event) => {
      const session = sessions.getById(sessionEvent.id)
      if (event.type === 'turn/end') {
        session?.endTurn()
        return
      }
      if (event.type !== 'assistant/message' || session === undefined) return

      const agent = sessions.agentFor(sessionEvent.id)
      if (agent === undefined) return
      void deliverJudged(session, agent, judge, outputText(event.data.message.content))
    })

    return () => {
      disposeSection()
      ruleTool.dispose()
    }
  })
}

/** Judge route from configuration, or undefined when judging stays off. */
function judgeRoute(config: ResolvedConfig): { provider: string; model: string } | undefined {
  if (config.ttsr.judge === 'off') return undefined
  const provider = config.ttsr.judgeProvider
  const model = config.ttsr.judgeModel
  return provider === undefined || model === undefined ? undefined : { provider, model }
}

/** Concatenate the visible text of one completed assistant message. */
function outputText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Ask the judge about one completed output and deliver what it flagged.
 *
 * Judging is best-effort: a failure is swallowed here because a warning that
 * cannot be produced must never fail the turn that produced the output.
 */
async function deliverJudged(session: RuleSession, agent: Agent, judge: Judge, output: string): Promise<void> {
  if (output === '') return
  const candidates = session.judged(output, { source: 'text' })
  if (candidates.length === 0) return

  try {
    session.deliverWarnings(agent, await judge.ask(candidates, output))
  } catch {
    return
  }
}

/**
 * Build the toggle surface the `rule` tool drives.
 *
 * The change is written through the settings service so it lands in the
 * profile patch the deployment already owns. When that service is absent the
 * surface still answers, with the exact lines to add by hand, rather than
 * pretending the change was saved.
 */
function toggle(config: Config, persist: RuleDisabledWriter): RuleToggle {
  return {
    toggleable: builtinRuleNames(),
    get disabled() {
      return liveTtsr(config).disabledRules
    },
    setDisabled: intent => persist(intent).then(written => (written.ok ? { ok: true } : written)),
  }
}

/**
 * How a caller wants the disabled set to change.
 *
 * The caller states intent rather than a snapshot. A snapshot computed from the
 * plugin's config is stale the moment a second write lands — two `rule disable`
 * calls in one turn both read `[]` and both send one rule, so the second
 * silently erases the first. Given the live set, each intent composes with
 * whatever actually landed.
 *
 * @param current - the disabled set as the service reports it right now.
 * @returns the set that should be stored.
 */
export type DisabledIntent = (current: readonly string[]) => readonly string[]

/** Persist a change to the disabled set. */
export type RuleDisabledWriter = (intent: DisabledIntent) => Promise<{ ok: true; names: readonly string[] } | { ok: false; guidance: string }>

/** What one attempt produced: written, refused, or overtaken by a racing write. */
type WriteOutcome =
  | { ok: true; names: readonly string[] }
  | { ok: false; guidance: string }
  | { ok: false; conflict: true }

/**
 * Build the writer both the tool and the audit page persist through.
 *
 * The settings service owns the profile patch, so a deployment without one
 * gets the exact YAML to add rather than a change that was never saved.
 */
function disabledRulesWriter(ctx: Context, namespace: string): RuleDisabledWriter {
  const unavailable = (names: readonly string[]): { ok: false; guidance: string } => ({
    ok: false,
    guidance: 'This deployment has no settings service, so the change was not saved. ' +
      `Add it to the plugin's profile patch by hand:\n\n  ttsr:\n    disabledRules:\n${
        names.length === 0 ? '      []\n' : names.map(name => `      - ${name}\n`).join('')
      }`,
  })

  return async (intent: DisabledIntent) => {
    // Cordis refuses property access to a service a plugin did not declare in
    // `inject` — `ctx.settings` throws "cannot get property 'settings' without
    // inject", which reads exactly like a missing service and sent this down the
    // wrong path for a long time. `inject` is a readiness gate, so listing
    // `settings` there would stop the plugin from loading wherever the service is
    // genuinely absent; `ctx.get` is the accessor that degrades to `undefined`.
    const settings = (ctx as Context).get('settings') as SettingsForms | undefined
    if (settings === undefined) return unavailable(intent([]))

    // Three `rule disable` calls in one turn used to race: each computed its ops
    // from the plugin's own config, which has not hot reloaded yet, and each
    // wrote, so one silently vanished. `describe()` is the service's own live
    // view of the entry, so it is the right basis for the ops, and its revision
    // makes the write conditional — a racing write bumps the revision and this
    // one is rejected rather than overwriting. A retry re-reads and recomputes.
    let last: WriteOutcome = { ok: false, conflict: true }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await writeOnce(settings, namespace, intent)
      if (last.ok === true) return { ok: true, names: last.names }
      if (!('conflict' in last)) return last
    }
    return {
      ok: false,
      guidance: 'Three attempts to save the rule change were each overtaken by another one. Try again.',
    }
  }
}

/**
 * Read the live entry, resolve the intent against it, and write, once.
 *
 * `mutate` is awaited: it returns a promise, so without the await its rejection
 * escapes this `catch` entirely and the write reports success it never had.
 */
async function writeOnce(settings: SettingsForms, namespace: string, intent: DisabledIntent): Promise<WriteOutcome> {
  const descriptor = settings.describe().find(row => row.ns === namespace)
  // `value` is already the namespace's own config, not a fragment of it.
  const current = liveTtsr(descriptor?.value as Config | undefined).disabledRules
  const names = [...new Set(intent(current))].sort()

  // `update` merges layers, and a merged empty array does not clear an existing
  // one. Array edits go through path operations, which the service documents as
  // index-addressed: setting one index appends, unsetting removes.
  const setOps: SettingsPathOp[] = names.map((name, index) => ({
    op: 'set',
    path: ['ttsr', 'disabledRules', String(index)],
    value: name,
  }))

  // Descending on purpose. The service rejects an `unset` whose index equals the
  // array's current length, and each `unset` splices one entry out, so an
  // ascending walk shrinks out from under itself: dropping all three of
  // `['a','b','c']` would unset 0 (ok), 1 (ok), then 2 against a one-element array
  // and throw. The walk also starts at the tail rather than at zero — the sets
  // above have already written `names` into 0..names.length-1, so the stale
  // entries to drop are exactly names.length .. current.length-1, and starting
  // at zero would delete the very rules the caller asked to keep.
  const removals = Math.max(0, current.length - names.length)
  const unsetOps: SettingsPathOp[] = Array.from({ length: removals }, (_, offset) => names.length + removals - 1 - offset)
    .map(index => ({
      op: 'unset',
      path: ['ttsr', 'disabledRules', String(index)],
    }))

  try {
    if (setOps.length > 0 || unsetOps.length > 0) {
      await settings.mutate(namespace, [...setOps, ...unsetOps], descriptor?.revision)
    }
    return { ok: true, names }
  } catch (error) {
    if (isConflict(error)) return { ok: false, conflict: true }
    return {
      ok: false,
      guidance: `The settings service refused the change (${
        error instanceof Error ? error.message : String(error)
      }). Apply it to the "${namespace}" row by hand: ttsr.disabledRules: [${
        names.length === 0 ? '' : names.join(', ')
      }]`,
    }
  }
}

/**
 * Whether a write lost a race.
 *
 * The service signals this with its own `SettingsConflictError`, which is
 * exported from its types but not necessarily from its runtime entry, so the
 * name is matched as well as the message.
 */
function isConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'SettingsConflictError' || /conflict/i.test(error.message)
}

/** An audit before any workspace has been discovered. */
const EMPTY_AUDIT: RuleAuditReport = {
  cwd: '',
  rulebook: [],
  alwaysApply: [],
  ttsr: [],
  rules: [],
  warnings: [],
  triggered: {},
}

/** Report one workspace's rule set without building a session for it. */
async function discoverAudit(cwd: string, config: ResolvedConfig, ttsrConfig: () => ResolvedTtsrConfig): Promise<RuleAuditReport> {
  // Never called with an empty cwd: `recompute` answers `EMPTY_AUDIT` before
  // this, and `readRule` refuses outright. That matters because `join('', '.cursor',
  // 'rules')` is a *relative* path, which would resolve against whatever
  // directory the process was launched in — so the guard has to stay at the two
  // call sites, where it is covered by tests.
  const live = ttsrConfig()
  const capability = loadCapability([
    { provider: 'builtin-defaults', rules: builtinRules(), warnings: [] },
    ...await discoverAll({
      cwd,
      userRulesDir: expandHome(config.userRulesDir),
      pluginRoots: config.pluginRoots.map(expandHome),
      copilotInstructionDirs: config.copilotInstructionDirs.map(expandHome),
    }),
  ])
  const buckets = bucketRules(capability.items, {
    builtinRules: live.builtinRules,
    disabledRules: live.disabledRules,
    agentName: 'main',
    registerTtsr: () => false,
  })

  const inForce = new Set([...buckets.rulebookRules, ...buckets.alwaysApplyRules, ...buckets.ttsrRules].map(rule => rule.name))
  const inactive = new Map<string, string>()
  for (const rule of capability.all) {
    if (!inForce.has(rule.name)) {
      inactive.set(rule.name, inactiveReason(rule, live.disabledRules, live.builtinRules, buckets.dropped.includes(rule)))
    }
  }
  return auditReport(cwd, capability.all, buckets, inForce, inactive)
}

/** Build the audit report the settings page renders. */
function auditReport(
  cwd: string,
  discovered: readonly Rule[],
  buckets: Buckets,
  inForce: ReadonlySet<string>,
  inactive: ReadonlyMap<string, string>,
): RuleAuditReport {
  const rules: RuleAuditRow[] = discovered.map(rule => {
    const triggers: string[] = []
    if ((rule.condition?.length ?? 0) > 0) triggers.push('condition')
    if ((rule.astCondition?.length ?? 0) > 0) triggers.push('ast-grep')
    if (rule.question !== undefined) triggers.push('question')

    const row: RuleAuditRow = {
      name: rule.name,
      provider: rule._source.provider,
      path: rule.path,
      active: inForce.has(rule.name),
      triggers,
    }
    if (rule._source.scope !== undefined) row.scope = rule._source.scope
    const reason = inactive.get(rule.name)
    if (reason !== undefined) row.reason = reason
    if (rule.description !== undefined) row.description = rule.description
    if (rule.globs !== undefined) row.globs = rule.globs
    if (rule.interruptMode !== undefined) row.interruptMode = rule.interruptMode
    return row
  })

  return {
    cwd,
    rulebook: buckets.rulebookRules.map(rule => rule.name),
    alwaysApply: buckets.alwaysApplyRules.map(rule => rule.name),
    ttsr: buckets.ttsrRules.map(rule => rule.name),
    rules,
    warnings: [],
    triggered: triggerCounts(),
  }
}

/**
 * Why a discovered rule joined no bucket, as a stable code.
 *
 * Codes rather than prose: the page localizes them, so the reason reads in the
 * reader's language instead of leaking the host's English.
 */
function inactiveReason(rule: Rule, disabled: readonly string[], builtinsEnabled: boolean, dropped: boolean): string {
  if (disabled.includes(rule.name)) return 'disabled'
  if (!builtinsEnabled && rule._source.provider === 'builtin-defaults') return 'builtins-off'
  if (dropped && rule.agents !== undefined && rule.agents.length > 0) return 'agent-filter'
  if (dropped) return 'no-trigger'
  return 'shadowed'
}

/** Resolve the addressable snapshot for a tool call, starting discovery if needed. */
function lookup(sessions: RuleSessionStore, agent: Agent | undefined): RuleLookup {
  if (agent === undefined) return { state: 'no-agent' }
  const session = sessions.get(agent)
  return session === undefined ? { state: 'building' } : { state: 'ready', snapshot: session.snapshot }
}

/** Render both injected layers for one assembly. */
function renderFor(context: AssembleContext, sessions: RuleSessionStore): string {
  const session = sessions.get(context.agent)
  if (session === undefined) return ''

  const always = dedupeDuplicateBodies(session.rules.filter(rule => rule.alwaysApply === true))
  const rulebook = session.rules.filter(rule => rule.alwaysApply !== true && rule.description !== undefined)
  return [renderAlwaysApply(always), renderRulebook(rulebook)].filter(part => part !== '').join('\n\n')
}

/** Discover, bucket, and coordinate rules for one agent's session. */
async function buildSession(
  agent: Agent,
  config: ResolvedConfig,
  ttsrConfig: () => ResolvedTtsrConfig,
  publishAudit: AuditPublisher,
  onAuditWorkspace: (cwd: string) => void,
): Promise<RuleSession> {
  const header = (agent as AgentView).session?.header
  // No session header means no workspace, and falling back to the process's own
  // directory would attribute an arbitrary directory's rules to the session.
  const cwd = header?.cwd
  const agentName = header?.origin === 'subagent' ? 'sub' : 'main'

  const ttsr = new TtsrManager((): TtsrSettings => {
    const live = ttsrConfig()
    return {
      enabled: live.enabled,
      interruptMode: live.interruptMode,
      repeatMode: live.repeatMode,
      repeatGap: live.repeatGap,
    }
  })

  // No session header means no workspace: an empty rule set against a neutral
  // root, rather than the process's own directory, which would attribute an
  // arbitrary directory's rules to the session.
  if (cwd === undefined) {
    return new RuleSession([], [], [], new Map(), ttsr, '', () => ttsrConfig().interruptMode)
  }

  const providers = [
    { provider: 'builtin-defaults', rules: builtinRules(), warnings: [] },
    ...await discoverAll({
      cwd,
      userRulesDir: expandHome(config.userRulesDir),
      pluginRoots: config.pluginRoots.map(expandHome),
      copilotInstructionDirs: config.copilotInstructionDirs.map(expandHome),
    }),
  ]
  const capability = loadCapability(providers)
  const live = ttsrConfig()
  const buckets = bucketRules(capability.items, {
    builtinRules: live.builtinRules,
    disabledRules: live.disabledRules,
    agentName,
    registerTtsr: rule => ttsr.addRule(rule).accepted,
  })

  const addressable = [...buckets.rulebookRules, ...buckets.alwaysApplyRules, ...buckets.ttsrRules]
  const inForce = new Set(addressable.map(rule => rule.name))
  const inactive = new Map<string, string>()
  for (const rule of capability.all) {
    if (inForce.has(rule.name)) continue
    inactive.set(rule.name, inactiveReason(rule, live.disabledRules, live.builtinRules, buckets.dropped.includes(rule)))
  }

  onAuditWorkspace(cwd)
  publishAudit(auditReport(cwd, capability.all, buckets, inForce, inactive))


  return new RuleSession(
    [...buckets.rulebookRules, ...buckets.alwaysApplyRules],
    addressable,
    capability.all,
    inactive,
    ttsr,
    cwd,
    () => ttsrConfig().interruptMode,
  )
}

