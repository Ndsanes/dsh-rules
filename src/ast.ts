/**
 * Structural (`astCondition`) matching.
 *
 * Language is inferred from the candidate file's extension; a stream whose path
 * carries no usable extension is skipped, because a wrong grammar would report
 * a confident non-match. Parse and match failures count as no match and are
 * surfaced as warnings rather than thrown.
 *
 * The native addon is loaded on first use, not at import time. `@ast-grep/napi`
 * binds a platform-specific `.node` binary at `require` time, so a static import
 * made a missing or stripped prebuild take down the whole plugin at module
 * initialization — long before any `try` in this file could run — instead of
 * costing one matching surface. The load is therefore wrapped, and a failed
 * load degrades {@link astMatch} to "no match" with a warning.
 */

import { createRequire } from 'node:module'
import type * as AstGrepModule from '@ast-grep/napi'
import type { Lang, SgNode } from '@ast-grep/napi'

/**
 * Extension to the ast-grep grammar name, for callers that only have a path.
 *
 * Probed against `@ast-grep/napi@0.45`: its `Lang` enum is exactly
 * `Html | JavaScript | Tsx | Css | TypeScript`, and `parse('Go', src)` throws
 * `Go is not supported in napi`. Go and Rust grammars are therefore unreachable
 * from here — this module never calls `registerDynamicLanguage`, so the
 * separate `@ast-grep/lang-go` / `@ast-grep/lang-rust` packages would not help
 * either. Listing them would add entries that can never resolve, so a rule
 * gated on those extensions is warned about at build time instead.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  tsx: 'Tsx',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  html: 'Html',
  css: 'Css',
}

/**
 * Warnings raised by the degraded paths, deduplicated and in encounter order.
 *
 * Bounded by construction: one entry per distinct extension and one per failed
 * load, so a long session cannot grow this without limit.
 */
const warnings: string[] = []
const warned = new Set<string>()

/** Record one warning at most once per process. */
function warn(message: string): void {
  if (warned.has(message)) return
  warned.add(message)
  warnings.push(message)
}

/** Every degradation {@link astMatch} has hit, for the surfaces that report them. */
export function astWarnings(): readonly string[] {
  return warnings
}

/** The loaded addon, or null when it could not be loaded. */
type AstGrep = typeof AstGrepModule

let addon: AstGrep | null | undefined

/**
 * Load `@ast-grep/napi` on first use.
 *
 * @returns the addon, or null when the native binary is unavailable.
 */
function loadAddon(): AstGrep | null {
  if (addon !== undefined) return addon
  try {
    addon = createRequire(import.meta.url)('@ast-grep/napi') as AstGrep
  } catch (error) {
    addon = null
    warn(`ast-grep: the native addon failed to load (${error instanceof Error ? error.message : String(error)}); astCondition never matches`)
  }
  return addon
}

/**
 * Report whether ast-grep can parse this extension at all.
 *
 * Lets a rule say up front that its structural patterns are unreachable instead
 * of skipping every candidate silently.
 */
export function isAstExtensionSupported(extension: string): boolean {
  return LANGUAGE_BY_EXTENSION[extension.replace(/^\./, '').toLowerCase()] !== undefined
}

/**
 * Infer the grammar for one file path.
 *
 * Pure lookup: the `Lang` values are the enum's own strings, so no native code
 * is touched here. Deciding a grammar must never be what pulls the addon in.
 *
 * @returns the language, or undefined when the extension is unknown.
 */
export function languageForPath(path: string): Lang | undefined {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  const name = LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()]
  return name as Lang | undefined
}

/**
 * Test one source snapshot against ast-grep patterns.
 *
 * Known limitation: `parse` is the synchronous native call, re-parsed for every
 * (rule, candidate) pair on the tool path — roughly 50ms for a 20k-line
 * snapshot. `parseAsync` would move that off the loop, but this function is
 * called synchronously from the session's tool-violation pass, so switching it
 * means making that call chain async; left alone deliberately.
 *
 * @param snapshot - the tool's reconstructed source, not the prospective file.
 * @param path - candidate file path used to infer the grammar.
 * @param patterns - ast-grep pattern strings from the rule's `astCondition`.
 * @returns true when any pattern matches.
 */
export function astMatch(snapshot: string, path: string, patterns: readonly string[]): boolean {
  const language = languageForPath(path)
  if (language === undefined) {
    const extension = path.slice(path.lastIndexOf('.') + 1)
    if (extension !== path && extension !== '') {
      warn(`ast-grep: no grammar is bundled for .${extension}; astCondition is skipped on these paths`)
    }
    return false
  }

  // Loaded here and nowhere earlier: this is the only point where the native
  // binary is actually needed, so a missing prebuild costs this one surface.
  const api = loadAddon()
  if (api === null) return false

  let root: SgNode | undefined
  try {
    root = api.parse(language, snapshot).root()
  } catch {
    return false
  }
  if (root === undefined) return false

  return patterns.some(pattern => {
    try {
      return root.find(pattern) !== null
    } catch {
      return false
    }
  })
}
