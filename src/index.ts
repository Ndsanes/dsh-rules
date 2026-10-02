/**
 * OMP rules for DeepSeek Harness.
 *
 * Discovers OMP-format rule files from every convention OMP supports, injects
 * the always-apply and rulebook layers into the system prompt, exposes rules
 * by name through the `rule` tool, and enforces time-traveling stream rules
 * that interrupt violating model output mid-turn.
 *
 * @module dsh-rules
 */

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'dsh-rules'

/** Services that must exist before the plugin is applied. */
export const inject = ['agents', 'tools', 'systemPrompt']

export { Config, resolveConfig, type ResolvedConfig, type TtsrConfig } from './config.ts'
export { apply } from './runtime.ts'
export type { Rule, InterruptMode, ScopeToken, RuleSource } from './rule.ts'
export type { ProviderResult, DiscoveryOptions } from './discovery.ts'
export type { CapabilityResult } from './capability.ts'
export type { Buckets, BucketOptions } from './buckets.ts'
