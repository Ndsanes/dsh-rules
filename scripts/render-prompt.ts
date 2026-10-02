/**
 * Render the system prompt the plugin contributes for a real project.
 *
 * Usage: `npx tsx scripts/render-prompt.ts <project-root>`
 *
 * This mounts the plugin on a real dsh system-prompt service and assembles the
 * prompt, so the output is exactly what the model receives — without a model
 * call, which needs a reachable provider.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/runtime.ts'

const cwd = process.argv[2] ?? process.cwd()
const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)

apply(ctx, { enabled: true, userRulesDir: join(await mkdtemp(join(tmpdir(), 'dsh-rules-')), 'no-user') })

const agent = {
  id: 'session-1',
  cancel() {},
  steer() {},
  inject() {},
  session: { header: { cwd } },
} as unknown as Agent

await ctx.emit('agent/created', { agent, source: 'startup' })
await new Promise<void>(resolve => setTimeout(resolve, 300))

const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
console.log(renderPrompt(assembly))
process.exit(0)
