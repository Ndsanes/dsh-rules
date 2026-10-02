/**
 * Types for the browser half's copy table.
 * @module dsh-rules/client/i18n
 */

/** One language's strings; every locale defines the same keys. */
export type CopyTable = Record<string, string>

/** Bundled copy, English first and the key source. */
export const COPY: { en: CopyTable; zh: CopyTable }

/** A translator: resolves a key and fills its `{{placeholders}}`. */
export type Translator = (key: string, values?: Record<string, string | number>) => string

/** Builds a translator for one locale id, falling back key by key to English. */
export function translator(locale: string | undefined): Translator

/** Source labels in one locale's words. */
export const SOURCE_LABEL: { en: Record<string, string>; zh: Record<string, string> }

/**
 * Host reason code to the copy key that explains it.
 *
 * The Host sends codes (`disabled`, `builtins-off`, `agent-filter`,
 * `no-trigger`, `shadowed`), so the page resolves one through `REASON_KEY` and
 * renders it from `COPY` in the reader's language. A code with no entry here is
 * shown verbatim rather than flattened to "unknown".
 */
export const REASON_KEY: Record<string, string>

/**
 * Name a rule's origin for one locale.
 *
 * @param locale - active locale; anything not starting with `zh` reads English.
 * @param provider - discovery provider id behind the label.
 * @param scope - the tree's own name, when the rule carries one: every project
 *   keeps its rules in `.omp/rules`, so without it two projects produce one
 *   indistinguishable label.
 * @returns a label that distinguishes projects from each other.
 */
export function sourceLabel(locale: string | undefined, provider: string, scope?: string): string
