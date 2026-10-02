/**
 * Rule discovery providers.
 *
 * Each provider scans one configuration convention and normalizes every file it
 * finds through {@link buildRuleFromMarkdown}. Priorities match OMP's
 * `rulebook-matching-pipeline` exactly, because capability identity is the rule
 * name alone and the highest-priority provider wins that name.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseFrontmatter } from './frontmatter.ts'
import { buildRuleFromMarkdown, type Rule, type RuleSource } from './rule.ts'

/** Roots and toggles the discovery pass reads. */
export interface DiscoveryOptions {
  /** Session workspace root; project rules are discovered beneath it. */
  cwd: string
  /** OMP's native agent directory, `~/.omp/agent` by default. */
  userRulesDir: string
  /** Roots whose `rules/` subdirectory holds OMP-format plugin rules. */
  pluginRoots: readonly string[]
  /** Comma-separated override mirroring `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`. */
  copilotInstructionDirs: readonly string[]
}

/** One provider's contribution before cross-provider deduplication. */
export interface ProviderResult {
  /** Provider id, used for priority and `builtinRules` filtering. */
  provider: string
  /** Rules in the provider's own discovery order. */
  rules: Rule[]
  /** Non-fatal discovery problems. */
  warnings: string[]
}

/** Provider priorities, highest first. */
export const PROVIDER_PRIORITY: Readonly<Record<string, number>> = {
  native: 100,
  'omp-plugins': 90,
  agents: 70,
  cursor: 50,
  windsurf: 50,
  cline: 40,
  github: 30,
  'builtin-defaults': 1,
}

const MARKDOWN = /\.mdc?$/
const RULE_EXTENSIONS = new Set(['.md', '.mdc'])

/**
 * List the `.md`/`.mdc` files directly inside one directory.
 *
 * Known trade-off, deliberately left as-is: `withFileTypes` reports a symlink
 * as `isSymbolicLink()`, so a symlinked rule file is skipped here — even though
 * `statPath` in this same file follows links through `stat`, so the two
 * disagree. This matches what OMP is believed to do and is left alone until it
 * can be checked against OMP directly rather than guessed at. `walkMarkdown`
 * filters the same way.
 */
async function listRuleFiles(dir: string, warnings: string[]): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && MARKDOWN.test(entry.name))
      .map(entry => join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

/** Report whether a path exists and, for directories, holds anything. */
async function statPath(path: string): Promise<{ exists: boolean; isDir: boolean; isFile: boolean; empty: boolean }> {
  try {
    const info = await stat(path)
    if (info.isDirectory()) {
      const entries = await readdir(path)
      return { exists: true, isDir: true, isFile: false, empty: entries.length === 0 }
    }
    return { exists: true, isDir: false, isFile: true, empty: false }
  } catch {
    return { exists: false, isDir: false, isFile: false, empty: false }
  }
}

/** Read and normalize every rule file in one directory. */
async function rulesFromDir(dir: string, source: RuleSource, warnings: string[]): Promise<Rule[]> {
  const files = await listRuleFiles(dir, warnings)
  const rules: Rule[] = []
  for (const file of files) {
    const rule = await ruleFromFile(file, source, warnings)
    if (rule !== undefined) rules.push(rule)
  }
  return rules
}

/**
 * Read one file and normalize it into a rule.
 *
 * An unreadable file — permissions, an editor's atomic save that removes the
 * inode between `readdir` and `readFile` — degrades to a warning instead of
 * failing the whole pass. Discovery throws into `RuleSessionStore.ensure`,
 * whose rejection reaches synchronous surfaces like `get()` with no handler
 * attached, which is a process-killing unhandled rejection rather than one
 * missing rule.
 *
 * Returns nothing for such a file: a rule built from no content would still
 * claim the name and shadow a readable one further down the provider's list.
 */
async function ruleFromFile(file: string, source: RuleSource, warnings: string[]): Promise<Rule | undefined> {
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    warnings.push(`${nameFromPath(file)}: unreadable (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
  return buildRuleFromMarkdown({ name: nameFromPath(file), path: file, content, source })
}

/**
 * Short name for a discovered tree: the directory's own name.
 *
 * A filesystem root has no name of its own to offer, so it is spelled out
 * rather than reduced to an empty label.
 */
export function scopeOf(dir: string): string {
  // `basename`, not a split on `/`: a Windows path carries neither, so the
  // split returned the whole `C:\a\b` and that string became the scope label
  // the audit page prints beside each rule.
  return basename(resolve(dir)) || dir
}

/** Rule name from a file path: the basename without `.md`/`.mdc`. */
export function nameFromPath(file: string): string {
  // This name becomes a `disabledRules` entry and a `rule://` lookup key, so a
  // path it cannot cut down to the filename must not become the name.
  return basename(file).replace(MARKDOWN, '')
}

/** Every ancestor directory from `cwd` up to the filesystem root. */
function ancestors(cwd: string): string[] {
  const chain: string[] = []
  let current = resolve(cwd)
  for (;;) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return chain
}

/**
 * Native provider: OMP's own `.omp` conventions.
 *
 * Order matters because sticky `RULES.md` files share one name: project rules,
 * user rules, user sticky, then the nearest project sticky, so the user sticky
 * shadows the project one and a `rules/RULES.md` shadows both.
 */
export async function loadNative(options: DiscoveryOptions): Promise<ProviderResult> {
  const warnings: string[] = []
  const source: RuleSource = { provider: 'native', path: '', priority: PROVIDER_PRIORITY.native! }
  const rules: Rule[] = []
  const projectOmp = join(options.cwd, '.omp')

  if ((await statPath(projectOmp)).empty === false) {
    rules.push(...await rulesFromDir(join(projectOmp, 'rules'), { ...source, scope: scopeOf(options.cwd) }, warnings))
  }

  const userDir = options.userRulesDir
  rules.push(...await rulesFromDir(
    join(userDir, 'rules'),
    { ...source, path: join(userDir, 'rules'), scope: '~' },
    warnings))

  const sticky = async (path: string, from: RuleSource = source): Promise<void> => {
    if ((await statPath(path)).isFile) {
      rules.push(await buildStickyRule(path, from))
    }
  }
  await sticky(join(userDir, 'RULES.md'), { ...source, scope: '~' })

  for (const ancestor of ancestors(options.cwd)) {
    const ompDir = join(ancestor, '.omp')
    if ((await statPath(ompDir)).empty === false) {
      await sticky(join(ompDir, 'RULES.md'), { ...source, scope: scopeOf(ancestor) })
      break
    }
  }

  return { provider: 'native', rules, warnings }
}

/** Build the sticky top-level `RULES.md` rule, which is always applied. */
async function buildStickyRule(path: string, source: RuleSource): Promise<Rule> {
  const content = await readFile(path, 'utf8')
  return buildRuleFromMarkdown({
    name: 'RULES',
    path,
    content,
    source: { ...source, path },
    overrides: { name: 'RULES', alwaysApply: true },
  })
}

/**
 * Agents provider: `.agent` and `.agents` rule directories.
 *
 * Project ancestors are walked before the user directories, matching OMP.
 */
export async function loadAgents(options: DiscoveryOptions): Promise<ProviderResult> {
  const warnings: string[] = []
  const source: RuleSource = { provider: 'agents', path: '', priority: PROVIDER_PRIORITY.agents! }
  const rules: Rule[] = []

  for (const ancestor of ancestors(options.cwd)) {
    for (const dir of ['.agent', '.agents']) {
      rules.push(...await rulesFromDir(join(ancestor, dir, 'rules'), { ...source, path: dir }, warnings))
    }
  }

  const home = homedir()
  for (const dir of ['.agent', '.agents']) {
    rules.push(...await rulesFromDir(join(home, dir, 'rules'), { ...source, path: dir }, warnings))
  }

  return { provider: 'agents', rules, warnings }
}

/**
 * Cursor provider: `<cwd>/.cursor/rules` and `~/.cursor/rules`.
 *
 * Project first, user global second, matching `loadNative`. The provider merge
 * is first-wins, so the order decides which of two same-named rules survives:
 * the project's `style.md` is the more specific one and must beat the user's
 * global copy of the same name.
 *
 * Cursor's `alwaysApply` is normalized the way OMP does it: only a literal
 * `true` applies, anything else becomes `false`.
 */
export async function loadCursor(options: DiscoveryOptions): Promise<ProviderResult> {
  const warnings: string[] = []
  const source: RuleSource = { provider: 'cursor', path: '', priority: PROVIDER_PRIORITY.cursor! }
  const rules: Rule[] = []

  for (const dir of [join(options.cwd, '.cursor', 'rules'), join(homedir(), '.cursor', 'rules')]) {
    for (const file of await listRuleFiles(dir, warnings)) {
      const rule = await ruleFromFile(file, { ...source, path: file }, warnings)
      if (rule === undefined) continue
      rules.push({ ...rule, alwaysApply: rule.alwaysApply === true })
    }
  }

  return { provider: 'cursor', rules, warnings }
}

/**
 * Windsurf provider: the project rules plus the user global rules file.
 *
 * Project first for the same reason as `loadCursor`: the merge is first-wins, so
 * a project rule of the same name is the one that has to survive.
 */
export async function loadWindsurf(options: DiscoveryOptions): Promise<ProviderResult> {
  const warnings: string[] = []
  const source: RuleSource = { provider: 'windsurf', path: '', priority: PROVIDER_PRIORITY.windsurf! }
  const rules: Rule[] = []

  rules.push(...await rulesFromDir(join(options.cwd, '.windsurf', 'rules'), source, warnings))

  const global = join(homedir(), '.codeium', 'windsurf', 'memories', 'global_rules.md')
  if ((await statPath(global)).isFile) {
    try {
      const content = await readFile(global, 'utf8')
      rules.push(buildRuleFromMarkdown({ name: 'global_rules', path: global, content, source: { ...source, path: global } }))
    } catch (error) {
      warnings.push(`global_rules: unreadable (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  return { provider: 'windsurf', rules, warnings }
}

/** Cline provider: the nearest `.clinerules`, as a file or a directory. */
export async function loadCline(options: DiscoveryOptions): Promise<ProviderResult> {
  const warnings: string[] = []
  const source: RuleSource = { provider: 'cline', path: '', priority: PROVIDER_PRIORITY.cline! }

  for (const ancestor of ancestors(options.cwd)) {
    const target = join(ancestor, '.clinerules')
    const info = await statPath(target)
    if (!info.exists) continue

    if (info.isDir) {
      return { provider: 'cline', rules: await rulesFromDir(target, { ...source, path: target }, warnings), warnings }
    }
    const content = await readFile(target, 'utf8')
    return {
      provider: 'cline',
      rules: [buildRuleFromMarkdown({ name: 'clinerules', path: target, content, source: { ...source, path: target } })],
      warnings,
    }
  }

  return { provider: 'cline', rules: [], warnings }
}

/**
 * GitHub provider: `.github/instructions/*.instructions.md`.
 *
 * Copilot's `applyTo` maps onto `globs`; `*` and `**` mean always-apply with no
 * globs, and a missing description is synthesized from the globs.
 */
export async function loadGithub(options: DiscoveryOptions): Promise<ProviderResult> {
  const warnings: string[] = []
  const source: RuleSource = { provider: 'github', path: '', priority: PROVIDER_PRIORITY.github! }
  const rules: Rule[] = []

  const roots = [
    join(options.cwd, '.github', 'instructions'),
    ...options.copilotInstructionDirs.map(dir => join(dir, '.github', 'instructions')),
  ]

  for (const root of roots) {
    for (const file of await walkMarkdown(root)) {
      rules.push(await githubRuleFromFile(file, { ...source, path: file }, warnings))
    }
  }

  return { provider: 'github', rules, warnings }
}

/** Build one Copilot instruction rule, stripping the `.instructions.md` suffix. */
async function githubRuleFromFile(file: string, source: RuleSource, warnings: string[]): Promise<Rule> {
  const content = await readFile(file, 'utf8')
  const rule = buildRuleFromMarkdown({
    // `basename` first: a Windows path has no `/` to split on, and the whole
    // absolute path would become the rule name — and so a `disabledRules`
    // entry and a `rule://` lookup key containing a drive letter.
    name: basename(file.replace(/\.instructions\.md$/, '')),
    path: file,
    content,
    source,
  })
  return applyGithubApplyTo(rule, parseFrontmatter(content).data.applyTo, warnings)
}

/** Normalize one Copilot `applyTo` field onto the shared rule shape. */
function applyGithubApplyTo(rule: Rule, raw: unknown, warnings: string[]): Rule {
  const globs = typeof raw === 'string' ? raw.split(',').map(part => part.trim()).filter(part => part !== '')
    : Array.isArray(raw) ? raw.filter((part): part is string => typeof part === 'string')
    : []

  if (globs.length === 0) {
    if (rule.description === undefined) {
      warnings.push(`${rule.name}: missing applyTo produced a rulebook-only rule`)
    }
    return rule
  }
  if (globs.some(glob => glob === '*' || glob === '**' || glob === '**/*')) {
    return { ...rule, alwaysApply: true, globs: undefined }
  }
  return {
    ...rule,
    alwaysApply: false,
    globs,
    description: rule.description ?? `Applies to ${globs.join(', ')}`,
  }
}

/**
 * Recursively collect `.instructions.md` files below one root.
 *
 * Same deliberate symlink trade-off as `listRuleFiles`: `isFile()` excludes
 * links, pending a check against OMP's own scan.
 */
async function walkMarkdown(root: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...await walkMarkdown(path))
    else if (entry.isFile() && entry.name.endsWith('.instructions.md')) found.push(path)
  }
  return found
}

/** OMP-plugins provider: `rules/` directories inside configured package roots. */
export async function loadOmpPlugins(options: DiscoveryOptions): Promise<ProviderResult> {
  const warnings: string[] = []
  const source: RuleSource = { provider: 'omp-plugins', path: '', priority: PROVIDER_PRIORITY['omp-plugins']! }
  const rules: Rule[] = []

  for (const root of options.pluginRoots) {
    const dir = join(root, 'rules')
    const entries = await listRuleFiles(dir, warnings)
    for (const file of entries.filter(entry => RULE_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.'))))) {
      const rule = await ruleFromFile(file, { ...source, path: file }, warnings)
      if (rule !== undefined) rules.push(rule)
    }
  }

  return { provider: 'omp-plugins', rules, warnings }
}

/** Run every provider and concatenate their contributions in priority order. */
export async function discoverAll(options: DiscoveryOptions): Promise<ProviderResult[]> {
  return [
    await loadNative(options),
    await loadOmpPlugins(options),
    await loadAgents(options),
    await loadCursor(options),
    await loadWindsurf(options),
    await loadCline(options),
    await loadGithub(options),
  ]
}
