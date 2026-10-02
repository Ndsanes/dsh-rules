/**
 * Generate the bundled-rule modules the host and the browser consume.
 *
 * The Markdown files under `src/builtin-rules/` are the source of truth: they
 * stay readable, diffable, and editable by anyone maintaining this plugin. The
 * bundler cannot import them as text, so this script emits two artifacts from
 * the same files:
 *
 * - `src/generated/builtin-rules.ts` for the Host, with full rule text.
 * - `src/client/builtin-catalog.json` for the browser, which only needs each
 *   rule's name and description to draw its toggle list. It is plain JSON so
 *   the client build inlines it as data rather than splicing source.
 *
 * Usage: `node --experimental-strip-types scripts/embed-builtin-rules.mts`
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rulesDir = join(root, 'src', 'builtin-rules')

const files = (await readdir(rulesDir)).filter(name => name.endsWith('.md')).sort()

/** The rule's one-line description, or an empty string when it declares none. */
function descriptionOf(markdown: string): string {
  const matched = /^description:\s*(.*)$/m.exec(markdown)
  const value = matched?.[1]?.trim() ?? ''
  return value.replace(/^["']|["']$/g, '')
}

const hostEntries = await Promise.all(files.map(async name => {
  const text = await readFile(join(rulesDir, name), 'utf8')
  return `  ${JSON.stringify(name)}: ${JSON.stringify(text)},`
}))

const catalog = await Promise.all(files.map(async name => [
  name.replace(/\.md$/, ''),
  descriptionOf(await readFile(join(rulesDir, name), 'utf8')),
] as const))

const hostModule = `/**
 * Builtin rule text, generated from \`src/builtin-rules/*.md\`.
 *
 * Do not edit by hand. Run \`pnpm run embed:rules\` after changing a rule file.
 *
 * These rules come from OMP's \`builtin-defaults\` provider, MIT licensed, and
 * carry the same names so a rule file in either harness overrides the other.
 *
 * @module dsh-rules/builtin-rules
 */

/** Bundled rule markdown, keyed by file name. */
export const BUILTIN_RULE_SOURCES: Readonly<Record<string, string>> = {
${hostEntries.join('\n')}
}
`

const catalogJson = `${JSON.stringify(Object.fromEntries(catalog), null, 2)}\n`

await mkdir(join(root, 'src', 'generated'), { recursive: true })
await writeFile(join(root, 'src', 'generated', 'builtin-rules.ts'), hostModule, 'utf8')
await writeFile(join(root, 'src', 'client', 'builtin-catalog.json'), catalogJson, 'utf8')
console.log(`embedded ${files.length} builtin rules for the host and the browser`)
