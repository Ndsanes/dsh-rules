import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { createAuditService, type RuleAuditReport } from '../src/audit.ts'
import { apply } from '../src/runtime.ts'

/**
 * A faithful stand-in for `dsh-settings`' array handling.
 *
 * The real service throws when an op targets an index the array does not have,
 * and every `unset` splices one entry out. Reproducing that contract here is the
 * whole point: a recorder that just stores the ops accepts op sequences the real
 * service rejects, which is how an ascending unset walk shipped green.
 *
 * Ported from `dsh-settings/lib/index.js` `applyPathOp`.
 */
function applyOps(disabled: readonly string[], ops: readonly SettingsPathOp[]): string[] {
  const value = [...disabled]
  for (const op of ops) {
    if (op.path[0] !== 'ttsr' || op.path[1] !== 'disabledRules') {
      throw new Error(`the test double only models ttsr.disabledRules, got ${op.path.join('.')}`)
    }
    const head = op.path[2] ?? ''
    if (!/^(0|[1-9][0-9]*)$/.test(head) || Number(head) > value.length) {
      throw new TypeError(`Config array index "${head}" is out of range`)
    }
    // The remaining path is empty at the array level, so `unset` at exactly the
    // current length is the one case the real service refuses.
    if (Number(head) === value.length && op.op === 'unset') {
      throw new TypeError(`Config array index "${head}" is out of range`)
    }
    if (op.op === 'unset') value.splice(Number(head), 1)
    else value[Number(head)] = String(op.value)
  }
  return value
}

let project: string

beforeAll(async () => {
  project = join(await mkdtemp(join(tmpdir(), 'dsh-rules-settings-')), 'project')
  await mkdir(join(project, '.omp', 'rules'), { recursive: true })
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

function agent(id: string): Agent {
  return {
    id,
    cancel() {},
    steer() {},
    inject() {},
    session: { header: { cwd: project } },
  } as unknown as Agent
}

/**
 * Boot with the settings service provided the way Cordis provides one.
 *
 * The earlier tests assigned `ctx.settings` as a plain property, which bypasses
 * the inject check: production threw "cannot get property 'settings' without
 * inject" while every unit test passed. `ctx.provide` goes through the real
 * registry, so `ctx.get('settings')` is exercised as it is at runtime.
 */
async function bootWithSettings(
  initial: readonly string[],
  namespace = 'dsh-rules',
): Promise<{
  disabled: () => readonly string[]
  setDisabled: (names: readonly string[]) => Promise<{ ok: boolean; guidance?: string }>
  auditActive: () => Promise<boolean>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  let disabled = [...initial]
  let revision = 1
  // `describe()` is the service's live view of the entry, and its revision is
  // what makes a write conditional. A stub without both would let the writer
  // compute its ops against nothing at all.
  ctx.provide('settings', {
    describe: () => [{ ns: namespace, value: { ttsr: { disabledRules: [...disabled] } }, revision }],
    mutate: async (_namespace: string, ops: SettingsPathOp[]) => {
      disabled = applyOps(disabled, ops)
      revision += 1
    },
  } as never)

  apply(ctx, {
    enabled: true,
    userRulesDir: join(project, 'no-user'),
    pluginRoots: [],
    ttsr: { disabledRules: [...initial] },
  })
  await ctx.emit('agent/created', { agent: agent(project), source: 'startup' })

  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if ((await ctx.dshRules.audit()).rules.length > 0) break
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }

  return {
    disabled: () => disabled,
    setDisabled: names => ctx.dshRules.setDisabled(names),
    auditActive: async () =>
      (await ctx.dshRules.audit()).rules.find(rule => rule.name === 'ts-set-map')?.active !== false,
  }
}

/** Wait until discovery has published a report. */
async function waitForAudit(ctx: Context): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if ((await ctx.dshRules.audit()).rules.length > 0) return
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
  throw new Error('the audit report never arrived')
}

/**
 * The conflict the real service raises when a revision no longer matches.
 *
 * `name` is set explicitly: a subclass's constructor does not make `error.name`
 * the class name, and the writer matches on it.
 */
/** One `rule disable <name>` through the real tool registry. */
async function runRuleTool(ctx: Context, host: Agent, name: string): Promise<unknown> {
  return ctx.tools.execute({
    token: Symbol('execution') as never,
    callId: `call-${name}` as never,
    name: 'rule',
    arguments: { action: 'disable', name },
    signal: new AbortController().signal,
    agent: host,
  } as unknown as Parameters<Context['tools']['execute']>[0])
}

class SettingsConflictError extends Error {
  constructor() {
    super('settings conflict: the entry changed underneath this write')
    this.name = 'SettingsConflictError'
  }
}

describe('persisting the disabled set against the real array contract', () => {
  it('reads the settings service without declaring it as a hard dependency', async () => {
    const harness = await bootWithSettings([])
    const outcome = await harness.setDisabled(['ts-set-map'])

    expect(outcome.ok).toBe(true)
    expect(harness.disabled()).toEqual(['ts-set-map'])
  })

  it('appends with set, which the service allows at exactly the length', async () => {
    const harness = await bootWithSettings(['go-ioutil'])
    expect((await harness.setDisabled(['go-ioutil', 'ts-set-map'])).ok).toBe(true)

    expect(harness.disabled()).toEqual(['go-ioutil', 'ts-set-map'])
  })

  it('clears every rule in one call instead of throwing on the second unset', async () => {
    const harness = await bootWithSettings(['go-ioutil', 'go-rand-v2', 'ts-no-any'])

    const outcome = await harness.setDisabled([])
    expect(outcome.ok).toBe(true)
    expect(harness.disabled()).toEqual([])
  })

  it('keeps the rules the caller asked for when shrinking a partial set', async () => {
    // current = [a, b, c], names = [a, c]: the stale entry is the middle one,
    // and walking from zero would delete `a` and leave `b` behind.
    const harness = await bootWithSettings(['go-ioutil', 'go-rand-v2', 'ts-no-any'])

    const outcome = await harness.setDisabled(['go-ioutil', 'ts-no-any'])
    expect(outcome.ok).toBe(true)
    expect(harness.disabled()).toEqual(['go-ioutil', 'ts-no-any'])
  })

  it('leaves the audit agreeing with what was persisted', async () => {
    const harness = await bootWithSettings([])

    expect((await harness.setDisabled(['ts-set-map'])).ok).toBe(true)
    expect(await harness.auditActive()).toBe(false)

    expect((await harness.setDisabled([])).ok).toBe(true)
    expect(await harness.auditActive()).toBe(true)
  })

  it('re-reads and succeeds when a racing write bumps the revision', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    let disabled: string[] = []
    let revision = 1
    let conflicts = 0
    ctx.provide('settings', {
      describe: () => [{ ns: 'dsh-rules', value: { ttsr: { disabledRules: [...disabled] } }, revision }],
      mutate: async (_ns: string, ops: SettingsPathOp[], expected?: number) => {
        // The first attempt always loses, exactly as it would if another writer
        // landed between this call's describe() and its mutate().
        if (conflicts === 0) {
          conflicts += 1
          disabled = ['go-ioutil']
          revision += 1
          throw new SettingsConflictError()
        }
        expect(expected).toBe(revision)
        disabled = applyOps(disabled, ops)
        revision += 1
      },
    } as never)

    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await ctx.emit('agent/created', { agent: agent(project), source: 'startup' })
    await waitForAudit(ctx)

    // The retry must recompute against the new state, not replay the stale ops:
    // the racing write added `go-ioutil`, and this call replaces the whole set.
    const outcome = await ctx.dshRules.setDisabled(['ts-set-map'])
    expect(outcome.ok).toBe(true)
    expect(conflicts).toBe(1)
    expect(disabled).toEqual(['ts-set-map'])
  })

  it('gives up honestly when every attempt is overtaken', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    let revision = 1
    ctx.provide('settings', {
      describe: () => [{ ns: 'dsh-rules', value: { ttsr: { disabledRules: [] } }, revision }],
      mutate: async () => { revision += 1; throw new SettingsConflictError() },
    } as never)

    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await ctx.emit('agent/created', { agent: agent(project), source: 'startup' })
    await waitForAudit(ctx)

    const outcome = await ctx.dshRules.setDisabled(['ts-set-map'])
    expect(outcome.ok).toBe(false)
    expect(outcome.guidance).toContain('overtaken')
  })

  it('keeps both of two toggles issued in the same turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    let disabled: string[] = []
    let revision = 1
    let firstCall = true
    // Built before the calls start: releasing a gate nobody has entered yet
    // would leave the first write waiting for a promise that never resolves.
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    ctx.provide('settings', {
      describe: () => [{ ns: 'dsh-rules', value: { ttsr: { disabledRules: [...disabled] } }, revision }],
      mutate: async (_ns: string, ops: SettingsPathOp[], expected?: number) => {
        // Hold the first write open so the second genuinely overlaps it.
        if (firstCall) { firstCall = false; await gate }
        if (expected !== revision) throw new SettingsConflictError()
        disabled = applyOps(disabled, ops)
        revision += 1
      },
    } as never)

    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    const host = agent(project)
    await ctx.emit('agent/created', { agent: host, source: 'startup' })
    await waitForAudit(ctx)

    // Two `rule disable` calls in one turn: the tool states intent, so the
    // second composes with whatever the first actually stored instead of
    // replacing it with a snapshot both of them read as empty.
    const first = runRuleTool(ctx, host, 'go-ioutil')
    const second = runRuleTool(ctx, host, 'ts-set-map')
    open()
    await Promise.all([first, second])

    expect(disabled).toEqual(expect.arrayContaining(['go-ioutil', 'ts-set-map']))
  })

  it('reports the service refusal instead of claiming the rule was disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // No settings service at all: the plugin must still load and still refuse.
    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await ctx.emit('agent/created', { agent: agent(project), source: 'startup' })

    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if ((await ctx.dshRules.audit()).rules.length > 0) break
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    }

    const outcome = await ctx.dshRules.setDisabled(['ts-set-map'])
    expect(outcome.ok).toBe(false)
    expect(outcome.guidance).toContain('no settings service')
    // Refusing must not be mistaken for success.
    const report = await ctx.dshRules.audit()
    expect(report.rules.find(rule => rule.name === 'ts-set-map')?.active).toBe(true)
  })
})
describe('a switched-off project rule', () => {
  it('stops the audit page from recomputing the whole workspace on every poll', async () => {
    // `disabledOf` used to answer with bundled rules only, while `setDisabled`
    // accepts any discovered name. A disabled project rule could therefore
    // never appear on both sides of the drift check, so every `audit()` call
    // paid a full recompute — every ancestor directory plus `homedir()`.
    let recomputes = 0
    let disabled: string[] = []
    const report: RuleAuditReport = {
      cwd: '',
      rulebook: [],
      alwaysApply: [],
      ttsr: [],
      rules: [
        { name: 'ts-set-map', provider: 'builtin-defaults', path: '', active: false, reason: 'disabled', triggers: [] },
        { name: 'project-rule', provider: 'native', path: '/p.md', active: false, reason: 'disabled', triggers: [] },
      ],
      warnings: [],
      triggered: {},
    }

    const service = createAuditService(
      async () => {
        recomputes += 1
        return report
      },
      () => disabled,
      async names => ({ ok: true, disabled: [...names] }),
      async () => ({ ok: false, guidance: 'unused', disabled: [] }),
      async () => ({ ok: false, guidance: 'unused', disabled: [] }),
      () => [],
      async () => ({ ok: true, disabled: [] }),
      () => {},
    )

    service.publish(report)
    disabled = ['ts-set-map', 'project-rule']

    await service.audit()
    await service.audit()
    await service.audit()

    expect(recomputes).toBe(0)
  })

  it('still turns a project rule off locally, the way it does a bundled one', async () => {
    let disabled: string[] = []
    const report: RuleAuditReport = {
      cwd: '',
      rulebook: [],
      alwaysApply: [],
      ttsr: [],
      rules: [
        { name: 'ts-set-map', provider: 'builtin-defaults', path: '', active: true, triggers: [] },
        { name: 'project-rule', provider: 'native', path: '/p.md', active: true, triggers: [] },
        { name: 'shadowed-rule', provider: 'cline', path: '/c.md', active: false, reason: 'shadowed', triggers: [] },
      ],
      warnings: [],
      triggered: {},
    }

    const service = createAuditService(
      async () => report,
      () => disabled,
      async names => { disabled = [...names]; return { ok: true, disabled } },
      async () => ({ ok: false, guidance: 'unused', disabled: [] }),
      async () => ({ ok: false, guidance: 'unused', disabled: [] }),
      () => [],
      async () => ({ ok: true, disabled: [] }),
      () => {},
    )
    service.publish(report)

    const off = await service.setDisabled(['project-rule'])
    expect(off.ok).toBe(true)
    expect(off.disabled).toEqual(['project-rule'])

    const after = await service.audit()
    expect(after.rules.find(rule => rule.name === 'project-rule')?.reason).toBe('disabled')
    // A rule that is off for another reason keeps that reason.
    expect(after.rules.find(rule => rule.name === 'shadowed-rule')?.reason).toBe('shadowed')

    const back = await service.setDisabled([])
    expect((await service.audit()).rules.find(rule => rule.name === 'project-rule')?.active).toBe(true)
  })
})

describe('a disabled name this report has never heard of', () => {
  it('does not read as drift that a recompute could ever settle', async () => {
    // `ttsr.disabledRules` is profile-wide: disabling a rule while auditing
    // workspace A leaves its name in the set for workspace B, which does not
    // declare that rule at all. Comparing the raw lists would call that drift
    // and recompute on every poll, forever.
    let recomputes = 0
    // Consistent with the report it describes: `ts-set-map` really is off, and
    // `workspace-a-rule` is off but belongs to a workspace this one never saw.
    let disabled = ['ts-set-map', 'workspace-a-rule']
    const report: RuleAuditReport = {
      cwd: '',
      rulebook: [],
      alwaysApply: [],
      ttsr: [],
      rules: [
        { name: 'ts-set-map', provider: 'builtin-defaults', path: '', active: false, reason: 'disabled', triggers: [] },
        { name: 'workspace-b-rule', provider: 'native', path: '/b.md', active: true, triggers: [] },
      ],
      warnings: [],
      triggered: {},
    }

    const service = createAuditService(
      async () => {
        recomputes += 1
        return report
      },
      () => disabled,
      async names => { disabled = [...names]; return { ok: true, disabled } },
      async () => ({ ok: false, guidance: 'unused', disabled: [] }),
      async () => ({ ok: false, guidance: 'unused', disabled: [] }),
      () => [],
      async () => ({ ok: true, disabled: [] }),
      () => {},
    )

    service.publish(report)
    await service.audit()
    await service.audit()

    expect(recomputes).toBe(0)
    // And a name this report does know still counts as drift when it changes.
    disabled = ['ts-set-map', 'workspace-a-rule', 'workspace-b-rule']
    await service.audit()
    expect(recomputes).toBe(1)
  })
})
