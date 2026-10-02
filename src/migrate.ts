/**
 * Moving rule files between the two conventions.
 *
 * Both sides of a move are directories the discovery pass already reads, so
 * moving a rule is a change of directory rather than a change of meaning: the
 * name, the body and what the rule does are untouched.
 *
 * Every move is refused rather than guessed. A rule whose name already exists
 * at the destination is left alone and reported, because two files claiming one
 * name means only one of them applies and the loser is invisible in the audit.
 * Nothing is deleted at the source until the destination write succeeds, so an
 * interrupted move leaves the rules where they were.
 */

import { copyFile, readdir, mkdir, rename, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** Which pair of directories a move runs between. */
export interface MigrationPlan {
  /** Absolute directory the rules are read from. */
  readonly from: string
  /** Absolute directory they are written to. */
  readonly to: string
  /** Which convention each side belongs to. */
  readonly fromConvention: 'omp' | 'dsh'
  readonly toConvention: 'omp' | 'dsh'
}

const MARKDOWN = /\.mdc?$/

/** One rule file's outcome. */
export interface MovedRule {
  /** The rule's name, without the extension. */
  readonly name: string
  /** `moved`, or the reason it was left behind. */
  readonly outcome: 'moved' | 'name-taken' | 'failed'
  /** Prose for the model and the panel. */
  readonly detail: string
}

/** What a migration did, in full. */
export interface MigrationResult {
  readonly from: string
  readonly to: string
  readonly moved: MovedRule[]
  /** True when there was nothing to move; not an error. */
  readonly empty: boolean
}

/** Rule files sitting in one directory, by rule name. */
async function ruleFilesIn(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !MARKDOWN.test(entry.name)) continue
      files.set(basename(entry.name).replace(MARKDOWN, ''), join(dir, entry.name))
    }
  } catch {
    // A directory that is not there holds nothing. That is the common case for
    // whichever side the user has never used.
  }
  return files
}

/**
 * Move one file, coping with a destination on another filesystem.
 *
 * `rename` is a directory entry operation and fails with `EXDEV` when the two
 * paths are on different volumes — a project on an external drive while
 * `$DSH_HOME` is on the internal one, or a workspace inside a container mount.
 * Those users are not an edge case, so the fallback is copy-then-unlink rather
 * than an error they cannot work around.
 *
 * Unlinking only after the copy succeeds is what keeps an interrupted move
 * from losing the rule: a failed copy leaves the original exactly where it was.
 */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  await copyFile(from, to)
  await unlink(from)
}

/**
 * Move every rule from one directory to another.
 *
 * Refuses a same-directory move outright: it would otherwise report a file as
 * "moved" onto itself, or fail on every name as already taken, and neither is
 * something the caller can act on.
 *
 * @param plan - the two directories and the conventions they belong to.
 * @returns one entry per rule found, in name order.
 */
export async function migrateRules(plan: MigrationPlan): Promise<MigrationResult> {
  if (plan.from === plan.to) {
    return { from: plan.from, to: plan.to, moved: [], empty: true }
  }
  const source = await ruleFilesIn(plan.from)
  const destination = await ruleFilesIn(plan.to)
  // `RULES.md` is sticky in both conventions and is looked up by the directory
  // it sits in, not by name, so moving it would silently change which workspace
  // it applies to.
  const moved: MovedRule[] = []

  await mkdir(plan.to, { recursive: true })
  for (const name of [...source.keys()].sort()) {
    if (name === 'RULES') {
      moved.push({ name, outcome: 'name-taken', detail: 'RULES.md is sticky and belongs to the directory it sits in, so it stays where it is.' })
      continue
    }
    if (destination.has(name)) {
      moved.push({ name, outcome: 'name-taken', detail: `${plan.to} already has a rule named ${name}; that one already applies, so this file was left in place.` })
      continue
    }
    try {
      await moveFile(source.get(name)!, join(plan.to, `${name}.md`))
      moved.push({ name, outcome: 'moved', detail: `moved to ${plan.to}` })
    } catch (error) {
      moved.push({ name, outcome: 'failed', detail: `could not move it: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return { from: plan.from, to: plan.to, moved, empty: moved.length === 0 }
}

/** Prose for one migration result, addressed to the model that asked. */
export function renderMigration(result: MigrationResult): string {
  if (result.from === result.to) {
    return `${result.from} already holds the rules; there is nothing to move between it and itself.`
  }
  if (result.empty) {
    return `No rule files in ${result.from}, so nothing moved.`
  }
  const lines = result.moved.map(entry =>
    entry.outcome === 'moved' ? `${entry.name}: ${entry.detail}` : `${entry.name}: left alone — ${entry.detail}`)
  const count = result.moved.filter(entry => entry.outcome === 'moved').length
  return [
    `${count} of ${result.moved.length} rule(s) moved from ${result.from} to ${result.to}.`,
    ...lines,
    'Report this to the user: files changed directory on their disk, and anything left alone is still there.',
  ].join('\n')
}