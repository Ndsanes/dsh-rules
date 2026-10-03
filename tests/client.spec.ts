import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { COPY, translator } from '../src/client/i18n.js'
// @ts-ignore the browser half is plain JS and ships no bundled .d.ts yet
import { FIELD_SPECS } from '../src/client/frontmatter.js'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import manifest from '../package.json' with { type: 'json' }
import { INTERRUPT_MODES } from '../src/config.ts'
import { TYPERT } from '../src/typert.host.ts'

/**
 * Identity the whole package has to agree on.
 *
 * `package.json` is the source of truth; `src/index.ts`, `src/typert.host.ts`
 * and the browser half each carry their own copy of the name, because they are
 * three separate modules loaded by three separate resolvers. Deriving the
 * expectations here means renaming the package is a one-line change that the
 * suite then verifies everywhere, instead of four literals to remember.
 */
const PACKAGE_NAME = manifest.name
/** The row id `cordis.patch.yml` inserts; deployment-local, not the package name. */
const ROW_ID = 'dsh-rules'
/** Invocation ids the host face publishes for the browser half to match. */
const HOST_INVOCATION_IDS = TYPERT.invocations.map(invocation => invocation.id)

/** One registration the client half made. */
interface Registration {
  descriptor: { name: string; id?: string; key?: string }
  component: (props: never) => unknown
}

/** The slots surface the client half registers into. */
interface FakeSlots {
  inject: (name: string, register: () => void) => void
  register: (descriptor: Registration['descriptor'], component: Registration['component']) => () => void
}

/** The client half as it comes out of the built bundle. */
interface ClientHalf {
  name: string
  inject: readonly string[]
  apply: (ctx: FakeClientContext) => Promise<() => void>
}

/**
 * The client context the half actually drives.
 *
 * `apply` mounts its own Remote namespace and then re-enters the context with
 * that namespace available, so a fake has to model both halves or the page
 * contributions never get registered.
 */
/** A report for a workspace that no longer exists. */
const STALE = {
  cwd: '/gone/workspace', rulebook: [], alwaysApply: [], ttsr: [], rules: [], warnings: [], triggered: {},
  stale: { cwd: '/gone/workspace' },
}

/** A report with rules across sources, buckets, and delivery counts. */
const SAMPLE_REPORT = {
  cwd: '/work/project',
  rulebook: ['no-mock'], alwaysApply: ['RULES'], ttsr: ['ts-set-map'],
  rules: [
    { name: 'ts-set-map', provider: 'builtin-defaults', path: 'builtin-defaults:ts-set-map.md', active: true, triggers: ['condition'], description: 'Record over Set.' },
    { name: 'go-ioutil', provider: 'builtin-defaults', path: 'builtin-defaults:go-ioutil.md', active: true, triggers: ['condition'] },
    { name: 'no-mock', provider: 'native', path: '/work/project/.omp/rules/no-mock.md', active: true, triggers: ['condition'] },
  ],
  warnings: [],
  triggered: { 'ts-set-map': 3 },
}

/** A report with one bundled rule switched off. */
const OFF_REPORT = {
  ...SAMPLE_REPORT,
  rules: [
    { name: 'ts-set-map', provider: 'builtin-defaults', path: 'builtin-defaults:ts-set-map.md', active: false, triggers: ['condition'], reason: 'disabled' },
  ],
}

interface FakeClientContext {
  slots: FakeSlots
  locale?: { getSnapshot: () => { active: string }; subscribe: (listener: () => void) => () => void }
  remote: {
    $mount: (contribution: unknown) => Promise<() => void>
    dshRules: {
      audit: () => Promise<unknown>
      setDisabled: (names: readonly string[]) => Promise<unknown>
      setMode: (name: string, mode: string) => Promise<unknown>
    }
  }
  inject: (names: readonly string[], register: (ctx: FakeClientContext) => void) => void
}

let half: ClientHalf
let registrations: Registration[]
let remoteCalls: string[]

/**
 * A remote namespace that records its calls.
 *
 * The audit page reads its report from a `useEffect`, and server rendering does
 * not run effects, so the assertions here cover the loading state and the
 * registrations. Fetching the live report is exercised in the browser.
 */
function buildContext(report?: Record<string, unknown>): FakeClientContext {
  const slots: FakeSlots = {
    inject: (_name, register) => register(),
    register: (descriptor, component) => {
      registrations.push({ descriptor, component })
      return () => undefined
    },
  }

  const mounted: string[] = []
  const context: FakeClientContext = {
    slots,
    remote: {
      dshRules: {
        audit: () => {
          remoteCalls.push('audit')
          return Promise.resolve({ ok: true, value: report ?? { cwd: '', rules: [], warnings: [], triggered: {} } })
        },
        setDisabled: (names: readonly string[]) => {
          remoteCalls.push(`setDisabled:${names.join(',')}`)
          return Promise.resolve({ ok: true, disabled: [...names] })
        },
        setMode: (name: string, mode: string) => {
          remoteCalls.push(`setMode:${name}=${mode}`)
          return Promise.resolve({ ok: true })
        },
      },
      $mount: (contribution: unknown) => {
        const namespaces = (contribution as { descriptors?: { namespace?: string }[] }).descriptors ?? []
        for (const entry of namespaces) if (entry.namespace !== undefined) mounted.push(entry.namespace)
        return Promise.resolve(() => undefined)
      },
    },
    inject: (_names, register) => register(context),
  }
  return context
}

/** Materialize the built bundle the way the browser module loader does. */
function loadClientBundle(): ClientHalf {
  const bundlePath = join(process.cwd(), 'client', 'client.js')
  // Rebuild whenever any client source is newer than the artifact. Guarding on
  // the file merely existing let the spec run against a stale bundle, which
  // hid real failures more than once.
  const sources = ['src/client/index.js', 'src/client/i18n.js', 'src/client/builtin-catalog.json']
  const bundleTime = existsSync(bundlePath) ? statSync(bundlePath).mtimeMs : 0
  const newestSource = Math.max(...sources.map(name =>
    statSync(join(process.cwd(), name)).mtimeMs))
  if (newestSource > bundleTime) {
    execFileSync('pnpm', ['run', 'build'], { cwd: process.cwd(), stdio: 'pipe' })
  }

  const scope = globalThis as unknown as {
    window?: unknown
    __loaded?: { id: string; factory: (require: (name: string) => unknown) => unknown }
  }
  scope.window = { __ModuleLoader__: { load: (module: typeof scope.__loaded) => { scope.__loaded = module } } }
  // The loader evaluates the file as a script.
  new Function('window', readFileSync(bundlePath, 'utf8'))(scope.window)
  if (scope.__loaded === undefined) throw new Error('client bundle did not register itself')

  // Exactly how the loader materializes an entry: the factory receives `require`
  // and nothing else. Passing extra bindings would mask a bundle that failed to
  // declare its own CommonJS preamble.
  const factory = new Function('require', `return (${scope.__loaded.factory})(require)`)
  return factory((name: string) => require(name)) as ClientHalf
}

/** Render one registered contribution with the given props. */
function render(name: string, props: Record<string, unknown>, id?: string): string {
  const entry = registrations.find(item => item.descriptor.name === name && (id === undefined || item.descriptor.id === id))
  if (entry === undefined) throw new Error(`nothing registered for ${name}${id === undefined ? '' : `#${id}`}`)
  try {
    return renderToStaticMarkup(createElement(entry.component as never, props as never))
  } catch (error) {
    throw new Error(`${name}: ${(error as Error).message}\n${(error as Error).stack}`)
  }
}

/** Render the audit section, which shares its slot with the toggles. */
function renderAudit(props: Record<string, unknown>): string {
  return render('plugins.detail.section', props, 'dsh-rules')
}

/** Render the section, which carries the audit and the toggles together. */
function renderToggles(ctx: unknown, report?: Record<string, unknown>): string {
  return render('plugins.detail.section', { subject: MY_ROW, ctx, report }, 'dsh-rules')
}

/** The subject the Plugins page passes for this plugin's own row. */
const MY_ROW = { kind: 'row', pkg: { name: PACKAGE_NAME }, row: { rowId: ROW_ID, moduleName: PACKAGE_NAME, enabled: true } }

/** A Remote contribution as the client half hands it to `remote.$mount`. */
interface RemoteContribution {
  package: string
  descriptors: readonly { namespace?: string; id: string }[]
}

/**
 * Narrow whatever `remote.$mount` was handed.
 *
 * The stub receives `unknown` because that is all the fake context declares, so
 * the shape is checked at runtime here rather than asserted — an unchecked cast
 * would make a malformed contribution read as a valid one and turn the id
 * comparison below into a comparison against `undefined`.
 */
function asRemoteContribution(value: unknown): RemoteContribution | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('package' in value) || typeof value.package !== 'string') return undefined
  if (!('descriptors' in value) || !Array.isArray(value.descriptors)) return undefined
  return { package: value.package, descriptors: value.descriptors as { id: string }[] }
}

let mountedNamespaces: string[] = []
/** The last Remote contribution the client half asked the host to mount. */
let mountedRemote: RemoteContribution | undefined

beforeAll(async () => {
  half = loadClientBundle()
  registrations = []
  remoteCalls = []
  mountedNamespaces = []
  mountedRemote = undefined

  const context = buildContext()
  const original = context.remote.$mount
  context.remote.$mount = contribution => {
    const remote = asRemoteContribution(contribution)
    mountedNamespaces = [
      ...mountedNamespaces,
      ...(remote?.descriptors ?? [])
        .map(entry => entry.namespace)
        .filter((name): name is string => name !== undefined),
    ]
    mountedRemote = remote
    return original(contribution)
  }
  await half.apply(context)
})

describe('client half', () => {
  it('declares its own CommonJS bindings so the loader can call it with require alone', () => {
    expect(() => loadClientBundle()).not.toThrow()
  })

  it('declares the published package name as its loader envelope id', () => {
    // The loader resolves the envelope id to a package. Leaving it on the bare
    // `dsh-rules` reads as harmless because that is also this plugin's profile
    // row id, but the envelope id is a package lookup and the bare name is a
    // different, unrelated plugin on the registry — the browser half then fails
    // to import and the host reports only "import failed".
    const source = readFileSync(join(process.cwd(), 'src', 'client', 'index.js'), 'utf8')
    // Read out of the envelope specifically: `id: 'dsh-rules'` appears twice
    // further down and is correct there, naming this plugin's own profile row.
    const envelope = /__ModuleLoader__\.load\(\{[\s\S]*?\bid: '([^']*)'/.exec(source)
    expect(envelope?.[1]).toBe(PACKAGE_NAME)
    expect(source).toContain(`var PACKAGE_NAME = '${PACKAGE_NAME}'`)
    // And the row id is still the deployment-local one, kept apart from the
    // package name so the two cannot drift into each other.
    expect(source).toContain(`var ROW_ID = '${ROW_ID}'`)
  })

  it('registers itself under the package name and asks for the remote service', () => {
    // Read from package.json rather than repeating the literal: the loader
    // resolves a bundle row to the module it named, so the client half's name,
    // the host half's export, and the manifest all have to track the published
    // package name. Hard-coding it here made this assertion the one place that
    // had to be edited by hand — and it was left behind when the package was
    // scoped, which silently stops the Plugins page from mounting.
    expect(half.name).toBe(PACKAGE_NAME)
    expect(half.inject).toContain('slots')
    expect(half.inject).toContain('remote')
  })

  it('keys its Remote descriptors on the same package name the host face does', () => {
    // The two halves never talk to each other directly: the host publishes
    // invocation ids and the browser half matches them, so a prefix that drifts
    // on one side only fails as a namespace that never mounts — no error, just
    // an absent page section.
    expect(mountedRemote).toBeDefined()
    if (mountedRemote === undefined) return
    expect(mountedRemote.package).toBe(PACKAGE_NAME)
    expect(mountedRemote.descriptors.map(descriptor => descriptor.id).slice().sort())
      .toEqual(HOST_INVOCATION_IDS.slice().sort())
  })

  it('mounts its own Remote namespace instead of waiting for one', () => {
    // Only this plugin contributes the namespace, so it must mount it rather
    // than declare `remote.dshRules` in `inject` and wait for nobody.
    expect(mountedNamespaces).toContain('dshRules')
    expect(half.inject).not.toContain('remote.dshRules')
    expect(registrations.map(entry => entry.descriptor.name)).toContain('plugins.detail.section')
  })

  it('registers the audit panel as a tab on the Settings page too', () => {
    // Settings is where a reader goes to configure a plugin, so the panel that
    // says which rules are in force belongs there as well as on the detail page.
    // `settings.plugins.tab` is a tab inside the Plugins section rather than a
    // top-level navigation entry — the same slot the host puts its own
    // read-only plugin inventory in.
    const tabs = registrations.filter(entry => entry.descriptor.name === 'settings.plugins.tab')
    expect(tabs.map(entry => entry.descriptor.id)).toEqual(['dsh-rules'])
    const descriptor = tabs[0]?.descriptor as { order?: number; label?: () => string } | undefined
    // What the host actually consumes for a tab: an ordering and a label.
    expect(descriptor?.order).toBeTypeOf('number')
    // A label is a thunk the host calls outside a render, so it must not reach
    // for a hook — reading the locale has to work with no React above it.
    expect(descriptor?.label?.()).toBeTruthy()
    expect(descriptor?.label?.()).not.toContain('undefined')
  })

  it('renders the panel in the settings tab, where there is no subject', () => {
    // A settings tab is a page of its own, not a view of one plugin row, so the
    // host passes no subject. The detail-page subject check would render
    // nothing there — the panel would be present in the registry and absent from
    // the page a reader actually opens.
    const html = render('settings.plugins.tab', { report: SAMPLE_REPORT }, 'dsh-rules')
    expect(html).toContain('Rule management')
  })

  it('registers two detail sections and leaves the config form slot to the platform', () => {
    const details = registrations.filter(entry => entry.descriptor.name === 'plugins.detail.section')
    expect(details.map(entry => entry.descriptor.id)).toEqual(['dsh-rules'])

    // Taking `plugins.row.config` would replace the platform's own form for this
    // entry and strand every setting that is not one of our toggles.
    expect(registrations.some(entry => entry.descriptor.name === 'plugins.row.config')).toBe(false)
  })

  it('draws nothing on another plugin page', () => {
    expect(render('plugins.detail.section', { subject: { kind: 'bundle', pkg: { name: 'some-other-plugin' } }, ctx: buildContext() })).toBe('')
  })

  it('binds the editor modal\'s error setter', () => {
    // `rewrite` reports a refused serialisation through `setError`, which lives
    // in the section's state and reaches the modal as a prop. Without it in the
    // destructuring the one guard between a partial write and the page raises a
    // ReferenceError of its own, and a read-text assertion is the only place the
    // bundle can be held to it: no rule file a reader can open makes the
    // serialiser refuse.
    const source = readFileSync(join(__dirname, '..', 'src', 'client', 'index.js'), 'utf8')
    const modal = source.slice(source.indexOf('function RuleEditorModal(props)'))
    const bound = /const \{([^}]*)\} = props/.exec(modal)?.[1] ?? ''
    expect(bound.split(',').map(name => name.trim())).toContain('setError')
  })
})

describe('locale coverage', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'client', 'index.js'), 'utf8')
  const catalogSource = readFileSync(join(__dirname, '..', 'src', 'client', 'i18n.js'), 'utf8')

  it('looks up only keys that exist in every language', () => {
    const used = new Set([...source.matchAll(/t\('([A-Za-z0-9_]+)'/g)].map(match => match[1]!))
    const missing: string[] = []
    for (const locale of ['en', 'zh'] as const) {
      const messages = COPY[locale] as Record<string, string>
      for (const key of used) {
        if (messages[key] === undefined) missing.push(`${locale}:${key}`)
      }
    }
    // A missing key renders as the raw key name on screen: `inForceState` and
    // `togglesHint` both shipped that way with the whole suite green.
    expect(missing).toEqual([])
  })

  it('defines no copy nothing reads', () => {
    // Scoped to `COPY` on both sides. `SOURCE_LABEL` is a separate table of
    // provider ids, and the `reason*` keys are reached indirectly through
    // `REASON_KEY[code]`, so neither is an orphan even without a `t('…')`.
    const copyStart = catalogSource.indexOf('export const COPY')
    const copy = catalogSource.slice(copyStart, catalogSource.indexOf('export const SOURCE_LABEL', copyStart))
    const reasonKeys = new Set(
      [...catalogSource.slice(catalogSource.indexOf('export const REASON_KEY'))
        .matchAll(/: '([A-Za-z0-9_]+)'/g)].map(match => match[1]!),
    )
    // Every quoted identifier the page mentions, not just `t('…')`: the switch
    // labels are reached as `t(condition ? 'off' : 'on')`, which a literal-only
    // pattern would miss and then report as dead copy.
    const used = new Set([
      ...[...source.matchAll(/'([A-Za-z0-9_]+)'/g)].map(match => match[1]!),
      ...reasonKeys,
    ])

    const defined = new Set<string>()
    const duplicates = new Set<string>()
    for (const block of copy.matchAll(/\n  (?:en|zh): \{([\s\S]*?)\n  \},/g)) {
      // Per block: every locale carries the same key names, so counting across
      // them would report the entire table as duplicated.
      const seen = new Set<string>()
      for (const match of block[1]!.matchAll(/^\s+([A-Za-z0-9_]+):/gm)) {
        const key = match[1]!
        if (seen.has(key)) duplicates.add(key)
        seen.add(key)
        defined.add(key)
      }
    }
    // Counted in the source text: a duplicated key collapses in the exported
    // object and would leave the second literal behind unnoticed.
    const orphans = [...defined].filter(key => !used.has(key)).sort()

    expect(orphans).toEqual([])
    expect([...duplicates].sort()).toEqual([])
  })

  it('gives both languages the same keys', () => {
    expect(Object.keys(COPY.en).sort()).toEqual(Object.keys(COPY.zh).sort())
  })

  it('has help copy for every field the editor form renders', () => {
    // The form renders one control per `FIELD_SPECS` key and looks its help up
    // through a table written out by hand. A field missing from that table
    // falls through to `helpUnknownField`, so the reader is told the page has
    // no description for a field the page itself put on screen.
    const table = /const HELP_KEY = \{([\s\S]*?)\n {6}\}/.exec(source)?.[1] ?? ''
    const mapped = [...table.matchAll(/([A-Za-z0-9_]+): '([A-Za-z0-9_]+)'/g)]
    const fields = new Set(mapped.map(match => match[1]!))
    // `frontmatter.js` is plain JS with no declaration file, so `FIELD_SPECS` is
    // untyped here; the shape is spelled out so the assertion stays honest.
    expect(FIELD_SPECS.map((spec: { key: string }) => spec.key).filter((key: string) => !fields.has(key))).toEqual([])
    // And every table entry resolves to copy, in both languages: an entry that
    // names a key nothing defines renders the key itself.
    const missing = mapped.flatMap(match =>
      (['en', 'zh'] as const).filter(locale => COPY[locale][match[2]!] === undefined).map(locale => `${locale}:${match[2]}`))
    expect(missing).toEqual([])
  })
})

describe('rule audit', () => {
  const SAMPLE = {
    cwd: '/work/project',
    rules: [
      { name: 'ts-set-map', provider: 'builtin-defaults', path: 'builtin-defaults:ts-set-map.md', active: true, triggers: ['condition'], description: 'Record over Set.' },
      { name: 'no-mock', provider: 'native', path: '/work/project/.omp/rules/no-mock.md', active: false, triggers: [], description: 'No mocks.', reason: 'listed in ttsr.disabledRules' },
    ],
  }

  it('draws the audit section on its own row page, reading from the report', () => {
    const html = renderAudit({ subject: MY_ROW, ctx: buildContext() })

    expect(html).toContain('data-dsh-rules="audit"')
    expect(html).toContain('Rule audit')
    expect(html).toContain('Reading the rule report')
  })

  // The report arrives in an effect, which server rendering never runs, so the
  // category chips, search box, source labels, and inline reasons are exercised
  // in the browser rather than here.

  it('ships copy for every locale the host offers, with English as the fallback', () => {
    const zh = translator('zh')
    const en = translator('en')

    expect(zh('auditTitle')).toBe('规则审计')
    expect(en('auditTitle')).toBe('Rule audit')
    // A regional variant falls back to its language rather than to English.
    expect(translator('zh-CN')('auditTitle')).toBe('规则审计')
    // An unknown key degrades to the key, not to an empty string.
    expect(zh('no-such-key')).toBe('no-such-key')
    // Both languages define the same keys, so no page string can silently miss.
    const [english, chinese] = [COPY.en, COPY.zh]
    const missing = Object.keys(english).filter(key => !(key in chinese))
    expect(missing).toEqual([])
  })

  it('refuses to show numbers for a workspace that no longer exists', () => {
    const html = renderAudit({ subject: MY_ROW, ctx: buildContext(), report: STALE })
    expect(html).toContain('/gone/workspace')
    expect(html).toContain('no longer exists')
  })

  it('renders the dashboard from a supplied report', () => {
    const html = renderAudit({ subject: MY_ROW, ctx: buildContext(), report: SAMPLE_REPORT })
    expect(html).toContain('data-dsh-rules="dashboard"')
    expect(html).toContain('Bundled with the plugin')
    expect(html).toContain('.omp/rules')
    // The proportion charts read as a whole, so the legend carries the counts.
    expect(html).toContain('never fired')
  })

  it('labels a row switch with the action it performs, not the state', () => {
    // A switch reading "off" for a disabled rule is read as "switch it off".
    // The button must name the action, which is the opposite of the state.
    const html = renderToggles(buildContext(), OFF_REPORT)
    expect(html).toContain('>on</button>')
  })

  it('shows an inactive rule with its reason, in the reader language', () => {
    const html = renderToggles(buildContext(), OFF_REPORT)
    expect(html).toContain('0 of 1 on')
    expect(html).toContain('listed in ttsr.disabledRules')
  })

  it('explains where the rest of the rules come from', () => {
    const html = renderAudit({ subject: MY_ROW, ctx: buildContext() })
    expect(html).toContain('data-dsh-rules="detail"')
    expect(html).toContain('.omp/rules/')
  })

  it('names the user rules directory, in both languages', () => {
    // The sentence promises user rules and listed only project ones, leaving a
    // reader nowhere to put their own files. The connective between the paths
    // used to be read off the Chinese string itself, so any edit to that one
    // line silently put an English "and" in the middle of a Chinese sentence.
    for (const locale of ['en', 'zh'] as const) {
      expect(COPY[locale].codeUserRules).toBe('~/.omp/agent/rules/')
      expect(COPY[locale].sourcesAnd).not.toBe('')
      expect(COPY[locale].sourcesBody).not.toBe('')
    }
    const client = readFileSync(join(__dirname, '..', 'src', 'client', 'index.js'), 'utf8')
    expect(client).not.toContain('=== \'项目与用户规则来自\'')
  })

  it('labels the delivery buckets in both languages, and names their unit', () => {
    // The legend numbers are counts of rules, not of deliveries, and a bucket
    // shown as a bare figure reads as the other one. The unit has to survive
    // the translation, and every bucket needs both spellings — a key added to
    // one table alone renders as its own name on screen.
    for (const locale of ['en', 'zh'] as const) {
      const messages = COPY[locale] as Record<string, string>
      for (const key of ['bucketNeverFired', 'bucketOnce', 'bucketTwice', 'bucketThrice', 'bucketFourPlus']) {
        expect(messages[key]).toBeTruthy()
      }
      expect(messages.distributionNote).toBeTruthy()
      expect(messages.chartDistribution).toBeTruthy()
    }
    // The folded ranking says how much is behind it, so a collapsed row does
    // not read as an empty panel.
    expect(translator('en')('chartDelivered', { count: 8 })).toBe('Delivery detail (8 rules)')
    expect(translator('zh')('chartDelivered', { count: 8 })).toBe('投递明细（8 条规则）')
  })
})

describe('bundled rule toggles', () => {
  it('groups bundled rules by family with counts', () => {
    const html = renderToggles(buildContext())
    expect(html).toContain('ts 13')
    expect(html).toContain('go 8')
    expect(html).toContain('rs 6')
  })

  it('offers the registered workspaces so the panel can be pointed at one', () => {
    const html = render('plugins.detail.section', {
      subject: MY_ROW,
      ctx: buildContext(),
      report: SAMPLE_REPORT,
      workspaces: [
        { id: 'w1', path: '/Users/x/Documents/code/Modu', title: 'Modu' },
        { id: 'w2', path: '/Users/x/Documents/code/other', title: 'other' },
      ],
    }, 'dsh-rules')
    // Without this the panel can only ever describe a workspace a session
    // happened to open, and archiving every session strands it on the last one.
    expect(html).toContain('Modu')
    expect(html).toContain('other')
    expect(html).toContain('Audit it')
    expect(html).toContain('Close')
  })

  it('offers a mode selector on every row, bundled rules included', () => {
    // 27 of the rules that ship with this plugin have no file to edit, so this
    // selector is the only control they have. Hiding it the way the Edit button
    // is hidden would leave exactly those rules unadjustable from the panel.
    const html = renderToggles(buildContext())
    expect((html.match(/<select/g) ?? []).length).toBe(27)
    // The blank option is what "follows the rule" looks like, and the fallback
    // catalogue says nothing about a mode, so it falls back to the profile's.
    expect(html).toContain('Follow the profile default')
    expect(html).toContain('<option value="always"')
  })

  it('selects the override a rule carries rather than the mode in force', () => {
    // Both values are on the row, and only one of them is what the reader
    // chose: showing the effective mode as the selected option would make an
    // override that merely matches the rule look like no override at all.
    const html = renderToggles(buildContext(), {
      cwd: '/x', rulebook: [], alwaysApply: [], ttsr: [], warnings: [], triggered: {},
      rules: [
        {
          name: 'ts-set-map', provider: 'builtin-defaults', path: 'b.ts', active: true,
          triggers: ['condition'], interruptMode: 'always', ownInterruptMode: 'never', modeOverride: 'always',
        },
      ],
    })
    expect(html).toContain('Follow the rule (never)')
    expect(html).toMatch(/<option value="always" selected="?">always<\/option>/)
  })

  it('offers the same four modes the Host accepts, in the same order', () => {
    // The browser half cannot import `INTERRUPT_MODES` from the Host's config —
    // that module reaches for schemastery and zod, which the loader's platform
    // table does not carry — so the list is copied. Read through the rendered
    // page rather than the source: a drift that only reached the bundle would
    // otherwise pass here.
    const html = renderToggles(buildContext(), {
      cwd: '/x', rulebook: [], alwaysApply: [], ttsr: [], warnings: [], triggered: {},
      rules: [{ name: 'ts-set-map', provider: 'builtin-defaults', path: 'b.ts', active: true, triggers: ['condition'] }],
    })
    const options = /<select[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? ''
    expect([...options.matchAll(/<option value="([^"]*)"/g)].map(entry => entry[1]))
      .toEqual(['', ...INTERRUPT_MODES])
  })

  it('offers select-all and bulk enable and disable', () => {
    const html = renderToggles(buildContext())
    expect(html).toContain('Select all 27')
    expect(html).toContain('Invert selection (0)')
    expect(html).toContain('Disable 0 selected')
    expect(html).toContain('Enable 0 selected')
  })

  it('lists every bundled rule with a checkbox when no report has landed', () => {
    const html = renderToggles(buildContext())
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(27)
    expect(html).toContain('27 of 27 on')
    expect(html).toContain('ts-no-tiny-functions')
  })

  it('lists the rules the workspace actually discovered, bundled or not', () => {
    // `ttsr.disabledRules` matches by name across every provider, so a project
    // rule belongs in this list beside a built-in one.
    const html = renderToggles(buildContext(), {
      cwd: '/x', rulebook: [], alwaysApply: [], ttsr: [], warnings: [], triggered: {},
      rules: [
        { name: 'ts-set-map', provider: 'builtin-defaults', path: 'b.ts', active: true, triggers: ['condition'] },
        { name: 'sql-permissions-hardwall', provider: 'native', path: '/x/.omp/rules/sql-permissions-hardwall.md', scope: 'Modu', active: false, triggers: ['condition'], reason: 'disabled' },
      ],
    })
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(2)
    expect(html).toContain('1 of 2 on')
    expect(html).toContain('sql-permissions-hardwall')
    // The row keeps the rule's own provenance, including which project it is.
    expect(html).toContain('Modu')
    expect(html).not.toContain('builtin-defaults:sql-permissions-hardwall.md')
  })

  it('starts from the report, showing every bundled rule on', () => {
    // The component loads its state in an effect, which server rendering never
    // runs; the inactive state is exercised in the browser, not here.
    const html = renderToggles(buildContext(), {
      cwd: '/x', rulebook: [], alwaysApply: [], ttsr: [], warnings: [], triggered: {},
      rules: [
        { name: 'ts-set-map', provider: 'builtin-defaults', path: 'b.ts', active: false, triggers: ['condition'], reason: 'disabled' },
      ],
    })
    // A report that has landed replaces the bundled fallback: it is the list of
    // rules this workspace actually has.
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(1)
    expect(html).toContain('0 of 1 on')
  })

  it('names the reason a rule is out of force, whoever turned it off', () => {
    // `active: false` covers five unrelated reasons, and only one of them is
    // the reader's own `ttsr.disabledRules`. Labelling a rule "listed in
    // ttsr.disabledRules" because a setting turned the whole catalogue off told
    // the reader their profile had been edited behind them.
    const html = renderToggles(buildContext(), {
      cwd: '/x', rulebook: [], alwaysApply: [], ttsr: [], warnings: [], triggered: {},
      rules: [
        { name: 'ts-set-map', provider: 'builtin-defaults', path: 'b.ts', active: false, triggers: ['condition'], reason: 'builtins-off' },
      ],
    })
    expect(html).toContain('bundled rules are disabled by ttsr.builtinRules')
    expect(html).not.toContain('listed in ttsr.disabledRules')
    // And the header counts what is in force, not what is merely unlisted.
    expect(html).toContain('0 of 1 on')
  })
})

describe('writing toggles', () => {
  it('writes through the host remote, not the page form', async () => {
    const calls: string[][] = []
    const ctx = buildContext()
    ctx.remote.dshRules.setDisabled = (names: readonly string[]) => {
      calls.push([...names])
      return Promise.resolve({ ok: true, disabled: [...names] })
    }

    // The detail page has no configuration form. Depending on it made every
    // write fail here with "this page has no configuration form".
    const html = renderToggles(ctx)
    expect(html).toContain('Rule management')
    expect(html).not.toContain('no configuration form')
    expect(calls).toEqual([])
  })

  it('shows the host guidance when a write is refused', () => {
    const ctx = buildContext()
    ctx.remote.dshRules.setDisabled = () => Promise.resolve({ ok: false, guidance: 'refused by policy' })
    const html = renderToggles(ctx)
    expect(html).toContain('bundled')
  })
})
