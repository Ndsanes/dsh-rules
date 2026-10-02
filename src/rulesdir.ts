/**
 * Where a rule file should be written.
 *
 * Two conventions are in play. OMP keeps project rules in `<cwd>/.omp/rules`
 * and user rules in `~/.omp/agent/rules`. dsh has no rules directory of its
 * own — it reads `<cwd>/.dsh/AGENTS.md`, `<cwd>/.dsh/skills` and the matching
 * paths under `$DSH_HOME`, and nothing rule-shaped — so the dsh-side paths
 * here follow that `.dsh/<thing>` and `$DSH_HOME/<thing>` shape rather than
 * inventing a third layout.
 *
 * The choice between them is OMP-first: a workspace that already has rules
 * under `.omp` is an OMP workspace, and a new rule written somewhere else
 * would be governed by one convention and listed under another. Only a
 * workspace with no OMP rules at all gets the dsh path, which is also the
 * workspace least likely to be shared with OMP.
 */

import { mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Which set of rules a write belongs to. */
export type RuleScope = 'project' | 'global'

/** Which convention owns a directory, and which scope it belongs to. */
export interface RuleLocation {
  /** Project rules travel with the workspace; global ones do not. */
  readonly scope: RuleScope
  /** Which convention owns it, for the panel to show. */
  readonly convention: 'omp' | 'dsh'
}

/** The absolute directory one scope-and-convention pair resolves to. */
export function ruleDir(location: RuleLocation, cwd: string, userRulesDir: string): string {
  return location.convention === 'omp'
    ? ompDir(location.scope, cwd, userRulesDir)
    : dshDir(location.scope, cwd)
}

/** A directory a write resolved to, with the convention that chose it. */
export interface ResolvedRuleDir {
  /** Absolute directory rule files are read from and written to. */
  readonly path: string
  /** Which convention owns it, for the panel to show. */
  readonly convention: 'omp' | 'dsh'
}

const MARKDOWN = /\.mdc?$/

/** Whether a directory holds at least one rule file. */
async function holdsRules(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.some(entry => entry.isFile() && MARKDOWN.test(entry.name))
  } catch {
    // A directory that does not exist yet is the common case, and it means the
    // same thing here: this convention has no rules to speak for it.
    return false
  }
}

/** `$DSH_HOME`, defaulting the way the host does. */
export function dshHome(): string {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/** The dsh-side rules directory under `$DSH_HOME`, for discovery to read. */
export function dshRulesHome(): string {
  return dshHome()
}

/** The OMP directory for one scope. */
function ompDir(scope: RuleScope, cwd: string, userRulesDir: string): string {
  return scope === 'project' ? join(cwd, '.omp', 'rules') : join(userRulesDir, 'rules')
}

/** The dsh directory for one scope. */
function dshDir(scope: RuleScope, cwd: string): string {
  return scope === 'project' ? join(cwd, '.dsh', 'rules') : join(dshHome(), 'rules')
}

/**
 * Resolve where a rule file for one scope should go.
 *
 * @param scope - project rules travel with the workspace; global ones do not.
 * @param cwd - the workspace root.
 * @param userRulesDir - OMP's user-level rules root, `~/.omp/agent` by default.
 * @returns the directory to write into and which convention it belongs to.
 */
export async function resolveRuleDir(
  scope: RuleScope,
  cwd: string,
  userRulesDir: string,
): Promise<ResolvedRuleDir> {
  const omp = ompDir(scope, cwd, userRulesDir)
  // Presence of the directory alone is not the test — an `.omp` left behind by
  // an unrelated tool would otherwise capture every rule written into a dsh
  // workspace. A directory that actually holds rules is the signal.
  if (await holdsRules(omp)) return { path: omp, convention: 'omp' }
  return { path: dshDir(scope, cwd), convention: 'dsh' }
}

/**
 * Both directories for one scope, for the migration action.
 *
 * Ordered the same way {@link resolveRuleDir} ranks them, so "move everything
 * off OMP" and "move everything onto dsh" are expressible without either side
 * being special-cased.
 */
export async function ruleDirPair(
  scope: RuleScope,
  cwd: string,
  userRulesDir: string,
): Promise<{ omp: ResolvedRuleDir; dsh: ResolvedRuleDir }> {
  return {
    omp: { path: ompDir(scope, cwd, userRulesDir), convention: 'omp' },
    dsh: { path: dshDir(scope, cwd), convention: 'dsh' },
  }
}

/** Create the directory a write is about to land in. */
export async function ensureRuleDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}