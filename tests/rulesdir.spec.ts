import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveRuleDir, ruleDirPair } from '../src/rulesdir.ts'
import { migrateRules, renderMigration } from '../src/migrate.ts'

/**
 * Rules go to whichever convention the scope already uses.
 *
 * The two directories are otherwise indistinguishable to a reader, so the
 * choice is only defensible if it follows what is already there: a workspace
 * with OMP rules keeps getting OMP rules, and a workspace with none gets the
 * dsh path instead of being converted to OMP by a single rule.
 */

let root: string
let cwd: string
let home: string
let userRulesDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rulesdir-'))
  cwd = join(root, 'project')
  home = join(root, 'home')
  userRulesDir = join(home, '.omp', 'agent')
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })
  process.env['DSH_HOME'] = join(home, '.dsh')
})

afterEach(async () => {
  delete process.env['DSH_HOME']
  await rm(root, { recursive: true, force: true })
})

const writeRule = async (dir: string, name: string, body = 'Body.\n'): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${name}.md`), `---\ndescription: ${name}\n---\n\n${body}`, 'utf8')
}

describe('resolveRuleDir', () => {
  it('uses the OMP directory when that scope already holds rules there', async () => {
    await writeRule(join(cwd, '.omp', 'rules'), 'existing')

    const resolved = await resolveRuleDir('project', cwd, userRulesDir)
    expect(resolved.convention).toBe('omp')
    expect(resolved.path).toBe(join(cwd, '.omp', 'rules'))
  })

  it('uses the dsh directory when the scope has no OMP rules', async () => {
    const resolved = await resolveRuleDir('project', cwd, userRulesDir)
    expect(resolved.convention).toBe('dsh')
    expect(resolved.path).toBe(join(cwd, '.dsh', 'rules'))
  })

  it('ignores an empty .omp directory rather than treating it as a convention', async () => {
    // An `.omp` left behind by an unrelated tool holds no rules, so it says
    // nothing about which convention this workspace follows.
    await mkdir(join(cwd, '.omp'), { recursive: true })
    expect((await resolveRuleDir('project', cwd, userRulesDir)).convention).toBe('dsh')
  })

  it('resolves the global scope independently of the project one', async () => {
    await writeRule(join(cwd, '.omp', 'rules'), 'project-rule')

    // The project is an OMP workspace; the user's own directory is not, so the
    // two scopes must not drag each other along.
    const project = await resolveRuleDir('project', cwd, userRulesDir)
    const global = await resolveRuleDir('global', cwd, userRulesDir)
    expect(project.convention).toBe('omp')
    expect(global.convention).toBe('dsh')
    expect(global.path).toBe(join(home, '.dsh', 'rules'))
  })

  it('resolves the global scope onto OMP when the user already has rules there', async () => {
    await writeRule(join(userRulesDir, 'rules'), 'mine')
    const global = await resolveRuleDir('global', cwd, userRulesDir)
    expect(global.convention).toBe('omp')
    expect(global.path).toBe(join(userRulesDir, 'rules'))
  })

  it('creates nothing while deciding', async () => {
    await resolveRuleDir('project', cwd, userRulesDir)
    // Discovery calls this on every pass; a resolver that created the directory
    // would give the dsh path a rule set on a workspace that never had one.
    await expect(readdir(join(cwd, '.dsh')).then(() => true, () => false)).resolves.toBe(false)
  })
})

describe('migrateRules', () => {
  it('moves every rule and leaves the source empty', async () => {
    const from = join(cwd, '.omp', 'rules')
    const to = join(cwd, '.dsh', 'rules')
    await writeRule(from, 'alpha')
    await writeRule(from, 'beta')

    const result = await migrateRules({ from, to, fromConvention: 'omp', toConvention: 'dsh' })

    expect(result.moved.map(entry => entry.outcome)).toEqual(['moved', 'moved'])
    expect(await readdir(from)).toEqual([])
    expect((await readdir(to)).sort()).toEqual(['alpha.md', 'beta.md'])
    // The bytes move unchanged: a migration is a change of directory, not of
    // what the rule says.
    expect(await readFile(join(to, 'alpha.md'), 'utf8')).toContain('description: alpha')
  })

  it('leaves a rule whose name is already taken at the destination', async () => {
    // Two files claiming one name means only one applies, and the loser is
    // invisible in the audit — so the existing rule wins and the other stays.
    const from = join(cwd, '.omp', 'rules')
    const to = join(cwd, '.dsh', 'rules')
    await writeRule(from, 'shared', 'the omp one\n')
    await writeRule(to, 'shared', 'the dsh one\n')
    await writeRule(from, 'only-mine')

    const result = await migrateRules({ from, to, fromConvention: 'omp', toConvention: 'dsh' })

    const shared = result.moved.find(entry => entry.name === 'shared')
    expect(shared?.outcome).toBe('name-taken')
    expect(shared?.detail).toContain('already has a rule named shared')
    expect(await readFile(join(from, 'shared.md'), 'utf8')).toContain('the omp one')
    expect(await readFile(join(to, 'shared.md'), 'utf8')).toContain('the dsh one')
    expect(await readdir(from)).toContain('shared.md')
    // The one that could move still did.
    expect(result.moved.find(entry => entry.name === 'only-mine')?.outcome).toBe('moved')
  })

  it('refuses to move sticky RULES.md', async () => {
    // Sticky rules resolve by the directory they sit in, so moving the file
    // would silently change which workspace it governs.
    const from = join(cwd, '.omp', 'rules')
    const to = join(cwd, '.dsh', 'rules')
    await writeRule(from, 'RULES')

    const result = await migrateRules({ from, to, fromConvention: 'omp', toConvention: 'dsh' })
    expect(result.moved[0]?.outcome).toBe('name-taken')
    expect(result.moved[0]?.detail).toContain('sticky')
    expect(await readdir(from)).toContain('RULES.md')
  })

  it('reports nothing to move for an absent source', async () => {
    const result = await migrateRules({
      from: join(cwd, 'never-existed'),
      to: join(cwd, '.dsh', 'rules'),
      fromConvention: 'omp',
      toConvention: 'dsh',
    })
    expect(result.empty).toBe(true)
  })

  it('does nothing when asked to move a directory onto itself', async () => {
    const dir = join(cwd, '.omp', 'rules')
    await writeRule(dir, 'alpha')
    const result = await migrateRules({ from: dir, to: dir, fromConvention: 'omp', toConvention: 'omp' })
    expect(result.empty).toBe(true)
    expect(renderMigration(result)).toContain('already holds the rules')
    expect(await readdir(dir)).toEqual(['alpha.md'])
  })

  it('creates the destination when it is missing', async () => {
    const from = join(cwd, '.omp', 'rules')
    const to = join(cwd, '.dsh', 'rules')
    await writeRule(from, 'alpha')
    await migrateRules({ from, to, fromConvention: 'omp', toConvention: 'dsh' })
    expect(await readdir(to)).toEqual(['alpha.md'])
  })
})

describe('ruleDirPair', () => {
  it('exposes both sides for one scope', async () => {
    const pair = await ruleDirPair('project', cwd, userRulesDir)
    expect(pair.omp).toEqual({ path: join(cwd, '.omp', 'rules'), convention: 'omp' })
    expect(pair.dsh).toEqual({ path: join(cwd, '.dsh', 'rules'), convention: 'dsh' })
  })

  it('gives the global pair the user-level and home-level directories', async () => {
    const pair = await ruleDirPair('global', cwd, userRulesDir)
    expect(pair.omp.path).toBe(join(userRulesDir, 'rules'))
    expect(pair.dsh.path).toBe(join(home, '.dsh', 'rules'))
  })
})

describe('renderMigration', () => {
  it('reports what moved and what did not, and asks for it to be told to the user', () => {
    const text = renderMigration({
      from: '/a',
      to: '/b',
      moved: [
        { name: 'one', outcome: 'moved', detail: 'moved to /b' },
        { name: 'two', outcome: 'name-taken', detail: '/b already has a rule named two' },
      ],
      empty: false,
    })
    expect(text).toContain('1 of 2 rule(s) moved')
    expect(text).toContain('one: moved to /b')
    expect(text).toContain('two: left alone')
    expect(text).toContain('Report this to the user')
  })
})
