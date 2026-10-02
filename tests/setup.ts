/**
 * Test setup: keep the plugin's own state out of the real harness home.
 *
 * The plugin persists its trigger ledger under `$DSH_HOME`, so pointing that at
 * the user's `~/.dsh` would let a test run write there — and two concurrent
 * runs would race on the same file.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'dsh-rules-test-'))
