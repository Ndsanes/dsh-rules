/**
 * Serializable configuration, schema, and defaults.
 *
 * The `ttsr` block mirrors OMP's `ttsr` settings so an existing rule set keeps
 * its meaning; discovery roots are the plugin's own additions.
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InterruptMode } from './rule.ts'

/** Streaming-rule settings as authored in a configuration file. */
export type TtsrFileConfig = TtsrConfig

/** Plugin configuration supplied by the profile composition. */
export interface Config {
  /** Master switch; when false nothing is discovered or injected. */
  enabled?: boolean
  /** OMP's native agent directory holding user-level `rules/` and `RULES.md`. */
  userRulesDir?: string
  /** Extra roots whose `rules/` directory contributes plugin rules. */
  pluginRoots?: string[]
  /** Directories searched for `.github/instructions`, overriding the env var. */
  copilotInstructionDirs?: string[]
  /** Profile row id the settings service writes rule toggles to. */
  settingsNamespace?: string
  /**
   * Time-traveling stream rule settings.
   *
   * Volatile as a whole block: toggling a rule must take effect on the next
   * step instead of waiting for a restart. The Cordis loader supplies a live
   * reference read with `.get()`; a direct caller may pass plain data, which
   * {@link liveTtsr} accepts either way.
   */
  ttsr?: Volatile<ResolvedTtsrConfig> | Partial<ResolvedTtsrConfig>
}

/** Streaming-rule settings, matching OMP's `ttsr` configuration block. */
export interface TtsrConfig {
  enabled?: boolean
  /** Default interrupt mode; a rule's own `interruptMode` overrides it. */
  interruptMode?: InterruptMode
  /** Whether the interrupted partial output stays in conversation history. */
  contextMode?: 'discard' | 'keep'
  /** How often one rule may trigger. */
  repeatMode?: 'once' | 'after-gap'
  /** Completed turns required before an `after-gap` rule may trigger again. */
  repeatGap?: number
  /** Whether the embedded builtin rules stay enabled. */
  builtinRules?: boolean
  /** Rule names excluded from every bucket. */
  disabledRules?: string[]
  /** `auto` judges only with a configured judge model, `on` always, `off` never. */
  judge?: 'auto' | 'on' | 'off'
  /** Provider route used to answer `question` rules. */
  judgeProvider?: string
  /** Model used to answer `question` rules. */
  judgeModel?: string
}

/** Streaming-rule settings after every default has been resolved. */
export interface ResolvedTtsrConfig {
  enabled: boolean
  interruptMode: InterruptMode
  contextMode: 'discard' | 'keep'
  repeatMode: 'once' | 'after-gap'
  repeatGap: number
  builtinRules: boolean
  disabledRules: readonly string[]
  judge: 'auto' | 'on' | 'off'
  judgeProvider: string | undefined
  judgeModel: string | undefined
}

/** Configuration after every default has been resolved. */
export interface ResolvedConfig {
  enabled: boolean
  userRulesDir: string
  pluginRoots: string[]
  copilotInstructionDirs: string[]
  settingsNamespace: string
  ttsr: ResolvedTtsrConfig
}

const TTSR_DEFAULTS = {
  enabled: true,
  interruptMode: 'always' as InterruptMode,
  contextMode: 'keep' as const,
  repeatMode: 'once' as const,
  repeatGap: 10,
  builtinRules: true,
  disabledRules: [] as string[],
  judge: 'auto' as const,
}

/**
 * Expand a leading `~` to the user's home directory.
 *
 * The bundle patch ships `userRulesDir: '~/.omp/agent'` so the shipped default
 * is portable across machines, but every consumer hands the value straight to
 * `join()`, and `join('~/x', 'rules')` is a *relative* path that resolves
 * against whatever directory the process was launched in. Without this the
 * shipped default silently discovers nothing, with no warning to explain why.
 *
 * @param path - a configured path, possibly starting with `~`.
 */
export function expandHome(path: string): string {
  if (path !== '~' && !path.startsWith('~/') && !path.startsWith('~\\')) return path
  return join(homedir(), path.slice(1))
}

/** Loader-visible configuration schema. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  userRulesDir: z.string().default(join(homedir(), '.omp', 'agent')),
  pluginRoots: z.array(z.string()).default([]),
  copilotInstructionDirs: z.array(z.string()).default([]),
  settingsNamespace: z.string().default('dsh-rules'),
  ttsr: z.object({
    enabled: TTSR_DEFAULTS.enabled,
    interruptMode: z.union(['always', 'never', 'prose-only', 'tool-only'] as const).default(TTSR_DEFAULTS.interruptMode),
    contextMode: z.union(['discard', 'keep'] as const).default(TTSR_DEFAULTS.contextMode),
    repeatMode: z.union(['once', 'after-gap'] as const).default(TTSR_DEFAULTS.repeatMode),
    repeatGap: z.number().min(1).default(TTSR_DEFAULTS.repeatGap),
    builtinRules: z.boolean().default(TTSR_DEFAULTS.builtinRules),
    disabledRules: z.array(z.string()).default(TTSR_DEFAULTS.disabledRules),
    judge: z.union(['auto', 'on', 'off'] as const).default(TTSR_DEFAULTS.judge),
    judgeProvider: z.string(),
    judgeModel: z.string(),
  }).volatile(),
})

/** Defaults for every streaming-rule setting. */
export const TTSR_DEFAULT: ResolvedTtsrConfig = {
  enabled: true,
  interruptMode: 'always',
  contextMode: 'keep',
  repeatMode: 'once',
  repeatGap: 10,
  builtinRules: true,
  disabledRules: [],
  judge: 'auto',
  judgeProvider: undefined,
  judgeModel: undefined,
}

/**
 * Resolve the streaming-rule settings a caller should apply right now.
 *
 * The value is read on every call so a live toggle takes effect on the next
 * step rather than the next restart.
 *
 * @param source - the plugin's live config, or a plain object for direct callers.
 */
export function liveTtsr(source: Config | undefined): ResolvedTtsrConfig {
  const value = source?.ttsr
  if (value === undefined) return TTSR_DEFAULT
  if (isVolatileRef(value)) return value.get() ?? TTSR_DEFAULT
  return { ...TTSR_DEFAULT, ...value }
}

/** Report whether a config field is a live reference rather than plain data. */
function isVolatileRef(value: unknown): value is { get(): ResolvedTtsrConfig | undefined } {
  return typeof (value as { get?: unknown } | undefined)?.get === 'function'
}

/**
 * Resolve defaults for callers that bypass the Cordis loader.
 * @param config - partial serialized configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const ttsr = (liveTtsr(config) ?? {}) as Partial<ResolvedTtsrConfig>
  return {
    enabled: config.enabled ?? true,
    userRulesDir: expandHome(config.userRulesDir ?? join(homedir(), '.omp', 'agent')),
    pluginRoots: (config.pluginRoots ?? []).map(expandHome),
    copilotInstructionDirs: (config.copilotInstructionDirs ?? []).map(expandHome),
    settingsNamespace: config.settingsNamespace ?? 'dsh-rules',
    ttsr: {
      enabled: ttsr.enabled ?? TTSR_DEFAULTS.enabled,
      interruptMode: ttsr.interruptMode ?? TTSR_DEFAULTS.interruptMode,
      contextMode: ttsr.contextMode ?? TTSR_DEFAULTS.contextMode,
      repeatMode: ttsr.repeatMode ?? TTSR_DEFAULTS.repeatMode,
      repeatGap: ttsr.repeatGap ?? TTSR_DEFAULTS.repeatGap,
      builtinRules: ttsr.builtinRules ?? TTSR_DEFAULTS.builtinRules,
      disabledRules: ttsr.disabledRules ?? TTSR_DEFAULTS.disabledRules,
      judge: ttsr.judge ?? TTSR_DEFAULTS.judge,
      judgeProvider: ttsr.judgeProvider,
      judgeModel: ttsr.judgeModel,
    },
  }
}
