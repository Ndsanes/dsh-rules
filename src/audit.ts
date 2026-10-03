/**
 * Audit surface: what the plugin found, what is in force, and what is not.
 *
 * The browser half reads this over the Remote gateway. dsh's Typert pipeline
 * can generate that manifest, but the generator only resolves packages that sit
 * under a workspace root's `packages/` directory, which a standalone plugin is
 * not. The manifest is therefore authored here, matching the generated shape —
 * `typert-loader` scans the package's `./typert` export at boot and wires
 * `ctx.remote.dshRules.*` from it.
 */

import { builtinRuleNames } from './builtin.ts'
import { INTERRUPT_MODES } from './config.ts'
import type { InterruptMode } from './rule.ts'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshRules: RulesAuditService
  }
}

/** One discovered rule as the audit page sees it. */
export interface RuleAuditRow {
  name: string
  provider: string
  path: string
  /** Short name of the tree the rule came from, when it has one. */
  scope?: string
  active: boolean
  /** Why an inactive rule is inactive; absent when the rule is in force. */
  reason?: string
  description?: string
  globs?: string[]
  /** `always`, `prose-only`, `tool-only`, or `never`: the mode in force now. */
  interruptMode?: string
  /**
   * What the rule states for itself, before any override.
   *
   * Carried beside the effective mode because an overridden rule no longer says
   * what it would have said: without this, clearing an override could only put
   * back the value it replaced.
   */
  ownInterruptMode?: string
  /** The `ttsr.modeOverrides` entry in force for this rule, when there is one. */
  modeOverride?: string
  /** How the rule triggers: `condition`, `ast-grep`, `question`, or none. */
  triggers: string[]
}

/** Everything one discovery pass found. */
export interface RuleAuditReport {
  cwd: string
  rulebook: string[]
  alwaysApply: string[]
  ttsr: string[]
  rules: RuleAuditRow[]
  warnings: string[]
  /** How often each rule has been delivered to the model, across sessions. */
  triggered: Record<string, number>
  /** Set when the described workspace no longer exists. */
  stale?: { cwd: string }
}

const EMPTY: RuleAuditReport = {
  cwd: '',
  rulebook: [],
  alwaysApply: [],
  ttsr: [],
  rules: [],
  warnings: [],
  triggered: {},
}

/**
 * How often each rule has fired.
 *
 * Counted when a rule is actually delivered to the model — an interrupt, a
 * reminder folded into a tool result, a prose reminder, a denied call, or a
 * judged warning. A match no rule acted on is not a trigger.
 *
 * Where the counts live between processes.
 *
 * A count kept only in memory would read zero in every process that did not
 * itself deliver a rule, which is nearly all of them: sessions run in the web
 * app, in the CLI, and in one-shot runs, and the page is read wherever it
 * happens to be opened.
 */
function ledgerPath(): string {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(home, 'dsh-rules', 'triggers.json')
}

/** Read the persisted counts, tolerating an absent or damaged file. */
/** Whether a path is still a directory on disk. */
export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Deliveries this process has made and not yet flushed. */
const triggers = new Map<string, number>()

/**
 * The persisted counts, or `undefined` when the ledger exists but will not parse.
 *
 * The three cases have to stay distinguishable: an absent file and an unparseable
 * one both read as "no counts yet", but only the second one still holds history.
 * Collapsing them is what lets a truncated ledger be rewritten as a single
 * delivery and lose every other rule's lifetime count with it.
 */
function readLedger(): Record<string, number> | undefined {
  let raw: string
  try {
    raw = readFileSync(ledgerPath(), 'utf8')
  } catch {
    // No ledger yet: a first run is not damage.
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined

  const counts: Record<string, number> = {}
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) counts[name] = value
  }
  return counts
}

/** Write the counts through a temporary file so a crash cannot truncate them. */
function writeLedger(counts: Record<string, number>): void {
  const path = ledgerPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    // The pid is part of the name because sessions run in the web app, in the
    // CLI and in one-shot runs that share one `$DSH_HOME`. Two processes inside
    // the same flush window would otherwise use one scratch file: the second
    // truncates what the first wrote, the first's `rename` publishes the
    // second's bytes, and the second's `rename` throws ENOENT into the catch
    // below — which drops that process's delivery without ever retrying it.
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(counts, null, 2), 'utf8')
    renameSync(temporary, path)
  } catch {
    // A read-only home must not take the harness down over a counter.
  }
}

/**
 * Fold this process's unflushed deliveries into the persisted totals.
 *
 * `triggers` is only ever the delta since the last flush. Writing the merged
 * totals back into it would double every count on the next read, because the
 * reader adds the ledger to the delta again.
 */
function save(): void {
  if (triggers.size === 0) return
  const existing = readLedger()
  if (existing === undefined) {
    // A ledger we cannot parse still holds every other rule's lifetime count.
    // Merging this process's delta into an empty object and writing it back
    // would reset all of them to whatever this one process delivered — a single
    // truncated file silently erasing the history of every other rule. Losing
    // this delivery is recoverable (the next run recounts it); losing the
    // history is not, so the damaged file is left untouched for a human.
    return
  }
  const merged = existing
  for (const [name, count] of triggers) merged[name] = (merged[name] ?? 0) + count
  writeLedger(merged)
  triggers.clear()
}

let pendingSave: NodeJS.Timeout | undefined

/** Record one delivery of one rule. */
export function recordTrigger(name: string): void {
  triggers.set(name, (triggers.get(name) ?? 0) + 1)
  // Coalesced: a run can deliver dozens of rules, and each flush rewrites one
  // small file.
  if (pendingSave !== undefined) return
  // Deliberately not unref'd: a one-shot run exits within a second or two, and
  // an unref'd timer would let the process die before the counts are written.
  pendingSave = setTimeout(() => {
    pendingSave = undefined
    save()
  }, 2000)
}

/** The delivery counts so far, busiest first, including other processes'. */
export function triggerCounts(): Record<string, number> {
  // A damaged ledger reads as no persisted counts: the page then shows this
  // process's own deliveries rather than a total that is quietly wrong.
  const merged = readLedger() ?? {}
  for (const [name, count] of triggers) merged[name] = (merged[name] ?? 0) + count
  return Object.fromEntries(Object.entries(merged).sort((a, b) => b[1] - a[1]))
}

/** Total deliveries across every rule. */
export function totalTriggers(): number {
  return Object.values(triggerCounts()).reduce((total, count) => total + count, 0)
}

/** The result of a toggle attempt. */
export interface ToggleResult {
  ok: boolean
  /** Present when the change was not saved, with what to do instead. */
  guidance?: string
  disabled: string[]
}

/**
 * The result of an interrupt-mode change.
 *
 * `mode` echoes the override now in force, and is absent once the rule speaks
 * for itself again — the same shape as {@link ToggleResult}'s `disabled`, which
 * also answers with the state rather than with what was asked for.
 */
export interface ModeChangeResult {
  ok: boolean
  /** Present when the change was not saved, with what to do instead. */
  guidance?: string
  mode?: InterruptMode
}

/**
 * What the page asks for: a mode to force, or nothing to let the rule speak.
 *
 * `''` is how the wire carries "no override" — the page's selector offers a
 * blank option, and JSON has no `undefined` to send instead.
 */
export type ModeRequest = InterruptMode | '' | undefined

/**
 * What the writer reports back.
 *
 * The `conflict` arm is what the writer reports when three conditional writes
 * were each overtaken by a racing one. It never reaches a reader — the writer
 * turns it into guidance before returning — but callers must be able to say so.
 */
export type ModeWriteResult =
  | { ok: true; entries: readonly string[] }
  | { ok: false; guidance: string }
  | { ok: false; conflict: true }

/** Publishes one discovery pass for the audit page. */
export type AuditPublisher = (report: RuleAuditReport) => void

/**
 * The outcome of a read.
 *
 * Refused rather than rejected, like every other call on this service: a
 * rejection crosses the gateway as an opaque `gateway/internal`, so the page
 * would see "something went wrong" instead of what to do about it.
 */
export type ReadRuleResult =
  | { ok: true; file: RuleSourceFile }
  | { ok: false; guidance: string }

/** One rule's backing file, as the editor sees it. */
export interface RuleSourceFile {
  readonly name: string
  /** Absolute path, shown before anything is written. */
  readonly path: string
  /** The file's current contents, frontmatter included. */
  readonly content: string
  /** False for a bundled rule, which has no file on disk. */
  readonly editable: boolean
}

/** One workspace the page can audit, as the host knows it. */
export interface WorkspaceRef {
  readonly id: string
  /** Canonical directory; rules are discovered from here and its ancestors. */
  readonly path: string
  readonly title: string
}

/** The Host-side service the browser half reads the audit through. */
export interface RulesAuditService {
  audit(): Promise<RuleAuditReport>
  /** Replace the report; discovery calls this after each pass. */
  publish(report: RuleAuditReport): void
  /**
   * Replace the whole disabled set.
   *
   * `ttsr.disabledRules` is matched by rule name against every discovered rule,
   * not just the bundled ones, so a project rule is as toggleable as a built-in
   * one. Names the current report has never heard of are refused.
   */
  setDisabled(names: readonly string[]): Promise<ToggleResult>
  /**
   * Set or clear one rule's interrupt-mode override.
   *
   * `ttsr.modeOverrides` is matched by rule name like `disabledRules`, so this
   * reaches every rule and not only the bundled ones — and it is the only way
   * to change the mode of one of the 27 rules that ship compiled into the
   * plugin, with no file behind them to edit. `undefined` (or the empty string
   * the wire carries it as) drops the override and puts the rule's own value,
   * or the profile default, back in charge.
   */
  setMode(name: string, mode: ModeRequest): Promise<ModeChangeResult>
  /** Rule names the page may toggle: everything the current report knows. */
  readonly toggleable: readonly string[]
  /**
   * Read one rule's source file.
   *
   * Resolved by rule name through the current report, never by a path the
   * caller supplies: the editor must be able to touch the file a rule was
   * actually discovered in and nothing else on the machine.
   */
  readRule(name: string): Promise<ReadRuleResult>
  /** Overwrite one rule's source file, the exact counterpart of `readRule`. */
  writeRule(name: string, content: string): Promise<ToggleResult>
  /** Registered workspaces the page may audit. */
  listWorkspaces(): WorkspaceRef[]
  /** Audit one workspace by absolute path; `''` clears back to no workspace. */
  openWorkspace(path: string): Promise<ToggleResult>
  /** Stop auditing, returning the page to its no-workspace state. */
  closeWorkspace(): void
  readonly typertRemote: { service: RulesAuditService; serviceKey: string; namespace: string }
}

/**
 * Build the audit service.
 *
 * `typertRemote` is a plain property rather than a decorator: the gateway binds
 * by it, and a hand-written manifest keeps a standalone plugin out of the
 * workspace-shaped code generation pipeline entirely.
 *
 * @param publish - receives each discovery pass.
 * @param toggle - persists a new disabled-rule set.
 */
export function createAuditService(
  /** Rebuilds the report from the current configuration. */
  recompute: () => Promise<RuleAuditReport>,
  /** The disabled set the report currently describes. */
  currentDisabled: () => readonly string[],
  /** Persists a new disabled-rule set. */
  toggle: (names: readonly string[]) => Promise<ToggleResult>,
  /** Persists one rule's interrupt-mode override; `undefined` clears it. */
  modeWriter: (name: string, mode: InterruptMode | undefined) => Promise<ModeWriteResult>,
  /** Reads a rule's backing file by name. */
  readRule: (name: string) => Promise<ReadRuleResult>,
  /** Writes a rule's backing file by name. */
  writeRule: (name: string, content: string) => Promise<ToggleResult>,
  /** Registered workspaces, for the page's open control. */
  listWorkspaces: () => WorkspaceRef[],
  /** @internal supplied by {@link provideAuditService} */
  /** Points the report at one workspace, or clears it when the path is empty. */
  openWorkspace: (path: string) => Promise<ToggleResult>,
  /**
   * Drops back to the no-workspace state.
   *
   * `explicit` marks a close the reader asked for, which must not be undone by
   * a session build still in flight. The host passes `true` from this service
   * and omits it when the last session simply went away.
   */
  closeWorkspace: (explicit?: boolean) => void,
): RulesAuditService {
  let report = EMPTY
  let rebuilding: Promise<RuleAuditReport> | undefined

  const refresh = (): Promise<RuleAuditReport> => {
    rebuilding ??= recompute().finally(() => { rebuilding = undefined })
    return rebuilding
  }

  let service: RulesAuditService
  service = {
    // A toggle writes the profile patch behind this page's back, and the report
    // it last published still describes the old configuration. Rebuilding on a
    // drifted disabled set keeps the page honest without depending on an edit
    // event a form write does not necessarily emit.
    audit: async () => {
      // A report describes one workspace. If that workspace is gone — removed
      // from the sidebar, renamed, deleted — its numbers are not this machine's
      // current truth, and showing them is worse than showing nothing.
      if (report.cwd !== '' && !directoryExists(report.cwd)) {
        return { ...EMPTY, stale: { cwd: report.cwd } }
      }
      // Compared only over the names this report knows: `ttsr.disabledRules` is
      // profile-wide, so a rule disabled while auditing workspace A is
      // legitimately missing from workspace B's report, and comparing the raw
      // lists would call that unresolvable drift and recompute on every poll.
      const known = new Set(report.rules.map(rule => rule.name))
      if (report.rules.length > 0 && !sameSet(currentDisabled().filter(name => known.has(name)), disabledOf(report))) {
        await refresh()
      }
      // Counts come straight from the ledger on every read: they change without
      // the rule set changing, and a stale snapshot would report zero.
      return { ...report, triggered: triggerCounts() }
    },
    publish: next => { report = next },

    readRule: name => readRule(name),

    async writeRule(name: string, content: string) {
      return writeRule(name, content)
    },

    listWorkspaces: () => listWorkspaces(),

    async openWorkspace(path: string) {
      if (path.trim() === '') {
        // An empty path is the reader clearing the panel on purpose, the same
        // as pressing Close: neither may be undone by a build already running.
        closeWorkspace(true)
        return { ok: true, disabled: disabledOf(report) }
      }
      return openWorkspace(path)
    },

    closeWorkspace: () => { closeWorkspace(true) },

    /** Read from the live report, so a new workspace's rules appear at once. */
    get toggleable() {
      // The bundled rules apply in every workspace, so they stay toggleable
      // when none is open.
      return [...new Set([...report.rules.map(rule => rule.name), ...builtinRuleNames()])].sort()
    },

    async setDisabled(requested: readonly string[]) {
      // `ttsr.disabledRules` is a profile-wide name list that `bucketRules`
      // matches against every rule it discovers, so a project rule is as
      // toggleable as a built-in one. The bundled names count as known with no
      // workspace open at all: they apply everywhere, and refusing them there
      // made the page offer switches the Host would then reject.
      const known = new Set([...report.rules.map(rule => rule.name), ...builtinRuleNames()])
      const unknown = requested.filter(name => !known.has(name))
      if (unknown.length > 0) {
        return {
          ok: false,
          guidance: `no rule by that name is in force here: ${unknown.join(', ')}. ` +
            'Open the workspace that declares it first; it may be filtered out of this one.',
          disabled: disabledOf(report),
        }
      }

      // The set is authoritative rather than incremental: a page that filters
      // and multi-selects can compute it from what it is showing, and a stale
      // selection cannot silently leave a rule half-on.
      const disabled = [...new Set(requested)].sort()
      const outcome = await toggle(disabled)
      if (!outcome.ok) return { ok: false, guidance: outcome.guidance, disabled: disabledOf(report) }

      const off = new Set(disabled)
      report = {
        ...report,
        // Every provider, to match `disabledOf`. Only rules whose switch moved
        // are touched: a rule that is off for another reason (`shadowed`,
        // `no-trigger`) keeps that reason rather than being reported as active.
        rules: report.rules.map(rule => (off.has(rule.name)
          ? { ...rule, active: false, reason: 'disabled' }
          : rule.reason === 'disabled'
            ? { ...rule, active: true, reason: undefined }
            : rule)),
      }
      return { ok: true, disabled }
    },

    /**
     * Set or clear one rule's interrupt-mode override.
     *
     * The report is rebuilt here rather than left to the next `audit()`, for
     * the reason `setDisabled` does the same: the page that made the change is
     * the one watching, and a row still reading `in force · never` after the
     * reader picked `always` says the click did nothing.
     */
    async setMode(name: string, requested: ModeRequest) {
      // Same known-name set as `setDisabled`: `ttsr.modeOverrides` is keyed by
      // rule name against everything discovery finds, so a project rule is as
      // adjustable as a bundled one, and the bundled names apply with no
      // workspace open.
      const known = new Set([...report.rules.map(rule => rule.name), ...builtinRuleNames()])
      if (!known.has(name)) {
        return {
          ok: false,
          guidance: `no rule by that name is in force here: ${name}. ` +
            'Open the workspace that declares it first; it may be filtered out of this one.',
        }
      }

      const mode = requested === '' || requested === undefined ? undefined : requested
      // The selector only offers the four modes, so this is a hand-written
      // call rather than a page bug — refused anyway, because an unknown mode
      // is stored verbatim and then ignored, leaving the reader believing it
      // took.
      if (mode !== undefined && !INTERRUPT_MODES.includes(mode)) {
        return {
          ok: false,
          guidance: `${String(requested)} is not an interrupt mode; use one of ${INTERRUPT_MODES.join(', ')}.`,
        }
      }

      const written = await modeWriter(name, mode)
      if (!written.ok) {
        return {
          ok: false,
          guidance: 'guidance' in written
            ? written.guidance
            : 'Three attempts to save the mode change were each overtaken by another one. Try again.',
        }
      }

      report = {
        ...report,
        rules: report.rules.map(rule => (rule.name === name ? withMode(rule, mode) : rule)),
      }
      return { ok: true, mode }
    },

    typertRemote: {
      get service() {
        return service
      },
      serviceKey: 'dshRules',
      namespace: 'dshRules',
    },
  }

  return service
}

/**
 * Rule names the report shows as switched off.
 *
 * Keyed on `reason === 'disabled'` over *every* provider, not on
 * `provider === 'builtin-defaults'`: `setDisabled` deliberately accepts any
 * discovered rule name, and `ttsr.disabledRules` matches by name against
 * everything discovery finds. Filtering to the bundled ones could therefore
 * never contain a switched-off project rule, so the drift check below stayed
 * true forever and every `audit()` call paid a full recompute — walking every
 * ancestor directory and `homedir()` — for a page that polls.
 *
 * Only names this report knows can appear here, which is also why the drift
 * check has to narrow the other side to the same set: `ttsr.disabledRules` is
 * profile-wide, so a rule disabled while auditing workspace A is legitimately
 * absent from workspace B's report and comparing the raw lists would report
 * drift that a recompute can never resolve.
 */
function disabledOf(report: RuleAuditReport): string[] {
  return report.rules.filter(rule => rule.reason === 'disabled').map(rule => rule.name)
}

/**
 * One report row as it reads with `mode` in force.
 *
 * Clearing an override puts the rule's own value back, which is why the row
 * carries it: by the time the reader clears, `interruptMode` is the override
 * and says nothing about what the rule itself asked for. A rule that declared
 * none falls back to the profile's `ttsr.interruptMode`, which is what an
 * absent mode means everywhere else on the page.
 */
function withMode(rule: RuleAuditRow, mode: InterruptMode | undefined): RuleAuditRow {
  if (mode === undefined) return { ...rule, interruptMode: rule.ownInterruptMode, modeOverride: undefined }
  return { ...rule, interruptMode: mode, modeOverride: mode }
}

/** Compare two name sets without regard to order. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(name => right.includes(name))
}

/**
 * Mount the audit service and return the publisher discovery should write to.
 * @param ctx - host plugin context.
 * @param toggle - persists a new disabled-rule set.
 */
export function provideAuditService(
  ctx: Context,
  recompute: () => Promise<RuleAuditReport>,
  currentDisabled: () => readonly string[],
  toggle: (names: readonly string[]) => Promise<ToggleResult>,
  modeWriter: (name: string, mode: InterruptMode | undefined) => Promise<ModeWriteResult>,
  readRule: (name: string) => Promise<ReadRuleResult>,
  writeRule: (name: string, content: string) => Promise<ToggleResult>,
  listWorkspaces: () => WorkspaceRef[],
  openWorkspace: (path: string) => Promise<ToggleResult>,
  closeWorkspace: (explicit?: boolean) => void,
): AuditPublisher {
  const service = createAuditService(
    recompute, currentDisabled, toggle, modeWriter, readRule, writeRule, listWorkspaces, openWorkspace, closeWorkspace)
  ctx.provide('dshRules', service)
  return report => service.publish(report)
}
