import { load } from 'js-yaml'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import manifest from '../package.json' with { type: 'json' }
import { name as hostPluginName } from '../src/index.ts'
import { TYPERT } from '../src/typert.host.ts'

/**
 * The package's published identity, checked against every place it is written.
 *
 * The loader resolves a bundle row to the module it named, so a patch row that
 * disagrees with `package.json` installs a bundle whose layer never mounts — and
 * the Plugins page matches the browser half by package name too, so a stale
 * copy there is a section that silently never appears rather than an error. The
 * names live in five separate files because five separate resolvers read them;
 * nothing but this spec connects them.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const readRepoFile = (relative: string): string => readFileSync(`${repoRoot}${relative}`, 'utf8')

const packageName: string = manifest.name

describe('published package name', () => {
  it('is a scoped name that matches the repository it claims', () => {
    // `repository` is what ties the listing to this repo; the market refuses an
    // entry whose two halves point at different places.
    expect(packageName.startsWith('@')).toBe(true)
    const repository = manifest.repository as { url?: string } | undefined
    const claimed = repository?.url ?? ''
    expect(claimed).toContain(packageName.split('/')[1])
    expect(claimed).toContain(String(packageName.split('/')[0]?.[1] ?? ''))
  })

  it('names the module the bundle patch inserts', () => {
    const patch = load(readRepoFile('cordis.patch.yml')) as unknown
    expect(Array.isArray(patch)).toBe(true)
    const rows = (patch as { insert?: { id?: string; name?: string }[] }[]).flatMap(entry => entry.insert ?? [])
    expect(rows).toHaveLength(1)
    // The failure this guards is silent: the profile installs, the layer just
    // never applies.
    expect(rows[0]?.name).toBe(packageName)
    // The row id stays deployment-local and is what toggles are written against.
    expect(rows[0]?.id).toBeTruthy()
    expect(rows[0]?.id).not.toBe(packageName)
  })

  it('is the name the host half exports and the manifest declares', () => {
    expect(hostPluginName).toBe(packageName)
    expect(TYPERT.package).toBe(packageName)
  })

  it('is the name the browser half registers under', () => {
    // Read from source rather than the built bundle: the bundle is a build
    // artifact, and this spec must fail when the source drifts, not when
    // someone forgets to rebuild.
    const source = readRepoFile('src/client/index.js')
    expect(source).toContain(`const PACKAGE_NAME = '${packageName}'`)
    expect(source).toContain('exports.name = PACKAGE_NAME')
  })

  it('appears in the install command the README gives', () => {
    expect(readRepoFile('README.md')).toContain(`add ${packageName}`)
  })
})

describe('build output', () => {
  // `lib/` is gitignored and only `pnpm build` creates it, so on a fresh clone
  // — which is what a `github:` install and the registry's CI both do — these
  // have nothing to inspect. They are about the tarball, a publish-time fact,
  // so they run wherever a build has happened and skip where it has not.
  const built = existsInRepo('lib/index.mjs')

  it.skipIf(!built)('ships the type declarations package.json points at', () => {
    // `tsc` writes these and `tsdown`'s clean step used to wipe them, while
    // `package.json` still advertised them — so every `types` entry pointed at
    // a file the tarball did not contain.
    expect(existsInRepo(manifest.types)).toBe(true)
    for (const entry of Object.values(manifest.exports)) {
      const types = (entry as { types?: string } | undefined)?.types
      if (types === undefined) continue
      expect(existsInRepo(types.replace(/^\.\//, ''))).toBe(true)
    }
  })

  it.skipIf(!built)('emits the browser half, which is what the host actually loads', () => {
    expect(existsInRepo('client/client.js')).toBe(true)
  })
})

function existsInRepo(relative: string | undefined): boolean {
  if (relative === undefined) return false
  try {
    readFileSync(`${repoRoot}${relative}`, 'utf8')
    return true
  } catch {
    return false
  }
}
