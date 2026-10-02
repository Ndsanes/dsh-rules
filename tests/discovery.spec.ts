import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  loadCline,
  loadCursor,
  loadGithub,
  loadNative,
  loadOmpPlugins,
  loadWindsurf,
  nameFromPath,
  scopeOf,
  type DiscoveryOptions,
} from '../src/discovery.ts'

let root: string
let home: string
let cwd: string

/** Discovery options pointed at the fixture tree, with an empty user dir. */
function options(overrides: Partial<DiscoveryOptions> = {}): DiscoveryOptions {
  return { cwd, userRulesDir: join(home, 'agent'), pluginRoots: [], copilotInstructionDirs: [], ...overrides }
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rules-'))
  home = join(root, 'home')
  cwd = join(root, 'project')
  await mkdir(join(cwd, '.omp', 'rules'), { recursive: true })
  await mkdir(join(home, 'agent', 'rules'), { recursive: true })

  await write(join(cwd, '.omp', 'rules', 'project.md'), '---\ndescription: project rule\nglobs: "**/*.ts"\n---\nproject body\n')
  await write(join(cwd, '.omp', 'RULES.md'), 'project sticky\n')
  await write(join(home, 'agent', 'RULES.md'), 'user sticky\n')
  await write(join(home, 'agent', 'rules', 'user.md'), '---\ndescription: user rule\n---\nuser body\n')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('nameFromPath', () => {
  it('drops the markdown extension only', () => {
    expect(nameFromPath('/a/b/my.rule.md')).toBe('my.rule')
    expect(nameFromPath('/a/b/my.mdc')).toBe('my')
  })
})

describe('loadNative', () => {
  it('discovers project rules, user rules, and both sticky files', async () => {
    const result = await loadNative(options())
    const byName = new Map<string, (typeof result.rules)[number]>()
    for (const item of result.rules) if (!byName.has(item.name)) byName.set(item.name, item)

    expect(byName.get('project')?.content).toBe('project body')
    expect(byName.get('project')?.globs).toEqual(['**/*.ts'])
    expect(byName.get('user')?.content).toBe('user body')
    expect(byName.get('RULES')?.content).toBe('user sticky')
    expect(byName.get('RULES')?.alwaysApply).toBe(true)
  })

  it('orders project rules before user rules and sticky files last', async () => {
    const result = await loadNative(options())
    expect(result.rules.map(item => item.name)).toEqual(['project', 'user', 'RULES', 'RULES'])
  })

  it('reads a rule with no frontmatter as an undescribed rule', async () => {
    await write(join(cwd, '.omp', 'rules', 'bare.md'), 'just a body\n')
    const result = await loadNative(options())
    const bare = result.rules.find(item => item.name === 'bare')
    expect(bare?.description).toBeUndefined()
    expect(bare?.content).toBe('just a body')
  })

  it('ignores an empty .omp directory', async () => {
    const empty = join(root, 'empty-project')
    await mkdir(join(empty, '.omp'), { recursive: true })
    const result = await loadNative(options({ cwd: empty, userRulesDir: join(root, 'no-user') }))
    expect(result.rules).toEqual([])
  })
})

describe('loadCline', () => {
  it('loads a .clinerules directory as one rule per file', async () => {
    const project = join(root, 'cline-dir')
    await mkdir(join(project, '.clinerules'), { recursive: true })
    await write(join(project, '.clinerules', 'style.md'), '---\ndescription: cline style\n---\nbody\n')

    const result = await loadCline(options({ cwd: project }))
    expect(result.rules.map(item => item.name)).toEqual(['style'])
    expect(result.rules[0]?.description).toBe('cline style')
  })

  it('loads a .clinerules file under the fixed name', async () => {
    const project = join(root, 'cline-file')
    await mkdir(project, { recursive: true })
    await write(join(project, '.clinerules'), 'single file rules\n')

    const result = await loadCline(options({ cwd: project }))
    expect(result.rules.map(item => item.name)).toEqual(['clinerules'])
  })

  it('stops at the nearest source', async () => {
    const outer = join(root, 'cline-outer')
    const inner = join(outer, 'nested')
    await mkdir(join(outer, '.clinerules'), { recursive: true })
    await write(join(outer, '.clinerules', 'outer.md'), 'outer\n')
    await mkdir(inner, { recursive: true })
    await write(join(inner, '.clinerules'), 'inner file\n')

    const result = await loadCline(options({ cwd: inner }))
    expect(result.rules.map(item => item.name)).toEqual(['clinerules'])
    expect(result.rules[0]?.content).toBe('inner file')
  })
})

describe('loadGithub', () => {
  it('maps a narrow applyTo onto globs and a synthesized description', async () => {
    const project = join(root, 'gh-globs')
    await write(join(project, '.github', 'instructions', 'testing.instructions.md'), '---\napplyTo: "**/*.test.ts"\n---\nbody\n')

    const [rule] = (await loadGithub(options({ cwd: project }))).rules
    expect(rule?.name).toBe('testing')
    expect(rule?.globs).toEqual(['**/*.test.ts'])
    expect(rule?.alwaysApply).toBe(false)
    expect(rule?.description).toBe('Applies to **/*.test.ts')
  })

  it('maps a wildcard applyTo onto always-apply', async () => {
    const project = join(root, 'gh-all')
    await write(join(project, '.github', 'instructions', 'all.instructions.md'), '---\napplyTo: "**"\n---\nbody\n')

    const [rule] = (await loadGithub(options({ cwd: project }))).rules
    expect(rule?.alwaysApply).toBe(true)
    expect(rule?.globs).toBeUndefined()
  })

  it('discovers nested instruction files', async () => {
    const project = join(root, 'gh-nested')
    await write(join(project, '.github', 'instructions', 'db', 'schema.instructions.md'), '---\napplyTo: "**"\n---\nbody\n')

    const result = await loadGithub(options({ cwd: project }))
    expect(result.rules.map(item => item.name)).toEqual(['schema'])
  })
})

describe('loadOmpPlugins', () => {
  it('reads rules from each configured package root', async () => {
    const packageRoot = join(root, 'plugin')
    await write(join(packageRoot, 'rules', 'shipped.md'), '---\ndescription: shipped\n---\nbody\n')

    const result = await loadOmpPlugins(options({ pluginRoots: [packageRoot] }))
    expect(result.rules.map(item => item.name)).toEqual(['shipped'])
    expect(result.rules[0]?._source.provider).toBe('omp-plugins')
  })

  it('returns nothing for a root without a rules directory', async () => {
    const result = await loadOmpPlugins(options({ pluginRoots: [join(root, 'no-such-plugin')] }))
    expect(result.rules).toEqual([])
  })
})

describe('scopeOf', () => {
  it('labels a tree with its own name, never with a path', () => {
    expect(scopeOf(join(root, 'a', 'b'))).toBe('b')
    // The label is printed beside each rule in the audit page's `source · path`
    // column, so a separator in it means a whole absolute path is being shown
    // there instead of a scope. A Windows path carries no `/` to split on,
    // which is what used to put `C:\a\b` into that column.
    expect(scopeOf(join(root, 'a', 'b', 'c')).includes('/')).toBe(false)
  })
})

describe('nameFromPath', () => {
  it('never yields a path as a rule name', () => {
    expect(nameFromPath(join(root, 'a', 'b', 'style.md'))).toBe('style')
    expect(nameFromPath('/a/b/my.rule.mdc').includes('/')).toBe(false)
  })
})

describe('provider scan order', () => {
  let realHome: string | undefined

  beforeEach(() => {
    realHome = process.env['HOME']
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = realHome
  })

  /** Point `homedir()` at a fixture, which is how the user global rules resolve. */
  function useHome(path: string): void {
    process.env['HOME'] = path
  }

  it('reads the project cursor rules before the user global ones', async () => {
    // The provider merge is first-wins, so the order decides which of two
    // same-named rules survives: the project's is the more specific one.
    const fakeHome = join(root, 'cursor-home')
    const project = join(root, 'cursor-project')
    await write(join(fakeHome, '.cursor', 'rules', 'style.md'), '---\ndescription: user style\n---\nuser body\n')
    await write(join(project, '.cursor', 'rules', 'style.md'), '---\ndescription: project style\n---\nproject body\n')

    useHome(fakeHome)
    const result = await loadCursor(options({ cwd: project }))

    expect(result.rules.filter(rule => rule.name === 'style').map(rule => rule.content)).toEqual(['project body', 'user body'])
    // The first one is the one that wins the name.
    expect(result.rules[0]?.content).toBe('project body')
  })

  it('reads the project windsurf rules before the user global file', async () => {
    const fakeHome = join(root, 'windsurf-home')
    const project = join(root, 'windsurf-project')
    await write(join(fakeHome, '.codeium', 'windsurf', 'memories', 'global_rules.md'), 'user global\n')
    await write(join(project, '.windsurf', 'rules', 'team.md'), '---\ndescription: team rules\n---\nproject body\n')

    useHome(fakeHome)
    const result = await loadWindsurf(options({ cwd: project }))

    expect(result.rules.map(rule => rule.name)).toEqual(['team', 'global_rules'])
  })
})

describe('an unreadable rule file', () => {
  it('degrades to a warning instead of failing the whole pass', async () => {
    const project = join(root, 'unreadable')
    const locked = join(project, '.omp', 'rules', 'locked.md')
    await write(join(locked), '---\ndescription: locked rule\n---\nbody\n')
    await write(join(project, '.omp', 'rules', 'readable.md'), '---\ndescription: readable rule\n---\nbody\n')
    await chmod(locked, 0o000)

    // Root ignores the mode bits, and then there is nothing to observe.
    if (await readFile(locked, 'utf8').then(() => true, () => false)) {
      await chmod(locked, 0o644)
      return
    }

    try {
      const result = await loadNative(options({ cwd: project, userRulesDir: join(root, 'no-user-2') }))
      // One unreadable file must not take the readable ones down with it:
      // discovery throws into a fire-and-forget build, where an unhandled
      // rejection takes the whole process with it.
      expect(result.rules.map(rule => rule.name)).toEqual(['readable'])
      expect(result.warnings.some(warning => warning.includes('locked'))).toBe(true)
    } finally {
      await chmod(locked, 0o644)
    }
  })
})
