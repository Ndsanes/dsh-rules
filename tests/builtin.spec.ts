import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ReadRuleResult, RuleAuditReport, RuleSourceFile, ToggleResult } from '../src/audit.ts'
import { isAstExtensionSupported, languageForPath } from '../src/ast.ts'
import { bucketRules } from '../src/buckets.ts'
import { builtinRuleNames, builtinRules } from '../src/builtin.ts'
import { apply } from '../src/runtime.ts'

let project: string

beforeAll(async () => {
  project = join(await mkdtemp(join(tmpdir(), 'dsh-rules-builtin-')), 'project')
  await mkdir(join(project, '.omp', 'rules'), { recursive: true })
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

/** Wait until discovery has published a report. */
async function waitForReport(ctx: Context): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if ((await ctx.dshRules.audit()).rules.length > 0) return
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
  throw new Error('the audit report never arrived')
}

/** A live agent stand-in covering the surfaces the plugin uses. */
function agent(id: string): Agent {
  return {
    id,
    cancel() {},
    steer() {},
    inject() {},
    session: { header: { cwd: project } },
  } as unknown as Agent
}

/** One `rule` tool call through the real registry pipeline. */
function ruleExecution(target: Agent, args: Record<string, unknown>): ToolExecutionInput {
  return {
    token: Symbol('execution') as never,
    callId: 'call-1' as never,
    name: 'rule',
    arguments: args,
    signal: new AbortController().signal,
    agent: target,
  } as unknown as ToolExecutionInput
}

/** Mount the plugin and return the live tool runner. */
async function boot(id: string, config: Parameters<typeof apply>[1] = {}): Promise<{
  call: (args: Record<string, unknown>) => Promise<string>
  prompt: () => Promise<string>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  const host = agent(id)
  apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [], ...config })
  await ctx.emit('agent/created', { agent: host, source: 'startup' })
  await new Promise<void>(resolve => setTimeout(resolve, 120))

  return {
    call: async args => JSON.stringify((await ctx.tools.execute(ruleExecution(host, args))).value),
    prompt: async () => {
      const { renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
      return renderPrompt(await ctx.systemPrompt.assemble({ agent: host, scope: host }))
    },
  }
}

describe('bundled rules', () => {
  it('loads the whole OMP builtin set', () => {
    const names = builtinRuleNames()
    expect(names.length).toBeGreaterThan(20)
    expect(names).toContain('ts-no-tiny-functions')
    expect(names).toContain('ts-set-map')
    expect(names).toContain('go-ioutil')
    expect(names).toContain('rs-lazylock')
  })

  it('registers every bundled rule as a streaming rule, not as prompt text', () => {
    for (const rule of builtinRules()) {
      expect(rule._source.provider).toBe('builtin-defaults')
      expect(rule.description).toBeTruthy()
      expect(rule.interruptMode ?? 'always').not.toBe('always')
    }
  })

  it('leaves a bundled astCondition trigger registered', () => {
    // The three Go rules carry astCondition patterns no bundled grammar can read
    // (see src/ast.ts). They stay registered so their bodies still reach the
    // model, and they say why they cannot fire.
    for (const rule of builtinRules()) {
      if ((rule.astCondition?.length ?? 0) === 0) continue
      expect(['ts-no-inline-cast-access', 'ts-redundant-clear-guard', 'go-bench-loop', 'go-new-expr', 'go-range-int']).toContain(rule.name)
      expect(rule._warnings?.join('\n') ?? '').toMatch(/^$|no bundled ast-grep grammar/)
    }
  })

  it('says so when a bundled Go astCondition cannot fire here', () => {
    for (const name of ['go-range-int', 'go-bench-loop', 'go-new-expr']) {
      const rule = builtinRules().find(entry => entry.name === name)
      expect(rule?.astCondition?.length).toBeGreaterThan(0)
      expect(rule?._warnings?.join('\n')).toContain('no bundled ast-grep grammar')
    }
  })

  it('resolves no grammar for Go or Rust, but one for TypeScript', () => {
    expect(languageForPath('main.go')).toBeUndefined()
    expect(languageForPath('lib.rs')).toBeUndefined()
    expect(languageForPath('src/a.ts')).toBeDefined()
    expect(isAstExtensionSupported('.go')).toBe(false)
    expect(isAstExtensionSupported('ts')).toBe(true)
  })

  it('keeps the Go rules in the streaming bucket rather than in prompt text', () => {
    const buckets = bucketRules(builtinRules(), {
      builtinRules: true,
      disabledRules: [],
      agentName: 'main',
      registerTtsr: () => true,
    })
    expect(buckets.rulebookRules.map(entry => entry.name)).not.toContain('go-range-int')
    expect(buckets.ttsrRules.map(entry => entry.name)).toContain('go-range-int')
  })

  it('lets a project rule of the same name shadow the bundled one', async () => {
    await writeFile(
      join(project, '.omp', 'rules', 'ts-no-tiny-functions.md'),
      '---\ndescription: Project override of the bundled tiny-function rule.\ncondition: forbidden\nscope: tool\n---\n\nProject body.\n',
    )

    const { call } = await boot('shadow-session')
    const answer = await call({ action: 'list' })

    expect(answer).toContain('on   ts-no-tiny-functions — Project override')
    expect(answer).not.toContain('Inline functions whose whole body')

    await rm(join(project, '.omp', 'rules', 'ts-no-tiny-functions.md'))
  })
})

describe('rule management surface', () => {
  it('reports which bundled rules are in force', async () => {
    const { call } = await boot('list-session')
    const answer = await call({ action: 'list' })

    expect(answer).toContain('[bundled]')
    expect(answer).toContain('on   ts-no-tiny-functions')
    expect(answer).toContain(`${builtinRuleNames().length} rule(s) discovered`)
  })

  it('disables a bundled rule and persists the disabled set', async () => {
    const written: Array<{ ns: string; patch: object }> = []
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ;ctx.provide('settings', {
      describe: () => [{ ns: 'dsh-rules', value: { ttsr: { disabledRules: [] } }, revision: 1 }],
      mutate: async (ns: string, ops: unknown[]) => {
        written.push({ ns, patch: ops })
      },
    } as never)

    const host = agent('toggle-session')
    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await ctx.emit('agent/created', { agent: host, source: 'startup' })
    await new Promise<void>(resolve => setTimeout(resolve, 120))

    const answer = JSON.stringify(
      (await ctx.tools.execute(ruleExecution(host, { action: 'disable', name: 'ts-set-map' }))).value,
    )

    expect(answer).toContain('now disabled')
    expect(written).toHaveLength(1)
    expect(written[0]?.ns).toBe('dsh-rules')
    expect(written[0]?.patch).toEqual([
      { op: 'set', path: ['ttsr', 'disabledRules', '0'], value: 'ts-set-map' },
    ])
  })

  it('honors a disabled bundled rule when the next session is built', async () => {
    const { call } = await boot('after-toggle-session', {
      ttsr: { disabledRules: ['ts-set-map'] },
    })
    const answer = await call({ action: 'list' })

    const line = answer.split('\n').find(entry => entry.includes('ts-set-map'))
    expect(line).toContain('inactive: listed in ttsr.disabledRules')
    expect(answer).toContain('on   ts-no-tiny-functions')
  })

  it('retires every bundled rule when builtinRules is false', async () => {
    const { call } = await boot('builtins-off-session', { ttsr: { builtinRules: false } })
    const answer = await call({ action: 'list' })

    const line = answer.split('\n').find(entry => entry.includes('ts-set-map'))
    expect(line).toContain('inactive: bundled rules are disabled by ttsr.builtinRules')
    expect(answer).not.toContain('on   ts-set-map')
  })
})

describe('the audit service the browser reads', () => {
  /** Mount the plugin and return the audit service it provides. */
  async function mount(id: string, config: Parameters<typeof apply>[1] = {}): Promise<{
    audit: () => Promise<RuleAuditReport>
    setDisabled: (names: readonly string[]) => Promise<ToggleResult>
    toggleable: () => readonly string[]
  }> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const written: string[][] = []

    apply(ctx, {
      enabled: true,
      userRulesDir: join(project, 'no-user'),
      pluginRoots: [],
      ...config,
    })
    ctx.provide('settings', {
      describe: () => [{ ns: 'dsh-rules', value: { ttsr: { disabledRules: [] } }, revision: 1 }],
      mutate: async (_ns: string, ops: { op: string; value?: string }[]) => {
        written.push(ops.map(op => op.value).filter((name): name is string => name !== undefined))
      },
    } as never)
    await ctx.emit('agent/created', { agent: agent(id), source: 'startup' })
    await new Promise<void>(resolve => setTimeout(resolve, 120))

    const service = ctx.dshRules
    void written
    return {
      audit: () => service.audit(),
      setDisabled: name => service.setDisabled(name),
      toggleable: () => service.toggleable,
    }
  }

  it('publishes what the last discovery pass found', async () => {
    const { audit } = await mount('audit-session')
    const report = await audit()

    expect(report.cwd).toBe(project)
    expect(report.rules.length).toBeGreaterThan(20)
    expect(report.rules.some(rule => rule.name === 'ts-no-tiny-functions' && rule.provider === 'builtin-defaults')).toBe(true)
  })

  it('records which bucket each rule landed in', async () => {
    const { audit } = await mount('audit-buckets')
    const report = await audit()

    // Every bundled rule carries a trigger, so they all register as streaming
    // rules and none of them occupies resident prompt context.
    expect(report.ttsr.length).toBeGreaterThan(20)
    expect(report.rulebook).toEqual([])
    expect(report.rules.filter(rule => rule.provider === 'builtin-defaults').every(rule => rule.triggers.length > 0)).toBe(true)
  })

  it('explains why a rule is off', async () => {
    const { audit } = await mount('audit-reasons', { ttsr: { disabledRules: ['ts-set-map'] } })
    const quiet = (await audit()).rules.find(rule => rule.name === 'ts-set-map')

    expect(quiet?.active).toBe(false)
    expect(quiet?.reason).toBe('disabled')
  })

  it('explains a wholesale retirement of the bundled rules', async () => {
    const { audit } = await mount('audit-all-off', { ttsr: { builtinRules: false } })
    const rule = (await audit()).rules.find(entry => entry.name === 'ts-set-map')

    expect(rule?.reason).toBe('builtins-off')
  })

  it('refuses a name no discovered rule carries', async () => {
    const { setDisabled } = await mount('audit-tamper')

    const outcome = await setDisabled(['no-such-rule-anywhere'])
    expect(outcome.ok).toBe(false)
    expect(outcome.guidance).toContain('no rule by that name is in force here')
  })

  it('offers every discovered rule for toggling, not just the bundled ones', async () => {
    const file = join(project, '.omp', 'rules', 'a-project-rule.md')
    await writeFile(file, '---\ndescription: A rule declared by the project.\ncondition: forbidden\n---\n\nProject body.\n')
    try {
      const { toggleable } = await mount('audit-toggleable')
      // `ttsr.disabledRules` is matched by name against every discovered rule, so
      // refusing project rules here was the only thing stopping the page from
      // using a mechanism that already works.
      expect(toggleable()).toContain('a-project-rule')
      expect(toggleable()).toContain('ts-set-map')
    } finally {
      await rm(file, { force: true })
    }
  })

  it('carries the remote binding the gateway binds on', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })

    const binding = ctx.dshRules.typertRemote
    expect(binding.serviceKey).toBe('dshRules')
    expect(binding.namespace).toBe('dshRules')
    expect(binding.service).toBe(ctx.dshRules)
  })

  it('replaces the disabled set through the same writer the tool uses', async () => {
    const { setDisabled } = await mount('audit-toggle')

    const off = await setDisabled(['ts-set-map'])
    expect(off.ok).toBe(true)
    expect(off.disabled).toContain('ts-set-map')

    const back = await setDisabled([])
    expect(back.disabled).not.toContain('ts-set-map')
  })
})

describe('a workspace that is gone', () => {
  it('reports staleness instead of numbers for a directory that no longer exists', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ;ctx.provide('settings', {
      describe: () => [{ ns: 'dsh-rules', value: { ttsr: { disabledRules: [] } }, revision: 1 }],
      mutate: async () => undefined,
    } as never)

    const gone = join(project, 'removed-workspace')
    await mkdir(gone, { recursive: true })
    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await ctx.emit('agent/created', { agent: agentAt(gone, 'gone-session'), source: 'startup' })
    await new Promise<void>(resolve => setTimeout(resolve, 120))

    const before = await ctx.dshRules.audit()
    expect(before.rules.length).toBeGreaterThan(0)
    expect(before.stale).toBeUndefined()

    await rm(gone, { recursive: true, force: true })
    const after = await ctx.dshRules.audit()
    expect(after.stale).toEqual({ cwd: gone })
    expect(after.rules).toEqual([])
  })
})

/** An agent whose session reports a specific workspace root. */
function agentAt(cwd: string, id: string): Agent {
  return { id, cancel() {}, steer() {}, inject() {}, session: { header: { cwd } } } as unknown as Agent
}

describe('the host write path', () => {
  it('persists a new disabled set through the settings service', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    const mutations: { ops: unknown[] }[] = []
    ;ctx.provide('settings', {
      describe: () => [{ ns: 'dsh-rules', value: { ttsr: { disabledRules: [] } }, revision: 1 }],
      mutate: async (_ns: string, ops: unknown[]) => { mutations.push({ ops }) },
    } as never)

    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await ctx.emit('agent/created', { agent: agent(project), source: 'startup' })
    await waitForReport(ctx)

    const outcome = await ctx.dshRules.setDisabled(['ts-set-map'])
    expect(outcome.ok).toBe(true)
    expect(mutations).toHaveLength(1)
    expect(mutations[0]?.ops).toEqual([
      { op: 'set', path: ['ttsr', 'disabledRules', '0'], value: 'ts-set-map' },
    ])

    // And the audit reflects it without a restart.
    const report = await ctx.dshRules.audit()
    expect(report.rules.find(rule => rule.name === 'ts-set-map')?.active).toBe(false)
    expect(report.rules.find(rule => rule.name === 'ts-set-map')?.reason).toBe('disabled')
  })

  it('refuses a name no discovered rule carries', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ;ctx.provide('settings', {
      describe: () => [{ ns: 'dsh-rules', value: { ttsr: { disabledRules: [] } }, revision: 1 }],
      mutate: async () => undefined,
    } as never)

    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await ctx.emit('agent/created', { agent: agent(project), source: 'startup' })
    await waitForReport(ctx)

    const outcome = await ctx.dshRules.setDisabled(['a-project-rule'])
    expect(outcome.ok).toBe(false)
    expect(outcome.guidance).toContain('no rule by that name is in force here')
  })

  it('keeps the bundled rules toggleable with no workspace open', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const written: string[][] = []
    ;ctx.provide('settings', {
      describe: () => [{ ns: 'dsh-rules', value: { ttsr: { disabledRules: [] } }, revision: 1 }],
      mutate: async (_ns: string, ops: unknown[]) => {
        written.push((ops as { value?: string }[]).map(op => op.value).filter(Boolean) as string[])
      },
    } as never)

    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })

    // No session, so no workspace and an empty report. The bundled rules apply
    // in every workspace, so the page has to keep offering them: refusing here
    // made it list 27 switches the Host would then reject.
    const report = await ctx.dshRules.audit()
    expect(report.cwd).toBe('')
    expect(ctx.dshRules.toggleable).toContain('go-add-cleanup')

    const outcome = await ctx.dshRules.setDisabled(['go-add-cleanup'])
    expect(outcome.ok).toBe(true)
    expect(written).toEqual([['go-add-cleanup']])
  })

  it('clears the audit once the last session is archived', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ;ctx.provide('settings', {
      describe: () => [{ ns: 'dsh-rules', value: { ttsr: { disabledRules: [] } }, revision: 1 }],
      mutate: async () => undefined,
    } as never)

    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    const host = agent(project)
    await ctx.emit('agent/created', { agent: host, source: 'startup' })
    await waitForReport(ctx)
    expect((await ctx.dshRules.audit()).cwd).toBe(project)

    await ctx.emit('agent/disposed', { agent: host })
    const after = await ctx.dshRules.audit()
    // Archiving every session left the page serving a dead workspace's rules,
    // with nothing on screen saying whose they were: the numbers stayed
    // truthful for that path, so nothing looked wrong.
    expect(after.cwd).toBe('')
    expect(after.rules).toEqual([])
  })

  it('keeps the audit while another session is still open', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    // Distinct ids: the store keys agents by id, so two handles built from the
    // same workspace would collapse into one entry.
    const first = agent('session-one')
    const second = agent('session-two')
    await ctx.emit('agent/created', { agent: first, source: 'startup' })
    await ctx.emit('agent/created', { agent: second, source: 'startup' })
    await waitForReport(ctx)

    await ctx.emit('agent/disposed', { agent: second })
    expect((await ctx.dshRules.audit()).cwd).toBe(project)
    await ctx.emit('agent/disposed', { agent: first })
    expect((await ctx.dshRules.audit()).cwd).toBe('')
  })

  it('audits a workspace the page opens and forgets it on close', async () => {
    const other = join(await mkdtemp(join(tmpdir(), 'dsh-rules-other-')), 'project')
    await mkdir(join(other, '.omp', 'rules'), { recursive: true })
    await writeFile(
      join(other, '.omp', 'rules', 'other-project-rule.md'),
      '---\ndescription: Belongs to the other project.\ncondition: forbidden\n---\n\nBody.\n',
    )
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // A real entry is a class instance whose `path` and `title` are prototype
    // getters; serialising one crosses the wire as `{ id, record }` with no
    // path and no title, which is what the picker was showing as a bare UUID.
    class WorkspaceEntity {
      constructor(private readonly record: { path: string; title: string }, readonly id: string) {}
      get path(): string { return this.record.path }
      get title(): string { return this.record.title }
    }
    ;ctx.provide('workspaceRegistry', {
      list: () => [new WorkspaceEntity({ path: other, title: 'other-project' }, 'w1')],
    } as never)
    ;ctx.provide('settings', {
      describe: () => [{ ns: 'dsh-rules', value: { ttsr: { disabledRules: [] } }, revision: 1 }],
      mutate: async () => undefined,
    } as never)

    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await ctx.emit('agent/created', { agent: agent(project), source: 'startup' })
    await waitForReport(ctx)

    expect(ctx.dshRules.listWorkspaces()).toEqual([{ id: 'w1', path: other, title: 'other-project' }])

    const opened = await ctx.dshRules.openWorkspace(other)
    expect(opened.ok).toBe(true)
    const report = await ctx.dshRules.audit()
    expect(report.cwd).toBe(other)
    expect(report.rules.some(rule => rule.name === 'other-project-rule')).toBe(true)
    // Its project rule is toggleable exactly like a bundled one.
    expect(ctx.dshRules.toggleable).toContain('other-project-rule')

    ctx.dshRules.closeWorkspace()
    expect((await ctx.dshRules.audit()).cwd).toBe('')
    await rm(join(other, '..'), { recursive: true, force: true })
  })

  it('refuses a path that is not a readable directory', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await ctx.emit('agent/created', { agent: agent(project), source: 'startup' })
    await waitForReport(ctx)

    // Discovery tolerates a missing directory — it warns and finds nothing — so
    // without an explicit check this would "succeed" and blank the panel.
    const failed = await ctx.dshRules.openWorkspace('/no/such/directory/anywhere')
    expect(failed.ok).toBe(false)
    expect(failed.guidance).toContain('is not a directory')
    expect((await ctx.dshRules.audit()).cwd).toBe(project)
  })

  it('refuses to edit anything with no workspace open', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })

    // Discovery treats `''` as a real directory: `join('', '.cursor', 'rules')`
    // is relative, so it resolves against whatever directory dsh was launched
    // in. An editor that resolved a rule's file here would write outside the
    // workspace the page claims to be auditing.
    const read = await ctx.dshRules.readRule('ts-set-map')
    expect(read.ok).toBe(false)

    const written = await ctx.dshRules.writeRule('ts-set-map', 'replaced')
    expect(written.ok).toBe(false)
    expect(written.guidance).toContain('open a workspace first')
  })

  it('does not resurrect a closed workspace from an in-flight republish', async () => {
    const other = join(await mkdtemp(join(tmpdir(), 'dsh-rules-repub-')), 'project')
    await mkdir(join(other, '.omp', 'rules'), { recursive: true })
    await writeFile(
      join(other, '.omp', 'rules', 'republished-rule.md'),
      '---\ndescription: Lives in the workspace that gets closed.\ncondition: forbidden\n---\n\nBody.\n',
    )

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await ctx.emit('agent/created', { agent: agent(project), source: 'startup' })
    await waitForReport(ctx)

    expect((await ctx.dshRules.openWorkspace(other)).ok).toBe(true)
    expect((await ctx.dshRules.audit()).cwd).toBe(other)

    // A republish starts here and reads files asynchronously. Discovery is slow
    // enough that the close below always lands first — and without an epoch the
    // republish then publishes the closed workspace back over the empty report,
    // leaving `report.cwd` disagreeing with `auditCwd`.
    await ctx.emit('loader/volatile-update', {} as never)
    ctx.dshRules.closeWorkspace()
    await new Promise<void>(resolve => setTimeout(resolve, 250))

    const after = await ctx.dshRules.audit()
    expect(after.cwd).toBe('')
    expect(after.rules).toEqual([])
    await rm(join(other, '..'), { recursive: true, force: true })
  })

  it('never resolves a rule file against the process directory', async () => {
    // Belt and braces for the guard above: the refusal must not depend on the
    // call site checking, because any caller that forgets re-opens the hole.
    const before = readdirSync(process.cwd()).sort()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })

    await ctx.dshRules.writeRule('anything', 'x')
    await ctx.dshRules.readRule('anything')

    expect(readdirSync(process.cwd()).sort()).toEqual(before)
  })

  it('names the project a rule came from, so two `.omp/rules` buckets differ', async () => {
    const file = join(project, '.omp', 'rules', 'scoped-rule.md')
    await writeFile(file, '---\ndescription: Names the project it belongs to.\ncondition: forbidden\n---\n\nProject body.\n')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await ctx.emit('agent/created', { agent: agent(project), source: 'startup' })
    await waitForReport(ctx)

    const report = await ctx.dshRules.audit()
    // The provider alone cannot say where a rule came from: every project puts
    // its rules in `.omp/rules`. The scope carries the directory's own name.
    const projectRule = report.rules.find(rule => rule.name === 'scoped-rule')
    expect(projectRule?.provider).toBe('native')
    expect(projectRule?.scope).toBe(project.split('/').filter(Boolean).pop())
    await rm(file, { force: true })
  })
})

describe('the rule editor the browser reads', () => {
  /** A bundled rule, so the editor's "no file to edit" branch is the one under test. */
  const BUNDLED = 'ts-set-map'

  /**
   * The file behind a successful read.
   *
   * A refusal is a failure of the test, not something to assert on here, so
   * this throws with the guidance the page would have shown.
   */
  function opened(result: ReadRuleResult): RuleSourceFile {
    if (!result.ok) throw new Error(`expected a rule file, but the read was refused: ${result.guidance}`)
    return result.file
  }

  /** Mount the plugin over `project` and hand back the live editor methods. */
  async function mountEditor(id: string): Promise<{
    readRule: (name: string) => Promise<ReadRuleResult>
    writeRule: (name: string, content: string) => Promise<ToggleResult>
    rulesDir: string
  }> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ;ctx.provide('settings', {
      describe: () => [{ ns: 'dsh-rules', value: { ttsr: { disabledRules: [] } }, revision: 1 }],
      mutate: async () => undefined,
    } as never)

    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await ctx.emit('agent/created', { agent: agent(id), source: 'startup' })
    await waitForReport(ctx)

    return {
      readRule: name => ctx.dshRules.readRule(name),
      writeRule: (name, content) => ctx.dshRules.writeRule(name, content),
      rulesDir: join(project, '.omp', 'rules'),
    }
  }

  it('hands the editor the discovered file it may write', async () => {
    const body = '---\ndescription: Edited through the browser rule editor.\ncondition: forbidden\n---\n\nBody with a unicode line: 编译器 §7.\n'
    const file = join(project, '.omp', 'rules', 'editor-rule.md')
    await writeFile(file, body)
    try {
      const { readRule } = await mountEditor('editor-read')

      const result = await readRule('editor-rule')

      expect(result.ok).toBe(true)
      expect(result).toEqual({ ok: true, file: { name: 'editor-rule', path: file, content: body, editable: true } })
      const found = opened(result)
      // An absolute path the page can show, and the file's bytes unchanged.
      expect(found.path).toBe(file)
      expect(found.content).toBe(body)
      expect(found.editable).toBe(true)
    } finally {
      await rm(file, { force: true })
    }
  })

  it('reports a bundled rule as not editable instead of inventing a file', async () => {
    const { readRule } = await mountEditor('editor-bundled')

    const result = await readRule(BUNDLED)

    expect(result.ok).toBe(true)
    const bundled = opened(result)
    // `path` and `content` stay empty on purpose: the rule is compiled into the
    // plugin, so a path here would send the editor writing to nothing.
    expect(bundled.editable).toBe(false)
    expect(bundled.name).toBe(BUNDLED)
    expect(bundled.path).toBe('')
    expect(bundled.content).toBe('')
  })

  it('refuses to open a rule no workspace carries', async () => {
    const { readRule } = await mountEditor('editor-unknown')

    // Refusing, rather than resolving an empty buffer, is what stops the page
    // from opening a rule it could then save back as a brand-new file.
    const result = await readRule('no-such-rule-anywhere')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: the read should have been refused')
    expect(result.guidance).toContain('no rule named no-such-rule-anywhere')
    expect(result.guidance).toContain('nothing to edit')
  })

  it('writes new content to the rule file and reads it back', async () => {
    const original = '---\ndescription: The version the editor opened.\ncondition: forbidden\n---\n\nBefore.\n'
    const updated = '---\ndescription: The version the editor saved.\ncondition: forbidden\n---\n\nAfter.\n'
    const file = join(project, '.omp', 'rules', 'editor-write.md')
    await writeFile(file, original)
    try {
      const { readRule, writeRule } = await mountEditor('editor-write')
      expect(opened(await readRule('editor-write')).content).toBe(original)

      const outcome = await writeRule('editor-write', updated)

      expect(outcome.ok).toBe(true)
      expect(outcome.guidance).toBeUndefined()
      // The bytes really moved, and a re-read sees the new version.
      expect(await readFile(file, 'utf8')).toBe(updated)
      const reopened = opened(await readRule('editor-write'))
      expect(reopened.content).toBe(updated)
      expect(reopened.editable).toBe(true)
    } finally {
      await rm(file, { force: true })
    }
  })

  it('refuses to write a bundled rule and leaves the plugin untouched', async () => {
    const { writeRule, rulesDir } = await mountEditor('editor-bundled-write')
    const before = await readdir(rulesDir)
    const hijack = join(rulesDir, `${BUNDLED}.md`)

    try {
      const outcome = await writeRule(BUNDLED, '---\ndescription: Hijacked.\ncondition: forbidden\n---\n\nHijack.\n')

      expect(outcome.ok).toBe(false)
      expect(outcome.guidance).toContain(BUNDLED)
      expect(outcome.guidance).toContain('ships with the plugin')
      // Nothing may appear on disk, and no rule may be reported as disabled.
      expect((await readdir(rulesDir)).sort()).toEqual(before.sort())
      expect(outcome.disabled).toEqual([])
    } finally {
      // A regression that really did write must not leave the file behind for
      // the next test in this file to discover.
      await rm(hijack, { force: true })
    }
  })

  it('refuses to write an unknown rule and creates no file', async () => {
    const { writeRule, rulesDir } = await mountEditor('editor-unknown-write')
    const before = await readdir(rulesDir)
    const invented = join(rulesDir, 'never-existed.md')

    try {
      const outcome = await writeRule('never-existed', 'Body.\n')

      expect(outcome.ok).toBe(false)
      expect(outcome.guidance).toContain('no rule named never-existed')
      // The refusal must not have conjured the rule into existence on the way.
      expect((await readdir(rulesDir)).sort()).toEqual(before.sort())
      expect(existsSync(invented)).toBe(false)
    } finally {
      await rm(invented, { force: true })
    }
  })
})
