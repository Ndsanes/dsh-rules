/**
 * Load a real OMP rule set and print what the plugin parsed from it.
 *
 * Usage: `bunx tsx scripts/audit-rules.ts <project-root>`
 *
 * This is the backward-compatibility check: a rule set authored for OMP must
 * load here without edits, with every trigger field intact.
 */

import { bucketRules } from '../src/buckets.ts'
import { loadCapability } from '../src/capability.ts'
import { discoverAll } from '../src/discovery.ts'
import { TtsrManager } from '../src/ttsr.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

const cwd = process.argv[2] ?? process.cwd()
const providers = await discoverAll({
  cwd,
  userRulesDir: join(homedir(), '.omp', 'agent'),
  pluginRoots: [],
  copilotInstructionDirs: [],
})

const ttsr = new TtsrManager(() => ({ enabled: true, interruptMode: 'always', repeatMode: 'once', repeatGap: 10 }))
const capability = loadCapability(providers)
const buckets = bucketRules(capability.items, {
  builtinRules: true,
  disabledRules: [],
  agentName: 'main',
  registerTtsr: rule => ttsr.addRule(rule).accepted,
})

const summarize = (label: string, rules: typeof buckets.rulebookRules): void => {
  console.log(`\n${label} (${rules.length})`)
  for (const rule of rules) {
    const parts = [
      rule.name,
      rule.description === undefined ? '' : 'description',
      rule.alwaysApply === true ? 'alwaysApply' : '',
      rule.globs === undefined ? '' : `globs=${rule.globs.join('|')}`,
      rule.condition === undefined ? '' : `condition=${rule.condition.length}`,
      rule.astCondition === undefined ? '' : `astCondition=${rule.astCondition.length}`,
      rule.question === undefined ? '' : 'question',
      rule.scope === undefined ? '' : `scope=${rule.scope.map(token => `${token.surface}${token.tool === undefined ? '' : `:${token.tool}`}`).join('|')}`,
      rule.agents === undefined ? '' : `agents=${rule.agents.join('|')}`,
      rule.interruptMode === undefined ? '' : `interrupt=${rule.interruptMode}`,
    ].filter(part => part !== '')
    console.log(`  ${parts.join('  ')}`)
  }
}

console.log(`cwd: ${cwd}`)
console.log(`providers: ${providers.map(provider => `${provider.provider}=${provider.rules.length}`).join('  ')}`)
console.log(`shadowed: ${capability.all.filter(rule => rule._shadowed === true).map(rule => rule.name).join(', ') || 'none'}`)
console.log(`dropped: ${buckets.dropped.map(rule => rule.name).join(', ') || 'none'}`)

summarize('rulebook', buckets.rulebookRules)
summarize('always-apply', buckets.alwaysApplyRules)
summarize('ttsr', buckets.ttsrRules)

const ruleWarnings = capability.all.flatMap(rule =>
  (rule._warnings ?? []).map(warning => `${rule.name}: ${warning}`),
)
if (ruleWarnings.length > 0) console.log(`\nfrontmatter warnings:\n  ${ruleWarnings.join('\n  ')}`)

const warnings = ttsr.warnings
if (warnings.length > 0) console.log(`\nttsr warnings:\n  ${warnings.join('\n  ')}`)
if (capability.warnings.length > 0) console.log(`\ndiscovery warnings:\n  ${capability.warnings.join('\n  ')}`)
