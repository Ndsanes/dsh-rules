import { defineConfig } from 'tsdown'

/** Modules the Host resolves at runtime rather than bundling. */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
  '@ast-grep/napi',
  'js-yaml',
  'zod',
]

/**
 * The browser half is not built here: its source already carries the module
 * loader's envelope and CommonJS preamble, and `scripts/build-client.mjs` only
 * minifies it.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/typert.host.ts'],
  outDir: 'lib',
  format: ['esm'],
  target: 'node22',
  dts: false,
  clean: true,
  external: HOST_EXTERNALS,
})
