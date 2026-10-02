/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as React from 'react'
// @ts-ignore the browser half is plain JS and ships no bundled .d.ts yet
import * as frontmatter from '../src/client/frontmatter.js'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

import manifest from '../package.json' with { type: 'json' }

/**
 * Drive the shipped browser half through a real DOM.
 *
 * Everything the client half owns only exists in the browser: the section is
 * mounted into dsh's own slot system and every rule change crosses the gateway,
 * whose envelope the Host's unit tests never see. A test that called the Host
 * service directly passed while a refusal was silently discarded in the browser,
 * so the view is rendered here instead.
 */

interface ToggleResult {
  ok: boolean
  guidance?: string
  disabled?: string[]
}

declare global {
  // React reads this off the global, and the module loader is a dsh-only shape.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
  interface Window { __ModuleLoader__?: { load: (module: never) => void } }
}

// React only runs effects through act() when it is told this is a test renderer.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * Hand the factory a `require` of our own, backed by the very bindings this
 * spec imported.
 *
 * Letting the factory reach for `require('react')` gives it the CJS build while
 * the spec holds the ESM wrapper: two module objects, so `act()` reports
 * `Cannot read properties of null (reading 'useMemo')` even though the browser
 * has exactly one React. Wiring the identifiers by hand removes the duplicate by
 * construction instead of configuring around it.
 */
function bundleRequire(id: string): unknown {
  if (id === 'react') return React
  if (id === 'react-dom/client') return { createRoot }
  throw new Error(`the client bundle must not require ${id}`)
}

/** Name the hook the patched call site resolves through the prototype chain. */
const REFUSAL_HOOK = '__dshRefuseSerialise'

/**
 * Make the editor's own serialise call refuse, and only that call.
 *
 * `rewrite` catches a refusal from `serialiseRuleFile` on purpose: a partial
 * write is the failure that module exists to prevent. Nothing a reader can type
 * produces one, though — every form control hands the serialiser a value of the
 * declared type, and the modal's own gate has already proved the unedited block
 * round-trips byte for byte — so the guard is unreachable from the bundle as
 * shipped. Testing it therefore means making the serialiser refuse.
 *
 * `frontmatter.js` is inlined into the artifact by `scripts/build-client.mjs`,
 * and inlined twice: the gate at render time, and the write inside `rewrite`.
 * The anchor below is the write's call site, which the gate's own call cannot
 * match, so the gate keeps working and only a rewrite fails. A build that
 * reshapes the artifact fails this test loudly rather than testing nothing.
 *
 * The hook hangs off `Object.prototype`, so the rewritten call keeps the shape
 * it had — `(() => { … })().serialiseRuleFile(…)` becomes
 * `(() => { … })().__dshRefuseSerialise(…)`, same arity, same parentheses — and
 * finds the hook by ordinary property lookup. Non-enumerable, so nothing in the
 * page sees it in a `for…in`, and `releaseRefusingSerialiser` takes it back off.
 */
function withRefusingSerialiser(source: string, message: string): string {
  const site = /\}\)\(\)\.serialiseRuleFile\(/g
  const found = source.match(site) ?? []
  if (found.length !== 1) {
    throw new Error(`the client bundle has ${found.length} rewrite call sites; this test patches exactly one`)
  }
  Object.defineProperty(Object.prototype, REFUSAL_HOOK, {
    value: () => { throw new TypeError(message) },
    configurable: true,
  })
  return source.replace(site, `}).${REFUSAL_HOOK}(`)
}

/** Take the refusal hook back off the prototype. */
function releaseRefusingSerialiser(): void {
  Reflect.deleteProperty(Object.prototype, REFUSAL_HOOK)
}

/** Materialise the built bundle the way dsh's loader does. */
async function loadBundle(refusal?: string): Promise<{ apply: (ctx: unknown) => Promise<() => Promise<void>> }> {
  let source = await readFile(join(process.cwd(), 'client', 'client.js'), 'utf8')
  if (refusal !== undefined) source = withRefusingSerialiser(source, refusal)
  let captured: { factory: (require: typeof bundleRequire) => { apply: (ctx: unknown) => Promise<() => Promise<void>> } } | undefined
  // The official client template registers itself on `window.__ModuleLoader__`
  // and hands the loader a factory that takes `require` and returns the module.
  const scope = globalThis.window as Window
  scope.__ModuleLoader__ = { load: ((module: typeof captured) => { captured = module }) as (module: never) => void }
  new Function(source)()
  if (captured === undefined) throw new Error('the client bundle never registered itself')
  return captured.factory(bundleRequire)
}

interface AuditRule {
  name: string
  description?: string
  provider: string
  path: string
  scope?: string
  triggers?: string[]
  interruptMode?: string
  active: boolean
  reason?: string
}

const RULES: AuditRule[] = [
  { name: 'ts-set-map', description: 'Prefer Set/Map', provider: 'builtin-defaults', path: 'builtin-defaults:ts-set-map.md', triggers: ['condition'], interruptMode: 'never', active: true },
  { name: 'go-ioutil', description: 'Prefer io and os', provider: 'builtin-defaults', path: 'builtin-defaults:go-ioutil.md', triggers: ['condition'], interruptMode: 'never', active: true },
]

/** A stand-in for the report the audit service returns. */
function report(disabled: string[] = [], cwd = '/tmp/fixture', rules: AuditRule[] = RULES) {
  return {
    cwd,
    rulebook: [],
    alwaysApply: [],
    ttsr: rules.map(rule => rule.name),
    triggered: {} as Record<string, number>,
    rules: rules.map(rule => ({
      ...rule,
      active: disabled.includes(rule.name) ? false : rule.active,
      reason: disabled.includes(rule.name) ? 'disabled' : rule.reason,
    })),
  }
}

/** Mount the section and hand back the element plus the calls it made. */
async function render(options: {
  disabled?: string[]
  cwd?: string
  reply: (names: string[]) => ToggleResult | Promise<ToggleResult>
  throwSync?: Error
  hang?: boolean
  workspaces?: { id: string; path: string; title: string }[]
  /** Replace the report's rules, so a row can be a project rule or carry a scope. */
  rules?: AuditRule[]
  /** What `readRule` resolves to; the editor shows exactly this file. */
  file?: { name: string; path: string; content: string; editable: boolean }
  /** What `writeRule` resolves to. A refusal carries the Host's guidance. */
  writeReply?: ToggleResult | Promise<ToggleResult>
  /** Make the editor's serialise call refuse with this message. */
  serialiseRefusal?: string
}): Promise<{
  html: () => string
  calls: string[][]
  container: HTMLElement
  opened: () => string[]
  closes: () => number
  /** One entry per `writeRule` call, in the order the page made them. */
  writes: () => string[][]
  dispose: () => void
}> {
  const bundle = await loadBundle(options.serialiseRefusal)
  const calls: string[][] = []
  const writes: string[][] = []
  const opened: string[] = []
  let closed = 0

  // The gateway wraps every result as `{ok, value}`; the value is what the Host
  // method returned. Mirroring that here is the point of the whole spec.
  const remote = {
    $mount: async () => async () => {},
    dshRules: {
      audit: async () => ({ ok: true, value: report(options.disabled ?? [], options.cwd ?? '/tmp/fixture', options.rules) }),
      listWorkspaces: async () => ({ ok: true, value: options.workspaces ?? [] }),
      // The Host refuses with guidance rather than rejecting, so the file
      // arrives inside its own `{ok: true, file}` payload — not bare.
      readRule: async (name: string) => ({
        ok: true,
        value: { ok: true, file: options.file ?? { name, path: '', content: '', editable: false } },
      }),
      writeRule: (name: string, content: string) => {
        writes.push([name, content])
        return Promise.resolve(options.writeReply ?? { ok: true, disabled: [] }).then(value => ({ ok: true, value }))
      },
      openWorkspace: async (path: string) => {
        opened.push(path)
        return { ok: true, value: { ok: true, disabled: [] } }
      },
      closeWorkspace: async () => { closed += 1; return { ok: true, value: undefined } },
      setDisabled: (names: string[]) => {
        calls.push(names)
        // Deliberately not `async`: the gateway validates arguments before it
        // opens a request, so a real Remote can throw synchronously, and an
        // `async` double could never reproduce that.
        if (options.throwSync !== undefined) throw options.throwSync
        // A dropped connection leaves the Remote retrying: the promise stays
        // pending forever, so nothing rejects and the caller waits for nothing.
        if (options.hang === true) return new Promise(() => {})
        return Promise.resolve(options.reply(names)).then(value => ({ ok: true, value }))
      },
    },
  }

  let section: ((props: Record<string, unknown>) => unknown) | undefined
  // dsh exposes `locale` as a store, not a string: the section subscribes to it
  // through `useSyncExternalStore`, so a bare value has no `subscribe` to bind.
  let snapshot = 'en'
  const listeners = new Set<() => void>()
  const locale = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
    set: (next: string) => { snapshot = next; for (const listener of listeners) listener() },
  }
  const ctx = {
    remote,
    locale,
    slots: {
      inject: (_name: string, register: () => void) => { register() },
      register: (_descriptor: unknown, renderSection: (props: Record<string, unknown>) => unknown) => { section = renderSection },
    },
    inject: async (_names: string[], run: (root: unknown) => void) => { run(ctx) },
  }

  await bundle.apply(ctx)
  if (section === undefined) throw new Error('the bundle never registered its section')

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(section as never, {
      subject: { kind: 'row', row: { moduleName: manifest.name, rowId: 'dsh-rules' } },
    })) })

  return {
    html: () => container.innerHTML,
    calls,
    opened: () => opened,
    closes: () => closed,
    writes: () => writes,
    // Every assertion scopes to this container. A failing test never reaches
    // `dispose`, so a later one querying the document would find this run's
    // container or an earlier run's stale tree instead of its own.
    container,
    dispose: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** Wait for the effect-driven audit call to settle. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) })
}

/**
 * The tightest element wrapping one named rule and a control.
 *
 * Rows are picked by rule name rather than by position: the page renders several
 * lists side by side, so "the first switch" is whichever list happened to sort
 * first and says nothing about the rule under test.
 */
function rowFor(container: ParentNode, name: string): HTMLElement {
  const candidates = [...container.querySelectorAll<HTMLElement>('*')]
    .filter(node => node.textContent?.includes(name) && node.querySelector('button, input') !== null)
  const row = candidates.reduce<HTMLElement | undefined>((best, node) => {
    if (best === undefined) return node
    return node.querySelectorAll('*').length < best.querySelectorAll('*').length ? node : best
  }, undefined)
  if (row === undefined) throw new Error(`no row for ${name} in: ${container.textContent?.slice(0, 200)}`)
  return row
}

/** The switch inside a rule's row. */
function switchIn(container: ParentNode, name: string): HTMLButtonElement {
  const button = [...rowFor(container, name).querySelectorAll('button')]
    .find(candidate => ['on', 'off'].includes(candidate.textContent?.trim() ?? ''))
  if (button === undefined) throw new Error(`no switch in the row for ${name}`)
  return button
}

/** The toggle list itself: the only place rows, chips and the editor live. */
function togglesIn(container: ParentNode): HTMLElement {
  const section = container.querySelector('[data-dsh-rules="bundled"]')
  if (section === null) throw new Error('the toggle list is not on the page')
  return section as HTMLElement
}

/**
 * The Edit button in one rule's row, or `undefined` when the row has none.
 *
 * Asked for as an option rather than thrown on, because "this row offers no
 * way to edit" is one of the behaviours under test and the throw would report
 * it as a missing element instead of as an absence.
 */
function editIn(container: ParentNode, name: string): HTMLButtonElement | undefined {
  return [...rowFor(container, name).querySelectorAll('button')]
    .find(candidate => candidate.textContent?.trim() === 'Edit')
}

/** A button in `container` by its exact visible label, or `undefined`. */
function buttonIn(container: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')]
    .find(candidate => candidate.textContent?.trim() === label)
}

/**
 * A `writeRule` reply the test releases by hand.
 *
 * The Host's write crosses the gateway, so between the click and the reply the
 * page is genuinely mid-save. A reply that resolves on the microtask queue
 * collapses that window and every claim about "while the write is in flight"
 * becomes untestable; parking the promise and releasing it on cue keeps it open.
 */
function gatedWrite(): { reply: Promise<ToggleResult>; release: (value: ToggleResult) => void } {
  let release!: (value: ToggleResult) => void
  const reply = new Promise<ToggleResult>(resolve => { release = resolve })
  return { reply, release }
}

/** Whether a rule's row is rendered at all, i.e. the filters kept it. */
function hasRow(container: ParentNode, name: string): boolean {
  return [...container.querySelectorAll('*')]
    .some(node => node.textContent?.includes(name) && node.querySelector('button, input') !== null)
}

/** One filter chip in the toggle list's toolbar, by its visible label (`ts 2`, `Modu 1`). */
function chipIn(container: ParentNode, label: string): HTMLElement {
  // Only the toolbar carries chips, and only the toggle list carries a toolbar.
  const chips = [...togglesIn(container).querySelectorAll('span')]
  const chip = chips.find(candidate => candidate.textContent?.trim() === label)
  if (chip === undefined) {
    throw new Error(`no chip reading ${label} among: ${chips.map(entry => entry.textContent?.trim()).join(' | ')}`)
  }
  return chip
}

/** Replace a controlled control's text the way a typist would. */
async function typeIn(control: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    // React tracks a controlled value through its own setter, so assigning
    // `.value` directly is swallowed; the native setter is what makes the
    // change event carry a value React believes.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')?.set
    setter?.call(control, text)
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * One field of the editor's form, by the name the form prints above it.
 *
 * Asked for by the printed name rather than by position: the form carries every
 * field the rule format has, so "the third textarea" is whichever field happens
 * to come third and says nothing about the one under test. Returned whole —
 * control, help line and label — because every claim about a field is about the
 * three together.
 */
function fieldIn(
  editor: HTMLElement,
  name: string,
): { control: HTMLInputElement | HTMLTextAreaElement; help: string; label: HTMLElement } {
  const labels = [...editor.querySelectorAll('label')]
  const label = labels.find(node => node.querySelector('span')?.textContent === name)
  if (label === undefined) {
    throw new Error(`the editor has no field named ${name} among: ${labels.map(node => node.querySelector('span')?.textContent).join(' | ')}`)
  }
  const control = label.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  if (control === null) throw new Error(`the field named ${name} carries no control`)
  return { control, help: label.querySelectorAll('span')[1]?.textContent?.trim() ?? '', label }
}

/** Switch the editor between its form and the whole-file textarea. */
async function modeIn(editor: HTMLElement, label: string): Promise<void> {
  const button = buttonIn(editor, label)
  if (button === undefined) throw new Error(`the editor offers no "${label}" control`)
  await act(async () => { button.click() })
}

describe('the rule section in a browser', () => {
  it('renders the report the audit call returned', async () => {
    const view = await render({ reply: () => ({ ok: true }) })
    await settle()

    const audit = view.container.querySelector('[data-dsh-rules="audit"]') as HTMLElement
    // The report has no `ok` of its own, so a read that judges the unwrapped
    // value on `ok` rejects every success and leaves this panel empty.
    expect(audit.textContent).not.toContain('could not be read')
    expect(audit.textContent).toContain('0deliveries here')
    // The audit states no rule counts: the toggle list below already gives the
    // exact number in both directions, and a second copy only invites the two
    // to disagree.
    expect(audit.textContent).not.toContain('2rules found')
    expect(audit.textContent).not.toContain('2in force')
    expect(audit.textContent).not.toContain('0switched off')
    // The inventory itself lives in the toggle list; the audit must not repeat
    // it, or the two copies drift apart.
    expect(audit.textContent).not.toContain('ts-set-map')
    expect(audit.textContent).not.toContain('go-ioutil')
    // Scoped to the whole render, not the audit panel: the badge only renders in
    // the toggle list, so an assertion anchored to the audit panel is vacuously
    // true and guards nothing.
    expect(view.container.textContent).toContain('in force')
    expect(view.container.textContent).not.toContain('inForceState')
    view.dispose()
  })

  it('labels a switch with the action it performs, not the current state', async () => {
    const view = await render({ reply: () => ({ ok: true }) })
    await settle()

    // No rule is disabled, so every switch must offer to turn one off.
    expect(view.html()).toContain('>off</button>')
    expect(view.html()).not.toContain('>on</button>')
    view.dispose()
  })

  it('sends the new disabled set when a row switch is clicked', async () => {
    const view = await render({ reply: () => ({ ok: true, disabled: ['ts-set-map'] }) })
    await settle()

    const button = switchIn(view.container, 'ts-set-map')

    await act(async () => { button.click() })
    await settle()

    expect(view.calls).toEqual([['ts-set-map']])
    view.dispose()
  })

  it('shows the host refusal instead of taking the success path', async () => {
    // The gateway wraps every result as `{ok: true, value}`, so the outer `ok`
    // is always true. Reading it discarded this guidance and left the section
    // looking untouched, which is what "the button does nothing" meant.
    const view = await render({
      reply: () => ({ ok: false, guidance: 'no settings service on this deployment' }),
    })
    await settle()

    const button = switchIn(view.container, 'ts-set-map')
    await act(async () => { button.click() })
    await settle()

    expect(view.html()).toContain('no settings service on this deployment')
    view.dispose()
  })

  it('shows a transport failure rather than swallowing it', async () => {
    const view = await render({
      reply: () => { throw new Error('gateway/input-invalid') },
    })
    await settle()

    const button = switchIn(view.container, 'ts-set-map')
    await act(async () => { button.click() })
    await settle()

    expect(view.html()).toContain('gateway/input-invalid')
    view.dispose()
  })

  it('reports a synchronous throw and leaves the switches usable', async () => {
    // The Remote can throw before it returns a promise. If `apply` does not
    // catch that, the `.finally` never runs, `busy` latches true, and every
    // switch stays disabled from then on — silently.
    const view = await render({ reply: () => ({ ok: true }), throwSync: new Error('gateway/input-invalid') })
    await settle()

    const button = switchIn(view.container, 'ts-set-map')
    await act(async () => { button.click() })
    await settle()

    expect(view.html()).toContain('gateway/input-invalid')
    expect(button.disabled).toBe(false)
    view.dispose()
  })

  it('gives up on a write that never settles and leaves the switches usable', async () => {
    const view = await render({ reply: () => ({ ok: true }), hang: true })
    await settle()

    // Faked only around the wait: `settle` drives React's own effects with real
    // timers, and switching them out underneath it hangs the mount.
    vi.useFakeTimers()
    try {
      const button = switchIn(view.container, 'ts-set-map')
      await act(async () => { button.click() })
      expect(button.disabled).toBe(true)

      await act(async () => { await vi.advanceTimersByTimeAsync(21000) })

      // Nothing rejects and nothing resolves, so without a bound `busy` would
      // stay true and every control would stay dead with an empty panel.
      expect(button.disabled).toBe(false)
      expect(view.html()).toContain('did not answer in time')
      view.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('audits the workspace the page is pointed at', async () => {
    // Without this the panel can only describe a workspace a session happened
    // to open, so archiving every session strands it on the last one.
    const view = await render({
      reply: () => ({ ok: true }),
      workspaces: [
        { id: 'w1', path: '/code/Modu', title: 'Modu' },
        { id: 'w2', path: '/code/other', title: 'other' },
      ],
    })
    await settle()

    const audit = view.container.querySelector('[data-dsh-rules="audit"]') as HTMLElement
    const select = audit.querySelector('select') as HTMLSelectElement
    expect(select).not.toBeNull()
    // Two projects, both using `.omp/rules` upstream: the titles have to be
    // distinguishable or the reader cannot tell which is which.
    expect([...select.options].map(option => option.textContent)).toEqual(['Choose a workspace', 'Modu', 'other'])

    await act(async () => {
      select.value = '/code/Modu'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const open = [...audit.querySelectorAll('button')].find(b => b.textContent === 'Audit it') as HTMLButtonElement
    await act(async () => { open.click() })
    await settle()

    expect(view.opened()).toEqual(['/code/Modu'])
    view.dispose()
  })

  it('closes the workspace and returns the panel to its empty state', async () => {
    const view = await render({
      reply: () => ({ ok: true }),
      workspaces: [{ id: 'w1', path: '/code/Modu', title: 'Modu' }],
      disabled: [],
    })
    await settle()

    const audit = view.container.querySelector('[data-dsh-rules="audit"]') as HTMLElement
    const close = [...audit.querySelectorAll('button')].find(b => b.textContent === 'Close') as HTMLButtonElement
    await act(async () => { close.click() })
    await settle()

    // The Close button is its own action, not an open with an empty path.
    expect(view.closes()).toBe(1)
    expect(view.opened()).toEqual([])
    view.dispose()
  })

  it('accepts a typed path when the profile has no workspaces', async () => {
    // A profile with nothing registered would otherwise offer no way in at all,
    // and the page's only other source for a cwd was a session.
    const view = await render({ reply: () => ({ ok: true }), workspaces: [] })
    await settle()

    const audit = view.container.querySelector('[data-dsh-rules="audit"]') as HTMLElement
    const input = audit.querySelector('input[type="text"]') as HTMLInputElement
    expect(input).not.toBeNull()
    const open = [...audit.querySelectorAll('button')].find(b => b.textContent === 'Audit it') as HTMLButtonElement
    expect(open.disabled).toBe(true)

    // React tracks a controlled input's value through its own setter, so
    // assigning `.value` directly is swallowed; the native setter is what makes
    // the change event carry a value React believes.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '/code/Modu')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const enabled = [...audit.querySelectorAll('button')].find(b => b.textContent === 'Audit it') as HTMLButtonElement
    expect(enabled.disabled).toBe(false)
    await act(async () => { enabled.click() })
    await settle()

    expect(view.opened()).toEqual(['/code/Modu'])
    view.dispose()
  })

  it('says there is no workspace rather than blaming the filter', async () => {
    const view = await render({ reply: () => ({ ok: true }), cwd: '' })
    await settle()

    const audit = view.container.querySelector('[data-dsh-rules="audit"]') as HTMLElement
    // An empty report because nothing is open is a different state from an
    // empty filter; saying "no rules match" hid the way out.
    expect(audit.textContent).toContain('No workspace is open')
    expect(audit.textContent).not.toContain('no rules match the current filter')
    view.dispose()
  })

  it('applies the checked set in one call from the bulk action', async () => {
    const view = await render({ disabled: ['ts-set-map'], reply: () => ({ ok: true }) })
    await settle()

    const container = view.container
    const target = rowFor(container, 'go-ioutil').querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(target).not.toBeNull()
    await act(async () => { target!.click() })
    await settle()

    const apply = [...container.querySelectorAll('button')]
      .find(candidate => /selected/i.test(candidate.textContent ?? '')) as HTMLButtonElement | undefined
    expect(apply).toBeDefined()
    await act(async () => { apply!.click() })
    await settle()

    expect(view.calls).toEqual([['go-ioutil', 'ts-set-map']])
    view.dispose()
  })

  it('writes back only the rules the reader switched off', async () => {
    // `ttsr.builtinRules: false` puts every bundled rule out of force for a
    // reason that has nothing to do with `ttsr.disabledRules`. The bulk buttons
    // replace that list wholesale, so treating "out of force" as "disabled"
    // filed 26 rules the reader never touched under a reason that reads as
    // their own doing — permanently, once the config came back on.
    const off: AuditRule[] = [
      { name: 'ts-set-map', description: 'Prefer Set/Map', provider: 'builtin-defaults', path: 'builtin-defaults:ts-set-map.md', triggers: ['condition'], interruptMode: 'never', active: false, reason: 'builtins-off' },
      { name: 'go-ioutil', description: 'Prefer io and os', provider: 'builtin-defaults', path: 'builtin-defaults:go-ioutil.md', triggers: ['condition'], interruptMode: 'never', active: false, reason: 'shadowed' },
    ]
    const view = await render({ reply: () => ({ ok: true }), rules: off })
    await settle()

    // Each row names its own reason. Reading every one of them as "listed in
    // ttsr.disabledRules" told the reader their settings had been edited.
    const row = rowFor(view.container, 'ts-set-map')
    expect(row.textContent).toContain('bundled rules are disabled by ttsr.builtinRules')
    expect(row.textContent).not.toContain('listed in ttsr.disabledRules')
    // And the header counts what is in force, not what is merely unlisted.
    expect(togglesIn(view.container).textContent).toContain('0 of 2 on')

    const target = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(target).not.toBeNull()
    await act(async () => { target!.click() })
    await settle()

    const enable = buttonIn(togglesIn(view.container), 'Enable 1 selected')
    expect(enable).toBeDefined()
    await act(async () => { enable!.click() })
    await settle()

    // The write is a full replacement, so it has to carry exactly what the
    // reader's list holds: here, nothing at all.
    expect(view.calls).toEqual([[]])
    view.dispose()
  })
})

describe('editing one rule in the browser', () => {
  /** A project rule the page is allowed to edit, with a workspace of its own. */
  const PROJECT_RULES: AuditRule[] = [
    { name: 'documentation', description: 'How the docs read', provider: 'native', path: '/code/Modu/.omp/rules/documentation.md', scope: '/code/Modu', triggers: ['condition'], interruptMode: 'never', active: true },
  ]

  const FILE = {
    name: 'documentation',
    path: '/x/Modu/.omp/rules/documentation.md',
    content: '---\ndescription: d\n---\n\nBody\n',
    editable: true,
  }

  /**
   * The same rule with the frontmatter a real rule file carries: text, and lists.
   *
   * Spelled the way the serialiser writes it, because the editor only offers
   * the form for a file it can reproduce byte for byte — a fixture with looser
   * quoting would be refused before a single field was on screen, and the test
   * would pass for the wrong reason.
   */
  const RICH_FILE = {
    ...FILE,
    content: '---\ndescription: How the docs read\ncondition:\n  - ts\n  - source\nscope:\n  - "tool:edit(*.go)"\n---\n\nBody\n',
  }

  /**
   * A rule whose frontmatter the parser genuinely cannot represent: a nested
   * mapping under a *known* field. An unknown key is not one of these — those
   * are preserved verbatim and the form still opens, which is the whole point.
   */
  const ODD_FILE = {
    ...FILE,
    content: '---\ndescription: d\nscope:\n  tool: edit\n---\n\nBody\n',
  }

  it('opens the editor on the exact file the Host read', async () => {
    const view = await render({ reply: () => ({ ok: true }), rules: PROJECT_RULES, file: FILE })
    await settle()

    const edit = editIn(view.container, 'documentation')
    expect(edit).toBeDefined()
    await act(async () => { edit!.click() })
    await settle()

    // The path is shown because a save overwrites this file: the reader has to
    // see which one before anything is written to it.
    const editor = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement | null
    expect(editor).not.toBeNull()
    expect(editor!.textContent).toContain('/x/Modu/.omp/rules/documentation.md')
    // The form edits the body, not the file: the frontmatter is the rule's
    // metadata and has controls of its own above, so the body textarea must not
    // quietly carry it too — that is the tell of a form that rewrites the file
    // as one blob.
    expect((fieldIn(editor!, 'body').control as HTMLTextAreaElement).value).toBe('\nBody\n')
    // Raw mode is the escape hatch, and it is one click away: the whole file,
    // front to back, is still exactly the one the Host read. A reader who wants
    // the file rather than the form can always have it, without pasting the
    // frontmatter back in by hand.
    await modeIn(editor!, 'Raw file')
    expect((editor!.querySelector('textarea') as HTMLTextAreaElement).value).toBe(FILE.content)
    view.dispose()
  })

  it('saves the edited text back under the rule it opened', async () => {
    const view = await render({ reply: () => ({ ok: true }), rules: PROJECT_RULES, file: FILE })
    await settle()

    await act(async () => { editIn(view.container, 'documentation')!.click() })
    await settle()
    const editor = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement
    // The body is what a reader changes; the form re-emits the frontmatter
    // around it, so what crosses the gateway is still a whole rule file.
    await typeIn(fieldIn(editor, 'body').control as HTMLTextAreaElement, 'Edited body\n')

    const save = [...editor.querySelectorAll('button')]
      .find(candidate => candidate.textContent?.trim() === 'Save') as HTMLButtonElement
    await act(async () => { save.click() })
    await settle()

    // Both arguments, in order: the name decides the file, so a write that sent
    // only the text would land somewhere else or nowhere.
    expect(view.writes()).toEqual([['documentation', '---\ndescription: d\n---\nEdited body\n']])
    view.dispose()
  })

  it('offers Edit only on rules that came from a project', async () => {
    const view = await render({
      reply: () => ({ ok: true }),
      rules: [
        { name: 'ts-set-map', description: 'Prefer Set/Map', provider: 'builtin-defaults', path: 'builtin-defaults:ts-set-map.md', triggers: ['condition'], interruptMode: 'never', active: true },
        { name: 'documentation', description: 'How the docs read', provider: 'native', path: '/code/Modu/.omp/rules/documentation.md', scope: '/code/Modu', triggers: ['condition'], interruptMode: 'never', active: true },
      ],
    })
    await settle()

    // A bundled rule has no file of its own to overwrite, so offering Edit
    // invites the reader to try and then fail.
    expect(editIn(view.container, 'ts-set-map')).toBeUndefined()
    expect(editIn(view.container, 'documentation')).toBeDefined()
    // And with no way in, no editor: the modal is opened only from a row that
    // owns a file, so nothing else on the page can leave one open behind it.
    expect(view.container.querySelector('[data-dsh-rules="editor"]')).toBeNull()
    view.dispose()
  })

  it('keeps the editor open and shows the guidance when a save is refused', async () => {
    const view = await render({
      reply: () => ({ ok: true }),
      rules: PROJECT_RULES,
      file: FILE,
      writeReply: { ok: false, guidance: 'that file is read-only on this profile' },
    })
    await settle()

    await act(async () => { editIn(view.container, 'documentation')!.click() })
    await settle()
    const editor = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement
    await typeIn(fieldIn(editor, 'body').control as HTMLTextAreaElement, 'Edited body\n')
    const save = [...editor.querySelectorAll('button')]
      .find(candidate => candidate.textContent?.trim() === 'Save') as HTMLButtonElement
    await act(async () => { save.click() })
    await settle()

    // A refusal only means something if there was a save to refuse.
    expect(view.writes()).toHaveLength(1)
    // Closing the editor on a refusal would read as "saved" and throw the
    // editor's only copy of the text away.
    expect(view.container.textContent).toContain('that file is read-only on this profile')
    expect(togglesIn(view.container).querySelector('[data-dsh-rules="editor"]')).not.toBeNull()
    view.dispose()
  })

  it('keeps the editor, the draft and the page when a rewrite is refused', async () => {
    // The refusal the serialiser throws on purpose. `rewrite` catches it and
    // reports it through the section's `setError` — a binding this module only
    // has if it destructures it, so the guard used to raise a ReferenceError of
    // its own and take the page with it.
    try {
      const view = await render({
        reply: () => ({ ok: true }),
        rules: PROJECT_RULES,
        file: FILE,
        serialiseRefusal: 'serialiseRuleFile: refused by the fixture',
      })
      await settle()

      await act(async () => { editIn(view.container, 'documentation')!.click() })
      await settle()
      const editor = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement
      await typeIn(fieldIn(editor, 'body').control as HTMLTextAreaElement, 'A body nobody can save.\n')

      // Said out loud, in the dialog it happened in, rather than swallowed.
      expect(editor.textContent).toContain('serialiseRuleFile: refused by the fixture')
      // The dialog is still the dialog: a refusal is not a save, and closing the
      // editor would throw away the only copy of the text.
      expect(editor.querySelector('[role="dialog"]')).not.toBeNull()
      expect(buttonIn(editor, 'Save')).toBeDefined()
      // The draft is the last text the editor accepted, so the reader's unsaved
      // work is one edit old rather than gone.
      expect((fieldIn(editor, 'body').control as HTMLTextAreaElement).value).toBe('\nBody\n')
      // And the page behind it never blanked: the rule row, the toggles and the
      // audit are all still on screen.
      // Asserted on the section rather than through `switchIn`: the editor is a
      // modal rendered inside that same section and carries this rule's name in
      // its own field, so a name lookup would resolve to the modal rather than
      // to the row. The switches are found by their label, which the modal's
      // own buttons never use.
      const bundled = view.container.querySelector('[data-dsh-rules="bundled"]') as HTMLElement
      expect(bundled.textContent).toContain('Rule management')
      expect(bundled.textContent).toContain('documentation')
      expect([...bundled.querySelectorAll('button')]
        .filter(button => ['on', 'off'].includes(button.textContent?.trim() ?? ''))
        .length).toBeGreaterThan(0)
      expect(view.container.querySelector('[data-dsh-rules="audit"]')).not.toBeNull()
      // Nothing reached the gateway: a refused rewrite is not a save.
      expect(view.writes()).toEqual([])
      view.dispose()
    } finally {
      releaseRefusingSerialiser()
    }
  })

  it('opens the editor as a modal over the page, not as a panel under the list', async () => {
    const view = await render({ reply: () => ({ ok: true }), rules: PROJECT_RULES, file: FILE })
    await settle()

    await act(async () => { editIn(view.container, 'documentation')!.click() })
    await settle()

    // The backdrop is what the page positions; the dialog role is on the panel
    // it holds, which is the element assistive technology is told about.
    const editor = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement
    const dialog = editor.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    // Pinned to the viewport, so it cannot come to rest below the rows: that
    // was the complaint, with 46 rules and the editor thousands of pixels down.
    expect(editor.style.position).toBe('fixed')

    // The rows live in one list element, and the editor is neither inside it
    // nor around it. Sharing the section with them is fine — sharing the list
    // is what put the editor at the bottom of it.
    const row = rowFor(view.container, 'documentation')
    const list = row.parentElement as HTMLElement
    expect(list.contains(row)).toBe(true)
    expect(list.querySelectorAll('button').length).toBeGreaterThan(0)
    expect(list.contains(editor)).toBe(false)
    expect(editor.contains(list)).toBe(false)
    view.dispose()
  })

  it('shows one labelled control per frontmatter field, each with its help', async () => {
    const view = await render({ reply: () => ({ ok: true }), rules: PROJECT_RULES, file: RICH_FILE })
    await settle()

    await act(async () => { editIn(view.container, 'documentation')!.click() })
    await settle()
    const editor = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement

    // One control per field, holding the value the file gave it. Asserting the
    // field name appears somewhere would pass for a form that printed the names
    // and lost the rule's own settings on the way in.
    const description = fieldIn(editor, 'description')
    const condition = fieldIn(editor, 'condition')
    const scope = fieldIn(editor, 'scope')
    expect((description.control as HTMLInputElement).value).toBe('How the docs read')
    // A list field stays a list: one line per entry, so a pattern carrying a
    // comma cannot be split in half by the serialiser.
    expect(condition.control.tagName).toBe('TEXTAREA')
    expect((condition.control as HTMLTextAreaElement).value).toBe('ts\nsource')
    expect((scope.control as HTMLTextAreaElement).value).toBe('tool:edit(*.go)')

    // Every field carries its own explanation: `condition` and `scope` mean
    // nothing to a reader who has not read the rule format, and explaining them
    // is the whole reason the form exists instead of the file.
    const helps = new Map<string, string>([
      ['description', description.help],
      ['condition', condition.help],
      ['scope', scope.help],
    ])
    expect(new Set(helps.values()).size).toBe(3)
    expect(description.help).toContain('Shown wherever the rule is listed')
    for (const [name, help] of helps) {
      expect(help).not.toBe('')
      // The help is prose about the field, not the field's name again: a label
      // repeated in the help slot says nothing and looks like it says something.
      expect(help).not.toBe(name)
    }
    // And the body is a field of the same kind, with its own help.
    expect(fieldIn(editor, 'body').help).not.toBe('')
    view.dispose()
  })

  it('explains the old trigger spellings instead of shrugging at them', async () => {
    // `ttsr-trigger` is read as the `ttsrTrigger` field, and both legacy
    // spellings reach the form. Their help was missing from the page's own
    // table, so the one field a reader most needs explained rendered the raw
    // key on screen.
    const legacy = {
      ...FILE,
      content: '---\ndescription: How the docs read\nttsr-trigger: source\n---\n\nBody\n',
    }
    const view = await render({ reply: () => ({ ok: true }), rules: PROJECT_RULES, file: legacy })
    await settle()

    await act(async () => { editIn(view.container, 'documentation')!.click() })
    await settle()
    const editor = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement

    const help = fieldIn(editor, 'ttsrTrigger').help
    expect(help).not.toBe('helpUnknownField')
    // Prose about the field, in both halves: what it does and what to write
    // instead.
    expect(help).toContain('Triggers')
    expect(help).toContain('condition')
    // The other spelling shares the explanation rather than losing it.
    expect(fieldIn(editor, 'ttsr_trigger').help).toBe(help)
    view.dispose()
  })

  it('opens a hand-written rule in form mode and saves it back byte-identically', async () => {
    // The real bundled rule, verbatim: hand-written quoting, a comma-joined
    // scope, fields the form knows. Form mode used to be unreachable for every
    // file like this one, because saving would have renormalised the quoting —
    // which is why the editor looked broken. Untouched content must come back
    // byte-identically, unknown keys included.
    const original = readFileSync(join(__dirname, '..', 'src', 'builtin-rules', 'go-ioutil.md'), 'utf8')
    const withUnknown = original.replace(
      /^description:/m,
      'backing: some-tool-only-key\ndescription:',
    )
    const view = await render({
      reply: () => ({ ok: true }),
      rules: [{
        name: 'go-ioutil', description: 'Use io and os', provider: 'native',
        path: '/x/.omp/rules/go-ioutil.md', scope: '/x', triggers: ['condition'],
        interruptMode: 'never', active: true,
      }],
      file: { name: 'go-ioutil', path: '/x/.omp/rules/go-ioutil.md', content: withUnknown, editable: true },
    })
    await settle()

    const edit = editIn(togglesIn(view.container), 'go-ioutil')
    edit?.click()
    await settle()

    const editor = view.container.querySelector('[data-dsh-rules="editor"]') as HTMLElement
    // The form is offered, not a raw-only fallback.
    const formControl = [...editor.querySelectorAll('button')].find(b => b.textContent === 'Form')
    expect(formControl).toBeDefined()
    expect(editor.textContent).not.toContain('raw mode')

    // A field is rendered from the file, not blank.
    const field = fieldIn(editor, 'description')
    expect(field.control).toBeDefined()

    // Saving without touching anything rewrites nothing.
    buttonIn(editor, 'Save')?.click()
    await settle()
    expect(view.writes()).toEqual([['go-ioutil', withUnknown]])
    view.dispose()
  })

  it('shows the whole file, frontmatter included, in raw mode', async () => {
    const view = await render({ reply: () => ({ ok: true }), rules: PROJECT_RULES, file: RICH_FILE })
    await settle()

    await act(async () => { editIn(view.container, 'documentation')!.click() })
    await settle()
    const editor = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement

    // Both modes are on offer, so the form is a choice rather than a wall.
    expect(buttonIn(editor, 'Form')).toBeDefined()
    expect(buttonIn(editor, 'Raw file')).toBeDefined()
    await modeIn(editor, 'Raw file')

    // Front to back, byte for byte: anyone pasting a whole rule in — or handing
    // the file to another model — has to get the frontmatter too.
    const area = editor.querySelector('textarea') as HTMLTextAreaElement
    expect(area.value).toBe(RICH_FILE.content)
    expect(area.value).toContain('description: How the docs read')
    expect(area.value.startsWith('---\n')).toBe(true)
    // And the form's per-field controls are gone, so raw really is the other
    // mode rather than the same thing drawn twice.
    expect(editor.querySelectorAll('label')).toHaveLength(0)
    view.dispose()
  })

  it('writes a whole well-formed file back when the form is saved', async () => {
    // The regression that matters: a form that wrote only what it had fields for
    // would save the rule as prose and drop its triggers, and nothing on the
    // page would say so — the save would report success.
    const view = await render({ reply: () => ({ ok: true }), rules: PROJECT_RULES, file: RICH_FILE })
    await settle()

    await act(async () => { editIn(view.container, 'documentation')!.click() })
    await settle()
    const editor = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement
    await typeIn(fieldIn(editor, 'description').control as HTMLInputElement, 'How the docs should read')
    await typeIn(fieldIn(editor, 'body').control as HTMLTextAreaElement, 'Edited body\n')
    await act(async () => { buttonIn(editor, 'Save')!.click() })
    await settle()

    expect(view.writes()).toHaveLength(1)
    const entry = view.writes()[0]
    expect(entry).toBeDefined()
    const [name, content] = entry as [string, string]
    expect(name).toBe('documentation')
    // A file, not a fragment: the frontmatter block is still around the body.
    expect(content.startsWith('---\n')).toBe(true)
    expect(content).toContain('description: How the docs should read')
    expect(content).toContain('Edited body')
    // The fields the reader did not touch came back too.
    expect(content).toContain('condition:')
    expect(content).toContain('  - ts\n')
    expect(content).toContain('scope:')
    // And it reads back as the rule it started as. Parsing the written text is
    // the assertion a string check cannot make: it is the difference between a
    // file that still is a rule and a file that merely opens with `---`.
    const round = frontmatter.parseRuleFile(content)
    expect(round.ok).toBe(true)
    expect(round.ok && round.body).toBe('Edited body\n')
    expect(round.ok && round.fields.description).toBe('How the docs should read')
    expect(round.ok && round.fields.condition).toEqual(['ts', 'source'])
    expect(round.ok && round.fields.scope).toEqual(['tool:edit(*.go)'])
    view.dispose()
  })

  it('keeps a rule the parser refuses in raw mode and says why', async () => {
    const view = await render({ reply: () => ({ ok: true }), rules: PROJECT_RULES, file: ODD_FILE })
    await settle()

    await act(async () => { editIn(view.container, 'documentation')!.click() })
    await settle()
    const editor = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement

    // The field it could not read is named, not swallowed: `severity` is a
    // perfectly good rule file, and a reader who sees this sentence knows the
    // problem is the editor's, not their rule's.
    expect(editor.textContent).toContain('scope')
    // No form is offered, because saving through one would write the file back
    // without the field the form could not represent — a silent deletion.
    expect(buttonIn(editor, 'Form')).toBeUndefined()
    expect(editor.querySelectorAll('label')).toHaveLength(0)
    // The file is still here in full and still editable as text: a rule the form
    // cannot model is not a rule the reader cannot edit.
    expect((editor.querySelector('textarea') as HTMLTextAreaElement).value).toBe(ODD_FILE.content)
    view.dispose()
  })

  it('lets a save that is still in flight leave a later editor alone', async () => {
    // A write crosses the gateway, so the page spends real time between the
    // click and the reply. Anything the reader does in that window is their
    // own work, and the reply belongs to the save that started it.
    const gate = gatedWrite()
    const alpha = '---\ndescription: a\n---\n\nAlpha body\n'
    const beta = '---\ndescription: b\n---\n\nBeta body\n'
    const view = await render({
      reply: () => ({ ok: true }),
      rules: [
        { name: 'ts-alpha', description: 'Alpha', provider: 'native', path: '/code/Modu/.omp/rules/ts-alpha.md', scope: '/code/Modu', triggers: ['condition'], active: true },
        { name: 'ts-beta', description: 'Beta', provider: 'native', path: '/code/other/.omp/rules/ts-beta.md', scope: '/code/other', triggers: ['condition'], active: true },
      ],
      file: FILE,
      writeReply: gate.reply,
    })
    await settle()

    await act(async () => { editIn(view.container, 'ts-alpha')!.click() })
    await settle()
    const editorOfAlpha = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement
    expect(editorOfAlpha.textContent).toContain('Editing ts-alpha')
    // Raw mode, because these two drafts are whole files: a draft has to be
    // byte-identical to what the reader typed for "the reply threw it away" to
    // be a claim about the page rather than about the serialiser.
    await modeIn(editorOfAlpha, 'Raw file')
    await typeIn(editorOfAlpha.querySelector('textarea') as HTMLTextAreaElement, alpha)

    // Save, and do not settle: the write is now out and the reply is held.
    await act(async () => { buttonIn(editorOfAlpha, 'Save')!.click() })
    expect(view.writes()).toEqual([['ts-alpha', alpha]])

    // A second rule is opened while the first save is unanswered.
    await act(async () => { editIn(view.container, 'ts-beta')!.click() })
    await settle()
    const editorOfBeta = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement
    expect(editorOfBeta.textContent).toContain('Editing ts-beta')
    await modeIn(editorOfBeta, 'Raw file')
    await typeIn(editorOfBeta.querySelector('textarea') as HTMLTextAreaElement, beta)

    // Only now does the Host answer the first save.
    await act(async () => { gate.release({ ok: true }) })
    await settle()

    // Closing on the reply, or re-reading whatever editor is current, would
    // throw away an unrelated draft and claim a success nobody asked for.
    const editor = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement | null
    expect(editor).not.toBeNull()
    expect(editor!.textContent).toContain('Editing ts-beta')
    expect((editor!.querySelector('textarea') as HTMLTextAreaElement).value).toBe(beta)
    // The confirmation names the rule that was written, not the one that
    // happened to be open when the reply landed.
    expect(view.container.textContent).toContain('Saved ts-alpha.')
    expect(view.container.textContent).not.toContain('Saved ts-beta.')
    view.dispose()
  })

  it('holds Cancel disabled for as long as the write is out', async () => {
    // Cancelling mid-write would read as an abort while the file is still
    // overwritten behind the reader's back; a Cancel that never comes back
    // strands them in an editor they cannot leave.
    const gate = gatedWrite()
    const view = await render({ reply: () => ({ ok: true }), rules: PROJECT_RULES, file: FILE, writeReply: gate.reply })
    await settle()

    await act(async () => { editIn(view.container, 'documentation')!.click() })
    await settle()
    const editor = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement
    await typeIn(fieldIn(editor, 'body').control as HTMLTextAreaElement, 'Edited body\n')
    await act(async () => { buttonIn(editor, 'Save')!.click() })

    // The write is parked, so the control is held.
    expect(buttonIn(togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement, 'Cancel')!.disabled).toBe(true)

    // A refusal is the reply that leaves the editor on screen, which is what
    // makes "enabled again" observable at all.
    await act(async () => { gate.release({ ok: false, guidance: 'that file is read-only on this profile' }) })
    await settle()

    const after = togglesIn(view.container).querySelector('[data-dsh-rules="editor"]') as HTMLElement | null
    expect(after).not.toBeNull()
    expect(buttonIn(after!, 'Cancel')!.disabled).toBe(false)
    view.dispose()
  })

  it('narrows by prefix and by workspace at the same time', async () => {
    const view = await render({
      reply: () => ({ ok: true }),
      rules: [
        { name: 'ts-alpha', provider: 'native', path: '/code/Modu/.omp/rules/ts-alpha.md', scope: '/code/Modu', triggers: ['condition'], active: true },
        { name: 'ts-beta', provider: 'native', path: '/code/other/.omp/rules/ts-beta.md', scope: '/code/other', triggers: ['condition'], active: true },
        { name: 'ts-gamma', provider: 'native', path: '/code/Modu/.omp/rules/ts-gamma.md', scope: '/code/Modu', triggers: ['condition'], active: true },
        { name: 'go-delta', provider: 'native', path: '/code/Modu/.omp/rules/go-delta.md', scope: '/code/Modu', triggers: ['condition'], active: true },
      ],
    })
    await settle()

    await act(async () => { chipIn(view.container, 'ts 3').click() })
    await settle()
    expect(togglesIn(view.container).querySelectorAll('input[type="checkbox"]').length).toBe(3)

    await act(async () => { chipIn(view.container, '/code/Modu 3').click() })
    await settle()

    // Neither filter alone gets here: `ts` keeps three rows and `/code/Modu`
    // keeps three, so only the intersection is left. A workspace chip that reset
    // the prefix would instead have shown all three Modu rows.
    const toggles = togglesIn(view.container)
    expect(toggles.querySelectorAll('input[type="checkbox"]').length).toBe(2)
    expect(hasRow(toggles, 'ts-alpha')).toBe(true)
    expect(hasRow(toggles, 'ts-gamma')).toBe(true)
    expect(hasRow(toggles, 'ts-beta')).toBe(false)
    expect(hasRow(toggles, 'go-delta')).toBe(false)
    view.dispose()
  })

  it('names the section the way the renamed copy does', async () => {
    const view = await render({ reply: () => ({ ok: true }) })
    await settle()

    const title = togglesIn(view.container).querySelector('h3') as HTMLElement | null
    expect(title?.textContent).toBe('Rule management')
    view.dispose()
  })
})

  it('labels the scopeless buckets distinctly instead of both reading "all"', async () => {
    // The bundled rules carry no scope, and so do the user-directory rules.
    // Collapsing them onto the all-workspaces word gave two different buckets
    // one label, and the row read "All 46 | All 27 | Modu 19".
    const view = await render({
      reply: () => ({ ok: true }),
      rules: [
        { name: 'ts-alpha', provider: 'builtin-defaults', path: 'b:ts-alpha.md', active: true, triggers: ['condition'] },
        { name: 'user-rule', provider: 'native', path: '~/.omp/agent/rules/user-rule.md', active: true, triggers: ['condition'] },
        { name: 'proj-rule', provider: 'native', path: '/code/Modu/.omp/rules/proj-rule.md', scope: 'Modu', active: true, triggers: ['condition'] },
      ],
    })
    await settle()

    // Scoped to the workspace row: the prefix row above it has its own "All",
    // and asserting across both would count that one too.
    const row = [...togglesIn(view.container).children]
      .find(node => node.textContent?.includes('Workspace')) as HTMLElement
    expect(row).toBeDefined()
    const labels = [...row.querySelectorAll('span')].map(node => node.textContent?.trim() ?? '')

    expect(labels).toContain('Bundled with the plugin 1')
    expect(labels).toContain('User directory 1')
    expect(labels).toContain('Modu 1')
    expect(labels.filter(text => text === 'All 3')).toHaveLength(1)
    view.dispose()
  })

  it('keeps the two filters in separate rows rather than one', async () => {
    const view = await render({
      reply: () => ({ ok: true }),
      rules: [
        { name: 'ts-alpha', provider: 'builtin-defaults', path: 'b:ts-alpha.md', active: true, triggers: ['condition'] },
        { name: 'proj-rule', provider: 'native', path: '/x/.omp/rules/proj-rule.md', scope: 'Modu', active: true, triggers: ['condition'] },
      ],
    })
    await settle()

    // Find each filter by what only it contains, then assert the two live in
    // different parents. Two filters answering two different questions on one
    // line made the row unreadable.
    const owning = (needle: string): Element | undefined => {
      let found: Element | undefined
      for (const node of togglesIn(view.container).querySelectorAll('span')) {
        if ((node.textContent ?? '').trim() === needle) { found = node.parentElement ?? undefined; break }
      }
      return found
    }
    const prefixRow = owning('ts 1')
    const workspaceRow = owning('Workspace')
    expect(prefixRow).toBeDefined()
    expect(workspaceRow).toBeDefined()
    expect(prefixRow).not.toBe(workspaceRow)
    expect(prefixRow?.textContent).not.toContain('Workspace')
    view.dispose()
  })
describe('filtering the rules in the browser', () => {
  /** Two rules whose families and workspaces do not overlap. */
  const SPLIT_RULES: AuditRule[] = [
    { name: 'ts-alpha', description: 'Alpha', provider: 'native', path: '/code/Modu/.omp/rules/ts-alpha.md', scope: '/code/Modu', triggers: ['condition'], active: true },
    { name: 'go-delta', description: 'Delta', provider: 'native', path: '/code/other/.omp/rules/go-delta.md', scope: '/code/other', triggers: ['condition'], active: true },
  ]

  it('says so when the two filters together match nothing', async () => {
    const view = await render({ reply: () => ({ ok: true }), rules: SPLIT_RULES })
    await settle()

    await act(async () => { chipIn(view.container, 'ts 1').click() })
    await settle()
    // One chip on its own always leaves a row behind, so the empty panel below
    // can only be the pair of them.
    expect(hasRow(togglesIn(view.container), 'ts-alpha')).toBe(true)

    await act(async () => { chipIn(view.container, '/code/other 1').click() })
    await settle()

    const toggles = togglesIn(view.container)
    expect(hasRow(toggles, 'ts-alpha')).toBe(false)
    expect(hasRow(toggles, 'go-delta')).toBe(false)
    expect(toggles.querySelectorAll('input[type="checkbox"]').length).toBe(0)
    // Rows that are not on screen and no sentence saying why is the one state
    // a reader cannot tell apart from a hung audit.
    expect(toggles.textContent).toContain('No rule matched this filter.')
    view.dispose()
  })

  it('drops a workspace selection the new rows no longer carry', async () => {
    // The same array the fake report maps over, so rewriting a rule in place is
    // the next audit: the page asked again and the answer changed.
    const rules: AuditRule[] = [
      { name: 'ts-alpha', description: 'Alpha', provider: 'native', path: '/code/Modu/.omp/rules/ts-alpha.md', scope: '/code/Modu', triggers: ['condition'], active: true },
      { name: 'ts-beta', description: 'Beta', provider: 'native', path: '/code/Modu/.omp/rules/ts-beta.md', scope: '/code/Modu', triggers: ['condition'], active: true },
    ]
    const view = await render({ reply: () => ({ ok: true }), rules })
    await settle()

    await act(async () => { chipIn(view.container, '/code/Modu 2').click() })
    await settle()
    expect(togglesIn(view.container).querySelectorAll('input[type="checkbox"]').length).toBe(2)

    for (const rule of rules) rule.scope = '/code/other'
    // A write re-audits, which is the refresh path a reader meets when the
    // workspace behind the page changes under them.
    const selectAll = [...togglesIn(view.container).querySelectorAll('button')]
      .find(candidate => candidate.textContent === 'Select all 2') as HTMLButtonElement
    expect(selectAll).toBeDefined()
    await act(async () => { selectAll.click() })
    await settle()
    const disable = [...togglesIn(view.container).querySelectorAll('button')]
      .find(candidate => candidate.textContent === 'Disable 2 selected') as HTMLButtonElement
    expect(disable).toBeDefined()
    await act(async () => { disable.click() })
    await settle()
    // Without this the assertions below would pass on rows that never
    // changed, which is the one outcome they cannot tell apart from a fix.
    expect(view.calls).toEqual([['ts-alpha', 'ts-beta']])

    const toggles = togglesIn(view.container)
    // Kept, the old selection filters every row away while no chip is lit, and
    // the panel goes blank for a reason the page never states.
    expect(hasRow(toggles, 'ts-alpha')).toBe(true)
    expect(hasRow(toggles, 'ts-beta')).toBe(true)
    // Asked for by exact chip text: rows print their path, which also contains
    // the old workspace, so a substring test would pass for the wrong reason.
    const chips = [...toggles.querySelectorAll('span')].map(chip => chip.textContent?.trim() ?? '')
    expect(chips.some(label => /^\/code\/Modu \d+$/.test(label))).toBe(false)
    // And the filter is live again rather than merely reset: the new workspace
    // still narrows what is on screen.
    await act(async () => { chipIn(view.container, '/code/other 2').click() })
    await settle()
    expect(togglesIn(view.container).querySelectorAll('input[type="checkbox"]').length).toBe(2)
    view.dispose()
  })
})