import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/runtime.ts'

/**
 * Adapter that speaks a scripted sequence of replies.
 *
 * The first reply violates the rule and every later reply complies, so a
 * correct interrupt shows up as a second request carrying the rule body.
 */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly replies: readonly string[]) {
    super()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const reply = this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)] ?? ''
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const char of reply) {
      if (options.signal?.aborted === true) return
      yield { type: 'text-delta', index: 0, text: char }
      await new Promise<void>(resolve => setTimeout(resolve, 1))
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A project whose only rule fires on one word, with the given interrupt mode. */
async function makeProject(name: string, interruptMode: string): Promise<string> {
  const project = join(await mkdtemp(join(tmpdir(), `dsh-rules-${name}-`)), 'project')
  await mkdir(join(project, '.omp', 'rules'), { recursive: true })
  await writeFile(
    join(project, '.omp', 'rules', 'no-banana.md'),
    `---\ndescription: Never write the word banana.\ncondition: 'banana'\nscope: text\ninterruptMode: ${interruptMode}\n---\n\nWrite the word pear instead of banana.\n`,
  )
  return project
}

let interruptingProject: string
let quietProject: string

beforeAll(async () => {
  interruptingProject = await makeProject('interrupt', 'always')
  quietProject = await makeProject('quiet', 'never')
})

afterAll(async () => {
  await rm(interruptingProject, { recursive: true, force: true })
  await rm(quietProject, { recursive: true, force: true })
})

/** Wait for the agent to settle, then again past the interrupt retry timer. */
async function settle(agent: Agent): Promise<void> {
  await agent.whenIdle()
  await new Promise<void>(resolve => setTimeout(resolve, 150))
  await agent.whenIdle()
}

/** Run one scripted session on a real agent loop. */
async function runProject(cwd: string, replies: readonly string[]): Promise<{ adapter: ScriptedAdapter; agent: Agent }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new ScriptedAdapter(replies)
  ctx.llm.registerAdapter(['scripted'], adapter)

  apply(ctx, { enabled: true, userRulesDir: join(cwd, 'no-user'), pluginRoots: [] })
  const harness = await mountAgentLoopTestHarness(ctx)

  const agent = await harness.create('interrupt-session' as SessionId, { provider: 'scripted', model: 'scripted-1' }, { cwd })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'name a fruit' }], source: { kind: 'user' } }))
  await settle(agent)

  return { adapter, agent }
}

describe('interrupt inside a real agent loop', () => {
  it('aborts the violating generation and retries with the rule in context', async () => {
    const { adapter } = await runProject(interruptingProject, ['banana', 'pear'])

    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1])).toContain('Write the word pear instead of banana')
  })

  it('carries the interrupt as a system-interrupt message, not a user turn', async () => {
    const { adapter } = await runProject(interruptingProject, ['banana', 'pear'])

    const retry = JSON.stringify(adapter.requests[1])
    expect(retry).toContain('<system-interrupt')
    expect(retry).toContain('dsh-rules')
  })

  it('warns without retrying the same reply when the rule only warns', async () => {
    const { adapter } = await runProject(quietProject, ['banana', 'pear'])

    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1])).toContain('<system-reminder')
    expect(JSON.stringify(adapter.requests[1])).not.toContain('<system-interrupt')
  })

  it('spends the rule once, so a later violating turn is not retried', async () => {
    const { adapter, agent } = await runProject(interruptingProject, ['banana', 'pear', 'banana', 'pear'])

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await settle(agent)

    // 1 violating turn, 1 retry, then the second turn passes through untouched.
    expect(adapter.requests).toHaveLength(3)
  })
})
