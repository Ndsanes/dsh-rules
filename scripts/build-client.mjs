/**
 * Minify the browser half into the artifact the module loader serves.
 *
 * The loader envelope and the CommonJS preamble are written in the source,
 * because the loader calls the factory with `require` and nothing else. Only
 * minification happens here, so what ships stays reviewable against its source.
 *
 * The loader's `require` resolves platform modules by name, so anything local
 * has to be inlined: the bundled-rule catalog is a JSON file, and the copy table
 * is a source module whose `export` keywords are stripped. Both substitutions
 * assert what they expect, so a renamed module fails the build rather than
 * shipping a page that throws on load.
 *
 * Usage: `node scripts/build-client.mjs`
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = join(root, 'src', 'client')

/** Inline the bundled-rule catalog as a data literal. */
async function inlineCatalog(source) {
  const marker = /require\((['"])\.\/builtin-catalog\.js\1\)\.BUNDLED_RULES/g
  marker.lastIndex = 0
  if (!marker.test(source)) throw new Error('client source lost its catalog marker')
  marker.lastIndex = 0
  const catalog = JSON.parse(await readFile(join(clientDir, 'builtin-catalog.json'), 'utf8'))
  return source.replaceAll(marker, JSON.stringify(catalog))
}

/** Inline the codec module the way the copy module is inlined. */
async function inlineCodec(source) {
  const marker = /require\((['"])\.\/codec\.js\1\)/g
  marker.lastIndex = 0
  if (!marker.test(source)) throw new Error('client source lost its codec marker')
  marker.lastIndex = 0
  const body = (await readFile(join(clientDir, 'codec.js'), 'utf8'))
    .replace(/^\s*export\s+(const|function)\s/gm, '$1 ')
  if (!body.includes('const CODECS')) throw new Error('codec module is missing CODECS')
  return source.replaceAll(marker, `(() => {${body}\nreturn { CODECS }})()`)
}

/**
 * Inline the frontmatter module.
 *
 * Without this the bundle simply has no `parseRuleFile`, and the editor's form
 * mode fails only in the browser — the build stays green because nothing here
 * resolves the require.
 */
async function inlineFrontmatter(source) {
  const marker = /require\((['"])\.\/frontmatter\.js\1\)/g
  marker.lastIndex = 0
  if (!marker.test(source)) throw new Error('client source lost its frontmatter marker')
  marker.lastIndex = 0
  const body = (await readFile(join(clientDir, 'frontmatter.js'), 'utf8'))
    .replace(/^\s*export\s+(const|function)\s/gm, '$1 ')
  for (const name of ['FIELD_SPECS', 'parseRuleFile', 'serialiseRuleFile', 'hasFields']) {
    if (!body.includes(name)) throw new Error(`frontmatter module is missing ${name}`)
  }
  return source.replaceAll(marker, `(() => {${body}\nreturn { FIELD_SPECS, parseRuleFile, serialiseRuleFile, hasFields }})()`)
}

/** Inline the copy module by stripping its `export` keywords. */
async function inlineCopy(source) {
  const marker = /require\((['"])\.\/i18n\.js\1\)/g
  marker.lastIndex = 0
  if (!marker.test(source)) throw new Error('client source lost its i18n marker')
  marker.lastIndex = 0
  const body = (await readFile(join(clientDir, 'i18n.js'), 'utf8'))
    .replace(/^\s*export\s+(const|function)\s/gm, '$1 ')
  for (const expected of ['function translator', 'const SOURCE_LABEL', 'function sourceLabel', 'const REASON_KEY']) {
    if (!body.includes(expected)) throw new Error(`i18n module is missing ${expected}`)
  }
  // The body declares several bindings, so it needs an IIFE rather than a
  // parenthesised group to become a single expression.
  // Every binding the page imports must be returned, or the page reads
  // `undefined` at runtime instead of failing here.
  const iife = `(() => {${body}\nreturn { translator, sourceLabel, REASON_KEY }})()`
  return source.replaceAll(marker, iife)
}

const source = await inlineCopy(await inlineFrontmatter(
  await inlineCodec(await inlineCatalog(await readFile(join(clientDir, 'index.js'), 'utf8'))),
))

const result = await transform(source, {
  minify: true,
  keepNames: false,
  legalComments: 'none',
  target: 'es2022',
  format: 'esm',
  charset: 'utf8',
})

await mkdir(join(root, 'client'), { recursive: true })

const header = '// Generated from src/client/index.js by `node scripts/build-client.mjs`. Do not edit directly.\n'
const outPath = join(root, 'client', 'client.js')
await writeFile(outPath, header + result.code, 'utf8')
console.log(`src/client/index.js -> client/client.js (${(header + result.code).length} bytes)`)
