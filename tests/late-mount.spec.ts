import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/runtime.ts'

let fixture: string

beforeAll(async () => {
  fixture = join(await mkdtemp(join(tmpdir(), 'dsh-rules-late-')), 'project')
  await mkdir(join(fixture, '.omp', 'rules'), { recursive: true })
  await writeFile(
    join(fixture, '.omp', 'rules', 'no-console-log.md'),
    '---\ndescription: Read this before writing any logging call.\n---\n\nLogs are for operators, not for debugging.\n',
  )
  await writeFile(join(fixture, '.omp', 'RULES.md'), 'This project writes tests before claiming a fix works.\n')
})

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true })
})

/** One `rule` tool call through the real registry pipeline. */
function ruleExecution(agent: Agent, name: string): ToolExecutionInput {
  return {
    token: Symbol('execution') as never,
    callId: 'call-late' as never,
    name: 'rule',
    arguments: { name },
    signal: new AbortController().signal,
    agent,
  } as unknown as ToolExecutionInput
}

describe('a plugin that mounts after its agents exist', () => {
  it('gives an already-running agent its rules on the next use', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)

    // The agent is created and running first; the plugin is not mounted yet.
    const agent = await harness.create('pre-existing' as SessionId, { provider: 'scripted', model: 'm' }, { cwd: fixture })

    const before = renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent }))
    expect(before).not.toContain('<domain-rules>')

    apply(ctx, { enabled: true, userRulesDir: join(fixture, 'no-user'), pluginRoots: [] })

    const tool = ctx.tools.get('rule', agent)
    expect(tool).toBeDefined()

    const result = await ctx.tools.execute(ruleExecution(agent, 'no-console-log'))
    expect(JSON.stringify(result.value)).toContain('Logs are for operators')

    await agent.whenIdle()
    await new Promise<void>(resolve => setTimeout(resolve, 100))

    const after = renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent }))
    expect(after).toContain('<domain-rules>')
    expect(after).toContain('no-console-log')
    expect(after).toContain('<generic-rules>')
    expect(after).toContain('This project writes tests before claiming a fix works.')
  })
})
