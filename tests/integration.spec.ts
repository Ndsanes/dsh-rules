import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { AssistantStreamFrame, Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { recordTrigger, triggerCounts, type RuleAuditReport } from '../src/audit.ts'
import { apply } from '../src/runtime.ts'
import { RuleSessionStore } from '../src/sessions.ts'
import type { RuleSession } from '../src/session.ts'

/** Minimal live-agent stand-in covering the four surfaces the plugin uses. */
interface Harness {
  agent: Agent
  cancel: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  inject: ReturnType<typeof vi.fn>
}

function harnessAgent(id: string, cwd: string): Harness {
  const cancel = vi.fn()
  const steer = vi.fn()
  const inject = vi.fn()
  const agent = { id, cancel, steer, inject, session: { header: { cwd } } } as unknown as Agent
  return { agent, cancel, steer, inject }
}

let fixture: string
let emptyFixture: string
let violatingFixture: string
let quietFixture: string

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rules-e2e-'))
  fixture = join(root, 'project')
  emptyFixture = join(root, 'bare')

  await mkdir(join(fixture, '.omp', 'rules'), { recursive: true })
  await mkdir(emptyFixture, { recursive: true })

  await writeFile(
    join(fixture, '.omp', 'rules', 'no-console-log.md'),
    '---\ndescription: Read this before writing any logging call.\nglobs: "src/**/*.ts"\n---\n\nLogs are for operators, not for the model\'s own debugging.\n',
  )
  await writeFile(join(fixture, '.omp', 'RULES.md'), 'This project always writes tests before claiming a fix works.\n')

  violatingFixture = join(root, 'violating')
  quietFixture = join(root, 'quiet')
  await mkdir(join(violatingFixture, '.omp', 'rules'), { recursive: true })
  await mkdir(join(quietFixture, '.omp', 'rules'), { recursive: true })

  await writeFile(
    join(violatingFixture, '.omp', 'rules', 'no-forbidden-phrase.md'),
    "---\ndescription: Never write the forbidden phrase.\ncondition: 'forbidden phrase'\nscope: text\ninterruptMode: always\n---\n\nSay the forbidden phrase only as part of quoting this rule.\n",
  )
  await writeFile(
    join(quietFixture, '.omp', 'rules', 'no-forbidden-phrase.md'),
    "---\ndescription: Never write the forbidden phrase.\ncondition: 'forbidden phrase'\nscope: text\ninterruptMode: never\n---\n\nSay the forbidden phrase only as part of quoting this rule.\n",
  )
})

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true })
})

/**
 * Wait until discovery has published a report, or give up.
 *
 * A fixed sleep is a flake waiting to happen under parallel load: the plugin
 * discovers asynchronously, and only a published report means the session is
 * actually built.
 */
async function waitForReport(ctx: Context, timeoutMs = 1000): Promise<void> {
  // A disabled plugin mounts no service, and a late-mounting one has not
  // discovered anything until a surface asks it to.
  if (ctx.dshRules === undefined) return
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await ctx.dshRules.audit()).rules.length > 0) return
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
}

/** Mount the plugin on a real dsh system-prompt service and return the context. */
async function boot(config: Parameters<typeof apply>[1], cwd: string, id = 'session-1'): Promise<{ ctx: Context; host: Harness }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const host = harnessAgent(id, cwd)
  apply(ctx, { ...config, userRulesDir: join(fixture, 'no-user'), pluginRoots: [] })
  await ctx.emit('agent/created', { agent: host.agent, source: 'startup' })
  // `agent/created` is awaited in the harness loop, but a bare emit does not
  // drain an async listener, so let discovery settle before assembling.
  await waitForReport(ctx)
  return { ctx, host }
}

describe('system prompt injection', () => {
  it('renders the always-apply body and the rulebook index for a project with rules', async () => {
    const { ctx, host } = await boot({ enabled: true }, fixture)
    const assembly = await ctx.systemPrompt.assemble({ agent: host.agent, scope: host.agent })
    const prompt = renderPrompt(assembly)

    expect(prompt).toContain('<generic-rules>')
    expect(prompt).toContain('This project always writes tests before claiming a fix works.')
    expect(prompt).toContain('<domain-rules>')
    expect(prompt).toContain('- no-console-log (src/**/*.ts): Read this before writing any logging call.')
  })

  it('renders neither layer for a project without rules', async () => {
    const { ctx, host } = await boot({ enabled: true }, emptyFixture, 'session-2')
    const assembly = await ctx.systemPrompt.assemble({ agent: host.agent, scope: host.agent })
    const prompt = renderPrompt(assembly)

    expect(prompt).not.toContain('<domain-rules>')
    expect(prompt).not.toContain('<generic-rules>')
  })

  it('contributes nothing when the plugin is disabled', async () => {
    const { ctx, host } = await boot({ enabled: false }, fixture, 'session-3')
    const assembly = await ctx.systemPrompt.assemble({ agent: host.agent, scope: host.agent })

    expect(renderPrompt(assembly)).not.toContain('<domain-rules>')
  })

  it('retires a rule named in ttsr.disabledRules', async () => {
    const { ctx, host } = await boot({ enabled: true, ttsr: { disabledRules: ['no-console-log'] } }, fixture, 'session-4')
    const assembly = await ctx.systemPrompt.assemble({ agent: host.agent, scope: host.agent })

    expect(renderPrompt(assembly)).not.toContain('no-console-log')
  })
})

describe('rule tool on the live registry', () => {
  it('registers the rule tool where the model can find it', async () => {
    const { ctx, host } = await boot({ enabled: true }, fixture, 'tool-session')

    const definition = ctx.tools.get('rule', host.agent)
    expect(definition).toBeDefined()
    expect(ctx.tools.schemas(host.agent).map(schema => schema.name)).toContain('rule')
  })

  it('returns the rule body when the model asks for a rule by name', async () => {
    const { ctx, host } = await boot({ enabled: true }, fixture, 'tool-session-2')
    const result = await ctx.tools.execute(executionInput(host.agent, { name: 'no-console-log' }))

    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.value)).toContain('Logs are for operators')
  })

  it('answers an unknown name with the addressable rules', async () => {
    const { ctx, host } = await boot({ enabled: true }, fixture, 'tool-session-3')
    const result = await ctx.tools.execute(executionInput(host.agent, { name: 'no-such-rule' }))

    expect(JSON.stringify(result.value)).toContain('Available rules:')
    expect(JSON.stringify(result.value)).toContain('no-console-log')
  })

  describe('creating a rule on disk', () => {
    const created = 'learned-no-generated-files'

    it('writes into the dsh directory when the workspace has no OMP rules', async () => {
      // Nothing OMP-shaped exists here, so the dsh path is used. `createRule`
      // makes the directory, so this also covers mkdir.
      const workspace = join(await mkdtemp(join(tmpdir(), 'dsh-create-')), 'project')
      const { ctx, host } = await boot({ enabled: true, userRulesDir: join(workspace, 'no-user') }, workspace, 'create-1')

      const result = await ctx.tools.execute(executionInput(host.agent, {
        action: 'create',
        name: created,
        frontmatter: 'description: Generated files are not committed',
        body: 'Check .gitignore before writing one.',
      }))

      expect(JSON.stringify(result.value)).toContain(`Created rule \\\"${created}\\\"`)
      const file = join(workspace, '.dsh', 'rules', `${created}.md`)
      expect(await readFile(file, 'utf8')).toBe(
        '---\ndescription: Generated files are not committed\n---\n\nCheck .gitignore before writing one.\n',
      )
      await rm(dirname(workspace), { recursive: true, force: true })
    })

    it('writes into the OMP directory once that convention is in use', async () => {
      // The choice follows what the workspace already has: one existing OMP rule
      // is enough to make this an OMP workspace, and a new rule written under
      // `.dsh` would then be governed by one convention and listed under
      // another.
      const workspace = join(await mkdtemp(join(tmpdir(), 'dsh-create-')), 'project')
      await mkdir(join(workspace, '.omp', 'rules'), { recursive: true })
      await writeFile(join(workspace, '.omp', 'rules', 'already.md'),
        '---\ndescription: already here\n---\n\nBody\n', 'utf8')
      const { ctx, host } = await boot({ enabled: true, userRulesDir: join(workspace, 'no-user') }, workspace, 'create-omp')

      await ctx.tools.execute(executionInput(host.agent, {
        action: 'create', name: created, frontmatter: 'description: d', body: 'b',
      }))

      expect(await readFile(join(workspace, '.omp', 'rules', `${created}.md`), 'utf8')).toContain('description: d')
      await rm(dirname(workspace), { recursive: true, force: true })
    })

    it('never truncates a file that is already there', async () => {
      // `wx` rather than `w`: a rule whose file exists but whose name discovery
      // never reported — one that failed to parse, say — would otherwise be
      // silently overwritten by a rule the model invented.
      const workspace = join(await mkdtemp(join(tmpdir(), 'dsh-create-')), 'project')
      const file = join(workspace, '.dsh', 'rules', `${created}.md`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, 'hand written, do not lose me\n', 'utf8')
      const { ctx, host } = await boot({ enabled: true, userRulesDir: join(workspace, 'no-user') }, workspace, 'create-2')

      const result = await ctx.tools.execute(executionInput(host.agent, {
        action: 'create', name: created, frontmatter: 'description: d', body: 'b',
      }))

      expect(JSON.stringify(result.value)).toContain('already exists')
      expect(await readFile(file, 'utf8')).toBe('hand written, do not lose me\n')
      await rm(dirname(workspace), { recursive: true, force: true })
    })
  })
})

describe('stream interruption on a live context', () => {
  it('aborts the turn and re-queues the rule when a delta violates it', async () => {
    const { ctx, host } = await boot({ enabled: true }, violatingFixture, 'stream-session')
    await emitText(ctx, host, 'this contains a forbidden phrase')

    expect(host.cancel).toHaveBeenCalledWith(
      { kind: 'hook', reason: 'TTSR rule violation: no-forbidden-phrase' },
      { keepInbox: true },
    )

    await new Promise<void>(resolve => setTimeout(resolve, 120))
    expect(host.steer).toHaveBeenCalledTimes(1)
    expect(steerText(host)).toContain('<system-interrupt')
    expect(steerText(host)).toContain('forbidden phrase')
  })

  it('does not abort a rule that declares interruptMode never', async () => {
    const { ctx, host } = await boot({ enabled: true }, quietFixture, 'stream-session-2')
    await emitText(ctx, host, 'this contains a forbidden phrase')

    expect(host.cancel).not.toHaveBeenCalled()

    await emitSettled(ctx, host)
    expect(host.inject).toHaveBeenCalledTimes(1)
    expect(injectText(host)).toContain('<system-reminder')
  })
})

/** One tool execution routed through the real registry pipeline. */
function executionInput(agent: Agent, args: Record<string, unknown>): ToolExecutionInput {
  return {
    token: Symbol('execution') as never,
    callId: 'call-1' as never,
    name: 'rule',
    arguments: args,
    signal: new AbortController().signal,
    agent,
  } as unknown as ToolExecutionInput
}

/** Identity the loop would assign one attempt. */
const ATTEMPT = 'session:1' as AssistantStreamFrame['attemptId']

/** Publish one assistant-stream chunk frame on the real context. */
async function emitText(ctx: Context, host: Harness, text: string): Promise<void> {
  const chunk: StreamChunk = { type: 'text-delta', index: 0, text }
  await emitFrame(ctx, host, { type: 'chunk', attemptId: ATTEMPT, revision: 1, index: 0, time: 0, chunk })
}

/** Publish the terminal frame that settles one assistant attempt. */
async function emitSettled(ctx: Context, host: Harness): Promise<void> {
  await emitFrame(ctx, host, {
    type: 'end',
    attemptId: ATTEMPT,
    revision: 9,
    index: 2,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 as SessionSeq },
  })
}

/** Publish one assistant-stream frame on the real context. */
async function emitFrame(ctx: Context, host: Harness, frame: AssistantStreamFrame): Promise<void> {
  await ctx.emit('agent/assistant-stream', { agent: host.agent, frame })
}

/** Text of the last message the plugin steered into the agent. */
function steerText(host: Harness): string {
  return String(host.steer.mock.calls.at(-1)?.[0]?.content?.[0]?.text)
}

/** Text of the last message the plugin injected into the agent. */
function injectText(host: Harness): string {
  return String(host.inject.mock.calls.at(-1)?.[0]?.content?.[0]?.text)
}

describe('a session that predates the rules layer', () => {
  it('loads its rules on first use without an agent/created event', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    const host = harnessAgent('late-session', fixture)
    // No `agent/created` emit: this is exactly a plugin mounting into a harness
    // whose agent already existed.
    apply(ctx, { enabled: true, userRulesDir: join(fixture, 'no-user'), pluginRoots: [] })

    const before = renderPrompt(await ctx.systemPrompt.assemble({ agent: host.agent, scope: host.agent }))
    expect(before).not.toContain('<domain-rules>')

    await new Promise<void>(resolve => setTimeout(resolve, 100))

    const after = renderPrompt(await ctx.systemPrompt.assemble({ agent: host.agent, scope: host.agent }))
    expect(after).toContain('<domain-rules>')
    expect(after).toContain('no-console-log')
    expect(after).toContain('<generic-rules>')
  })

  it('has its rules ready by the time the first tool call runs', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    const host = harnessAgent('late-session-2', fixture)
    apply(ctx, { enabled: true, userRulesDir: join(fixture, 'no-user'), pluginRoots: [] })

    // `tools/pre-execute` is an async waterfall, so the very first tool call
    // waits for discovery rather than answering from an empty snapshot.
    const result = await ctx.tools.execute(executionInput(host.agent, { name: 'no-console-log' }))
    expect(JSON.stringify(result.value)).toContain('Logs are for operators')
  })

  it('enforces a tool rule on an agent that never saw agent/created', async () => {
    const violating = join(fixture, '..', 'late-tool')
    await mkdir(join(violating, '.omp', 'rules'), { recursive: true })
    await writeFile(
      join(violating, '.omp', 'rules', 'no-temp.md'),
      "---\ndescription: Never leave a temp file behind.\ncondition: 'scratch'\nscope: tool\n---\n\nClean up.\n",
    )

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    const host = harnessAgent('late-session-3', violating)
    apply(ctx, { enabled: true, userRulesDir: join(fixture, 'no-user'), pluginRoots: [] })
    await waitForReport(ctx, 100)

    ctx.tools.register(stubWriteTool())

    const denied = await ctx.tools.execute(writeExecution(host.agent))
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied)).toContain('no-temp')
  })
})

/** A minimal `write`-shaped tool so the pre-execute gate has something to deny. */
function stubWriteTool(): ToolDefinition {
  return defineTool({
    name: 'write',
    description: 'Write a file.',
    parameters: {
      file_path: { type: 'string', description: 'Target path.' },
      content: { type: 'string', description: 'File body.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: value }],
    },
    execute: async () => 'written',
  })
}

/** One `write` call carrying text a rule forbids. */
function writeExecution(agent: Agent): ToolExecutionInput {
  return {
    token: Symbol('execution') as never,
    callId: 'call-late' as never,
    name: 'write',
    arguments: { file_path: 'scratch.txt', content: 'scratch' },
    signal: new AbortController().signal,
    agent,
  } as unknown as ToolExecutionInput
}

describe('path-shaped rules across path spellings', () => {
  /** A project whose rule scopes to a Docs prefix and only wants to inform. */
  async function makeDocsProject(): Promise<string> {
    const project = join(await mkdtemp(join(tmpdir(), 'dsh-rules-docs-')), 'project')
    await mkdir(join(project, '.omp', 'rules'), { recursive: true })
    await mkdir(join(project, 'Docs'), { recursive: true })
    await writeFile(
      join(project, '.omp', 'rules', 'documentation.md'),
      "---\ndescription: Read this before the first edit under Docs.\ncondition: '.*'\nglobs: 'Docs/**'\nscope: tool\ninterruptMode: never\n---\n\nDocumentation conventions follow here.\n",
    )
    return project
  }

  /** Mount the plugin for one project and return a live `write` probe. */
  async function probe(project: string, agentId: string): Promise<{
    write: (filePath: string, content: string) => Promise<{ blocked: boolean; detail: string }>
  }> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(stubWriteTool())

    const host = harnessAgent(agentId, project)
    apply(ctx, { enabled: true, userRulesDir: join(project, 'no-user'), pluginRoots: [] })
    await new Promise<void>(resolve => setTimeout(resolve, 100))

    return {
      write: async (filePath, content) => {
        const result = await ctx.tools.execute(writeExecutionFor(host.agent, filePath, content))
        return { blocked: result.isError, detail: JSON.stringify(result) }
      },
    }
  }

  it('never blocks a write under a Docs glob, spelled absolute or relative', async () => {
    const project = await makeDocsProject()
    const { write: run } = await probe(project, 'docs-agent-absolute')

    for (const target of [join(project, 'Docs', 'a.md'), 'Docs/b.md']) {
      const result = await run(target, 'hello')
      expect(result.blocked, `${target} must not be blocked`).toBe(false)
    }
  })

  it('delivers the contract in the tool result instead of blocking the write', async () => {
    const project = await makeDocsProject()
    const { write: run } = await probe(project, 'docs-agent-reminder')

    const result = await run(join(project, 'Docs', 'c.md'), 'hello')
    expect(result.blocked).toBe(false)
    expect(result.detail).toContain('<system-reminder')
    expect(result.detail).toContain('Documentation conventions follow here.')
  })

  it('delivers the contract once, not on every later write', async () => {
    const project = await makeDocsProject()
    const { write: run } = await probe(project, 'docs-agent-repeat')

    const first = await run(join(project, 'Docs', 'first.md'), 'hello')
    const second = await run(join(project, 'Docs', 'second.md'), 'hello')

    expect(first.detail).toContain('<system-reminder')
    expect(second.blocked).toBe(false)
    expect(second.detail).not.toContain('<system-reminder')
  })

  it('still blocks a hard-wall rule at an absolute path', async () => {
    const project = await makeDocsProject()
    await writeFile(
      join(project, '.omp', 'rules', 'no-banned.md'),
      "---\ndescription: Never write the banned marker.\ncondition: 'BANNED'\nglobs: '**/*.ts'\nscope: tool\n---\n\nUse something else.\n",
    )

    const { write: run } = await probe(project, 'docs-agent-hardwall')

    const absolute = await run(join(project, 'src', 'x.ts'), 'const a = 1 // BANNED')
    expect(absolute.blocked).toBe(true)
    expect(absolute.detail).toContain('no-banned')

    // And again: a refusal is not a delivery, so it must not open the second time.
    const again = await run(join(project, 'src', 'y.ts'), 'const b = 2 // BANNED')
    expect(again.blocked).toBe(true)
  })
})

/** One `write` call at an explicit path. */
function writeExecutionFor(agent: Agent, filePath: string, content: string): ToolExecutionInput {
  return {
    token: Symbol('execution') as never,
    callId: `call-${filePath}` as never,
    name: 'write',
    arguments: { file_path: filePath, content },
    signal: new AbortController().signal,
    agent,
  } as unknown as ToolExecutionInput
}

/** A stand-in session: the store only ever hands it back. */
function stubSession(label: string): RuleSession {
  return { label } as unknown as RuleSession
}

/**
 * Read the marker a {@link stubSession} carries.
 *
 * `RuleSession` has no `label`, so the stub smuggles one in to say which build
 * the store handed back. Typed access keeps the assertions readable instead of
 * casting at every call site.
 */
function labelOf(session: RuleSession | undefined): string | undefined {
  return (session as unknown as { label?: string } | undefined)?.label
}

function storeAgent(id: string): Agent {
  return { id, cancel() {}, steer() {}, inject() {}, session: { header: { cwd: '/tmp' } } } as unknown as Agent
}

describe('the rule session store', () => {
  it('does not turn a failed discovery on a synchronous surface into an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)

    try {
      const store = new RuleSessionStore(async () => { throw new Error('a rule file could not be read') })
      const agent = storeAgent('unhandled-1')

      // `get()` is synchronous and cannot hand the rejection to a caller, so
      // `ensure`'s deliberate re-throw has to be caught here or Node's default
      // `--unhandled-rejections=throw` kills the process over one bad file.
      expect(store.get(agent)).toBeUndefined()
      await new Promise<void>(resolve => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    // And the failure is not sticky: the next surface gets a fresh attempt.
    let attempts = 0
    const retrying = new RuleSessionStore(async () => {
      attempts += 1
      return stubSession(`attempt-${attempts}`)
    })
    const agent = storeAgent('unhandled-2')
    retrying.get(agent)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
    expect(labelOf(retrying.get(agent))).toBe('attempt-1')
  })

  it('does not commit a build that started before an invalidate', async () => {
    let calls = 0
    let unblock = (): void => {}
    const gate = new Promise<void>(resolve => { unblock = resolve })
    const store = new RuleSessionStore(async () => {
      calls += 1
      if (calls === 1) await gate
      return stubSession(`build-${calls}`)
    })
    const agent = storeAgent('stale-1')

    store.get(agent)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
    expect(calls).toBe(1)

    // A configuration change lands while discovery is still walking the disk.
    store.invalidate()
    unblock()
    await new Promise<void>(resolve => setTimeout(resolve, 20))

    // The pre-change rule set must not be written back over the edit.
    expect(store.get(agent)).toBeUndefined()
    expect(labelOf(await store.ready(agent))).toBe('build-2')
  })

  it('does not resurrect a released agent through its in-flight build', async () => {
    let unblock = (): void => {}
    const gate = new Promise<void>(resolve => { unblock = resolve })
    const store = new RuleSessionStore(async () => {
      await gate
      return stubSession('gone')
    })
    const agent = storeAgent('released-1')

    store.get(agent)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
    store.release(agent)
    unblock()
    await new Promise<void>(resolve => setTimeout(resolve, 20))

    expect(store.getById('released-1' as never)).toBeUndefined()
  })

  it('rebuilds every known agent so the next step sees the new rules, not none', async () => {
    let generation = 1
    const store = new RuleSessionStore(async () => stubSession(`config-${generation}`))
    const agent = storeAgent('rebuild-1')

    store.note(agent)
    expect(labelOf(await store.ready(agent))).toBe('config-1')
    expect(labelOf(store.get(agent))).toBe('config-1')

    // What `loader/volatile-update` does: invalidate, then start the build
    // straight away. The prompt layer is rendered synchronously, so waiting for
    // the next step would render no rule layer at all.
    generation = 2
    store.rebuildAll()
    expect(labelOf(await store.ready(agent))).toBe('config-2')
    expect(labelOf(store.get(agent))).toBe('config-2')

    // Idempotent: a second call finds the build already running.
    generation = 3
    store.rebuildAll()
    store.rebuildAll()
    expect(labelOf(await store.ready(agent))).toBe('config-3')
    expect(labelOf(store.get(agent))).toBe('config-3')
  })
})

describe('the trigger ledger', () => {
  let realHome: string | undefined

  beforeEach(() => {
    realHome = process.env['DSH_HOME']
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = realHome
  })

  /** The ledger the plugin writes under the current `$DSH_HOME`. */
  function ledger(): string {
    return join(process.env['DSH_HOME'] as string, 'dsh-rules', 'triggers.json')
  }

  it('leaves an unparseable ledger alone rather than resetting every count to one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rules-damaged-'))
    process.env['DSH_HOME'] = home
    await mkdir(join(home, 'dsh-rules'), { recursive: true })
    await writeFile(ledger(), '{"ts-set-map": 412')

    recordTrigger('go-ioutil')
    // The flush is coalesced behind a two-second timer.
    await new Promise<void>(resolve => setTimeout(resolve, 2400))

    // Merging into an empty object and writing back would replace a lifetime of
    // counts with this one delivery. Losing this delivery is recoverable.
    expect(readFileSync(ledger(), 'utf8')).toBe('{"ts-set-map": 412')
    // Still counted in memory, and still offered for a later flush.
    expect(triggerCounts()['go-ioutil']).toBe(1)

    await rm(home, { recursive: true, force: true })
  })

  it('flushes through a per-process temporary file, so two processes cannot collide', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rules-tmp-'))
    process.env['DSH_HOME'] = home
    const dir = join(home, 'dsh-rules')
    await mkdir(dir, { recursive: true })
    // A directory where the ledger belongs: `readFileSync` fails on it, so the
    // reader treats this as a first run, and the final `rename` onto it fails,
    // which leaves the scratch file behind for this assertion to name. The write
    // itself still has to get that far.
    await mkdir(ledger(), { recursive: true })

    recordTrigger('ts-no-any')
    const deadline = Date.now() + 5000
    while ((await readdir(dir)).length === 1 && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 40))
    }

    // The web app, the CLI and one-shot runs share one `$DSH_HOME`, so a fixed
    // `.tmp` name let one process truncate what another had just written, the
    // first `rename` publish the second's bytes, and the second throw ENOENT —
    // dropping a delivery that nothing ever retries.
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([`triggers.json.${process.pid}.tmp`])

    await rm(home, { recursive: true, force: true })
  })
})

describe('one agent leaving does not disturb another', () => {
  it('still commits the other agent\'s in-flight build', async () => {
    let unblock: () => void = () => {}
    const gate = new Promise<void>(resolve => { unblock = resolve })
    const store = new RuleSessionStore(async agent => {
      if (agent.id === 'slow-2') await gate
      return stubSession(`built-${agent.id}`)
    })
    const leaving = storeAgent('leaving-1')
    const staying = storeAgent('slow-2')

    store.get(leaving)
    store.get(staying)
    await new Promise<void>(resolve => setTimeout(resolve, 5))

    store.release(leaving)
    unblock()
    await new Promise<void>(resolve => setTimeout(resolve, 20))

    // The discard is per-agent: releasing one id must not evict another
    // agent's build that was about to land.
    expect(labelOf(store.get(staying))).toBe('built-slow-2')
    expect(store.getById('leaving-1' as never)).toBeUndefined()
  })
})
