/**
 * dsh-rules browser half.
 *
 * The module loader calls this factory with `require` alone, so the CommonJS
 * preamble and the loader envelope live in the source rather than being added
 * by a build step. `scripts/build-client.mjs` only minifies this file.
 *
 * The page draws itself from `--dsw-*` tokens and imports no dsh client
 * package: those are versioned on the client line, and pulling one into a host
 * package's dependency tree drags a second copy of the session projection in.
 */

window.__ModuleLoader__.load({
  /**
   * The loader resolves this id to a package, so it is the published name.
   *
   * It reads as harmless to leave it on the bare `dsh-rules` because that is
   * also this plugin's profile row id, but the two mean different things: the
   * row id is deployment-local, while the envelope id is a package lookup, and
   * on the registry the bare name is a different, unrelated plugin. When the
   * two disagree the browser half fails to import and the host reports only
   * "import failed". Written as a literal rather than a shared binding because
   * the module loader evaluates the envelope on its own; the two occurrences
   * are kept equal by a test that reads the manifest.
   */
  id: '@ndsanes/dsh-rules',
  factory: require => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** This plugin's npm package name, which the Plugins page matches on. */
    var PACKAGE_NAME = '@ndsanes/dsh-rules'

    /**
     * The row id `cordis.patch.yml` inserts.
     *
     * Deployment-local rather than the package name, and kept apart from it so
     * the two cannot drift: a subject arrives carrying a row id, and the Plugins
     * page matches this plugin's own row by it.
     */
    var ROW_ID = 'dsh-rules'

    const React = require('react')
    const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React
    const { translator, sourceLabel: sourceLabelFor, REASON_KEY } = require('./i18n.js')
    const { CODECS } = require('./codec.js')

    const h = React.createElement

    /**
     * This plugin's client Remote contribution.
     *
     * `@deepseek-ai/dsh-api-remotes/client` is a build-time list of the
     * harness's own namespaces, so a plugin's own namespace is mounted here
     * rather than depended on: declaring `remote.dshRules` in `inject` would
     * wait forever for a service nobody provides.
     */
    const RULES_REMOTE = {
      package: PACKAGE_NAME,
      descriptors: [
        {
          id: `${PACKAGE_NAME}#dshRules/audit`,
          service: 'dshRules',
          namespace: 'dshRules',
          method: 'audit',
          invocation: { kind: 'direct' },
          parameters: [],
          result: CODECS.auditReport(),
        },
        {
          id: `${PACKAGE_NAME}#dshRules/setDisabled`,
          service: 'dshRules',
          namespace: 'dshRules',
          method: 'setDisabled',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'names', wire: 'names', source: 'json', codec: CODECS.ruleNames() }],
          result: CODECS.toggleResult(),
        },
        {
          id: `${PACKAGE_NAME}#dshRules/setMode`,
          service: 'dshRules',
          namespace: 'dshRules',
          method: 'setMode',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'name', wire: 'name', source: 'json', codec: CODECS.ruleName() },
            { name: 'mode', wire: 'mode', source: 'json', codec: CODECS.interruptMode() },
          ],
          result: CODECS.modeChangeResult(),
        },
        {
          id: `${PACKAGE_NAME}#dshRules/readRule`,
          service: 'dshRules',
          namespace: 'dshRules',
          method: 'readRule',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'name', wire: 'name', source: 'json', codec: CODECS.ruleName() }],
          result: CODECS.readRuleResult(),
        },
        {
          id: `${PACKAGE_NAME}#dshRules/writeRule`,
          service: 'dshRules',
          namespace: 'dshRules',
          method: 'writeRule',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'name', wire: 'name', source: 'json', codec: CODECS.ruleName() },
            { name: 'content', wire: 'content', source: 'json', codec: CODECS.ruleBody() },
          ],
          result: CODECS.toggleResult(),
        },
        {
          id: `${PACKAGE_NAME}#dshRules/listWorkspaces`,
          service: 'dshRules',
          namespace: 'dshRules',
          method: 'listWorkspaces',
          invocation: { kind: 'direct' },
          parameters: [],
          result: CODECS.workspaceList(),
        },
        {
          id: `${PACKAGE_NAME}#dshRules/openWorkspace`,
          service: 'dshRules',
          namespace: 'dshRules',
          method: 'openWorkspace',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'path', wire: 'path', source: 'json', codec: CODECS.workspacePath() }],
          result: CODECS.toggleResult(),
        },
        {
          id: `${PACKAGE_NAME}#dshRules/closeWorkspace`,
          service: 'dshRules',
          namespace: 'dshRules',
          method: 'closeWorkspace',
          invocation: { kind: 'direct' },
          parameters: [],
          result: CODECS.nothing(),
        },
      ],
    }

    /** Bundled rule names and descriptions, generated from the same Markdown the Host loads. */
    const BUNDLED = Object.entries(require('./builtin-catalog.js').BUNDLED_RULES)
      .map(([name, description]) => ({ name, description }))

    /**
     * Every mode a rule may be overridden to, in the order the selector offers.
     *
     * A copy of `INTERRUPT_MODES` in `src/config.ts`: the module that owns the
     * list reaches for schemastery and zod, which the loader's platform table
     * does not carry, so the browser half cannot import it. A test reads both
     * files and fails if they drift.
     */
    const INTERRUPT_MODES = ['never', 'prose-only', 'tool-only', 'always']

    /**
     * dsh's locale runtime publishes an immutable snapshot and notifies on
     * change, which is exactly the `useSyncExternalStore` shape. The page has
     * no language switch of its own: it follows Settings → Language.
     */
    /**
     * The locale snapshot used when the runtime is absent, and as the server
     * snapshot. Frozen and module-level because React requires every snapshot
     * to be referentially stable; a fresh literal each call warns and loops.
     */
    const EN_LOCALE = Object.freeze({ active: 'en', locales: [], revision: 0 })
    const NO_SUBSCRIBE = () => () => {}

    /**
     * Follow the platform's active language.
     *
     * The hook is called unconditionally: `ctx.inject(['locale'])` can resolve
     * after the first render, and an early return would change the number of
     * hooks between renders, which React rejects outright.
     */
    function useLocale(ctx) {
      const locale = ctx && ctx.locale
      const { subscribe, getSnapshot } = useMemo(() => locale === undefined
        ? { subscribe: NO_SUBSCRIBE, getSnapshot: () => EN_LOCALE }
        : { subscribe: locale.subscribe.bind(locale), getSnapshot: locale.getSnapshot.bind(locale) },
      [locale])
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).active
    }

    /**
     * Read the active locale without a hook.
     *
     * A slot `label` is a thunk the host calls, not a component, so it cannot
     * call `useLocale` — that would be a hook outside a render, and React throws
     * on it. `getSnapshot` is the same read `useLocale` subscribes to, taken
     * once here so a label stays a plain string.
     */
    function localeNow(ctx) {
      const locale = ctx && ctx.locale
      if (locale === undefined || typeof locale.getSnapshot !== 'function') return EN_LOCALE
      const snapshot = locale.getSnapshot()
      return snapshot === undefined || snapshot === null ? EN_LOCALE : snapshot.active
    }

    /** Family a bundled rule belongs to, taken from its name prefix. */
    function familyOf(name) {
      const dash = name.indexOf('-')
      return dash === -1 ? name : name.slice(0, dash)
    }

    /**
     * Chart primitives, hand-drawn.
     *
     * dsh's web client ships no charting library, and `dsh-usage-chart` — the
     * one community plugin that draws charts — documents the same conclusion:
     * a self-drawn SVG that reads the platform's own tokens is smaller and
     * steadier than a vendored library. Fills go through `style` because the
     * `fill` attribute does not resolve `var()`.
     */

    /**
     * Semantic series colours, all from the host's token set.
     *
     * The neutral fill deliberately avoids the track colour: the two sit on
     * top of each other, and a matching pair renders a filled bar as an empty
     * groove.
     */
    const SERIES = {
      on: 'var(--dsw-alias-state-success-primary)',
      off: 'var(--dsw-alias-state-warning, #c90)',
      alert: 'var(--dsw-alias-state-danger, #d33)',
      neutral: 'var(--dsw-alias-label-secondary)',
      track: 'var(--dsw-alias-bg-layer-3)',
    }

    /** Distinct fills for categorical charts, so neighbours never read alike. */
    const CATEGORY = [
      'var(--dsw-alias-brand-primary)',
      'var(--dsw-alias-label-secondary)',
      'var(--dsw-alias-state-success-primary)',
    ]

    /** One horizontal bar row: label, count, proportional fill. */
    function Bar(props) {
      const share = props.max === 0 ? 0 : props.value / props.max
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '1px 0' } },
        h('span', {
          style: { ...styles.barLabel, width: '150px' },
          title: props.title ?? props.label,
        }, props.label),
        h('span', { style: { flex: '1 1 auto', minWidth: '40px', height: '8px', borderRadius: '4px', background: SERIES.track, overflow: 'hidden' } },
          h('span', {
            style: {
              display: 'block', height: '100%', width: `${Math.round(share * 100)}%`,
              background: props.color ?? SERIES.neutral, borderRadius: '4px',
            },
          })),
        h('span', { style: styles.barValue }, props.value))
    }

    /**
     * A composition bar: one full-width track split by share.
     *
     * The right form for parts of a whole. Bars per category were worse than
     * reading the numbers: the dominant category filled the whole track and the
     * minor one was a stub, so length carried no information the label did not.
     */
    function Stack(props) {
      const total = props.rows.reduce((sum, row) => sum + row.value, 0)
      if (total === 0) {
        return h('div', { style: styles.chart },
          h('div', { style: styles.chartTitle }, props.title),
          props.note && h('p', { style: styles.hint }, props.note),
          h('p', { style: styles.hint }, props.empty ?? '—'))
      }

      const segments = props.rows.map(row => h('span', {
        key: row.label,
        title: `${row.label} ${row.value}`,
        style: {
          display: 'block',
          height: '100%',
          width: `${(row.value / total) * 100}%`,
          background: row.color,
        },
      }))

      const legend = props.rows.map(row => h('span', { key: row.label, style: styles.legendItem },
        h('span', { style: { ...styles.swatch, background: row.color } }),
        `${row.label} `,
        h('strong', { style: styles.legendValue }, String(row.value))))

      return h('div', { style: styles.chart },
        h('div', { style: styles.chartTitle }, props.title),
        h('div', { style: styles.stackTrack }, segments),
        h('div', { style: styles.legend }, legend),
        // The legend numbers are a different quantity from the ones the title
        // is about, and a reader who assumes otherwise reads them backwards, so
        // the unit is stated rather than left to be inferred from the title.
        props.note && h('p', { style: styles.hint }, props.note))
    }

    /** A titled group of bars, for a ranking rather than a whole. */
    function Chart(props) {
      return h('div', { style: styles.chart },
        // The title is optional because a ranking folded inside a `<details>`
        // is already named by the summary the reader is looking at, and a
        // second copy of the same words directly under it says nothing.
        props.title && h('div', { style: styles.chartTitle }, props.title),
        props.rows.length === 0
          ? h('p', { style: styles.hint }, props.empty ?? 'Nothing to show yet.')
          : // `max` has to reach every row, not just the chart: without it each
            // bar divides by `undefined`, the resulting `NaN%` is dropped by CSS,
            // and all eight fill their track identically — a chart whose length
            // says nothing and whose only working part is the number beside it.
            props.rows.map(row => h(Bar, { key: row.label, max: props.max, ...row })))
    }

    /** One large number with its label. */
    function Stat(props) {
      return h('div', { style: styles.stat },
        h('span', { style: styles.statValue }, props.value),
        h('span', { style: styles.statLabel }, props.label))
    }

    /**
     * Unwrap a gateway result.
     *
     * Every Remote result crosses the wire as `{ok, value}`: the outer `ok`
     * reports transport success and `value` is what the Host method returned.
     * Only `setDisabled` puts an `ok` of its own in that value — the audit
     * report is the bare payload — so each call site decides success from the
     * shape it actually receives, through this one helper.
     *
     * @param envelope - whatever the Remote method resolved to.
     * @returns the method's return value.
     */
    function unwrap(envelope) {
      return envelope === null || envelope === undefined ? undefined : envelope.value ?? envelope
    }

    /**
     * Readable name for one workspace entry.
     *
     * `title` is documented to default to the path's last segment but is not
     * guaranteed non-empty, and two workspaces may share one, so this falls
     * back through the full path and finally the id rather than rendering a
     * blank row.
     *
    /**
     * The bucket a rule belongs to for the workspace filter.
     *
     * Three genuinely different groups can carry no `scope`: the rules that
     * ship with the plugin, and rules read from the user directory. Folding
     * them together — or labelling them with the all-workspaces word — gave two
     * distinct buckets one label, so the row read "all 46 | all 27 | Modu 19".
     *
     * @param rule - one audit row.
     * @returns a stable key for the workspace filter.
     */
    function scopeKeyOf(rule) {
      if (rule.scope !== undefined && rule.scope !== '') return rule.scope
      return rule.provider === 'builtin-defaults' ? '\u0000builtin' : '\u0000user'
    }

    /**
     * Readable label for a workspace bucket key.
     *
     * @param key - a `scopeKeyOf` value, which may be a sentinel.
     * @param t - translator.
     * @returns the word the reader sees on the chip.
     */
    function scopeLabel(key, t) {
      if (key === '\u0000builtin') return t('scopeBuiltin')
      if (key === '\u0000user') return t('scopeUser')
      return key
    }

    /**
     * Readable name for one workspace entry.
     *
     * `title` is documented to default to the path's last segment but is not
     * guaranteed non-empty, and two workspaces may share one, so this falls
     * back through the full path and finally the id rather than rendering a
     * blank row.
     *
     * @param entry - one workspace as the Host reported it.
     * @returns something the reader can pick out of a list.
     */
    function workspaceLabel(entry) {
      const title = typeof entry.title === 'string' ? entry.title.trim() : ''
      const path = typeof entry.path === 'string' ? entry.path.trim() : ''
      if (title !== '' && title !== path) return title
      if (path !== '') return path
      return entry.id === undefined ? '' : String(entry.id)
    }

    /**
     * Report whether a page subject is this plugin's own entry.
     *
     * `subject` is absent on every surface that is not the plugin's own detail
     * page, so the check has to survive it: reading `kind` off `undefined`
     * would throw inside the page's render and take the surrounding panel with
     * it, rather than simply not rendering here.
     */
    function ownsSubject(subject) {
      if (subject === undefined || subject === null) return false
      if (subject.kind === 'bundle') return subject.pkg?.name === PACKAGE_NAME
      if (subject.kind === 'row') {
        return subject.row?.moduleName === PACKAGE_NAME || subject.row?.rowId === ROW_ID
      }
      return subject.id === ROW_ID || subject.id === PACKAGE_NAME
    }

    const styles = {
      section: {
        display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px', padding: '12px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' },
      title: { margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      count: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      hint: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      code: {
        fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: '11px', padding: '1px 4px',
        borderRadius: 'var(--dsw-radius-xs)', background: 'var(--dsw-alias-bg-layer-3)',
      },
      workspace: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
      filterLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginRight: '2px' },
      toolbar: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
      chip: (active) => ({
        fontSize: '11px', padding: '3px 8px', borderRadius: 'var(--dsw-radius-sm)', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: active ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
      }),
      search: {
        // The section is a column flex container, so a bare child stretches to
        // full width and a `flex` basis does nothing. Cap the width, and give the
        // control a height instead of letting the browser default grow it.
        width: '100%', maxWidth: '360px', boxSizing: 'border-box', height: '26px',
        fontSize: '12px', lineHeight: '24px', padding: '0 8px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
      },
      bulk: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
      button: {
        fontSize: '11px', padding: '3px 8px', borderRadius: 'var(--dsw-radius-sm)', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
      },
      list: { display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' },
      // One line height, named once. The checkbox, the switch and the rule's
      // first text line each have to occupy exactly this box: a checkbox has no
      // baseline to align to, and a button's baseline is its own text, so
      // aligning anything to a baseline leaves the three at different heights.
      rowLine: '18px',
      row: {
        display: 'flex', alignItems: 'flex-start',
        gap: '8px', padding: '3px 0',
      },
      rowControl: {
        display: 'flex', alignItems: 'flex-start', gap: '6px',
        height: '18px', flex: '0 0 auto',
      },
      rowCheck: {
        width: '13px', height: '13px', margin: '2px 0 0', cursor: 'pointer', flex: '0 0 auto',
      },
      switchButton: {
        fontSize: '10px', lineHeight: '16px', height: '18px', minWidth: '38px',
        boxSizing: 'border-box',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', padding: '0 6px', margin: '0',
        border: '1px solid currentColor', borderRadius: 'var(--dsw-radius-xs)',
        background: 'transparent',
      },
      // Sized to the row's own line box: a selector at the workspace picker's
      // height would push every row's first line out of alignment.
      modeSelect: {
        fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: '11px', lineHeight: '16px', height: '18px',
        boxSizing: 'border-box', maxWidth: '160px', padding: '0 2px', margin: '0',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-12)', borderRadius: 'var(--dsw-radius-xs)',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
      },
      rowSelected: { background: 'var(--dsw-alias-bg-layer-3)' },
      modalBackdrop: {
        position: 'fixed', inset: '0', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '24px', background: 'rgba(0, 0, 0, 0.55)',
      },
      modal: {
        display: 'flex', flexDirection: 'column', gap: '10px',
        width: '100%', maxWidth: '760px', maxHeight: '90vh', overflowY: 'auto',
        padding: '16px', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
      },
      editorTabs: { display: 'flex', gap: '6px', alignItems: 'center' },
      editorActions: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
      form: { display: 'flex', flexDirection: 'column', gap: '14px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      fieldName: {
        fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: '12px', fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
      },
      fieldHelp: { fontSize: '11px', lineHeight: '1.5', color: 'var(--dsw-alias-label-secondary)' },
      fieldInput: {
        width: '100%', boxSizing: 'border-box', height: '28px', fontSize: '12px',
        padding: '0 8px', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
      },
      fieldLines: {
        width: '100%', boxSizing: 'border-box', minHeight: '72px', resize: 'vertical',
        fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: '12px', lineHeight: '1.5',
        padding: '6px 8px', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
      },
      editorArea: {
        width: '100%', boxSizing: 'border-box', minHeight: '260px', resize: 'vertical',
        fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: '12px', lineHeight: '1.5',
        padding: '8px', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
      },
      name: { fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: '12px', color: 'var(--dsw-alias-label-primary)' },
      meta: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      description: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      path: {
        fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: '10px',
        color: 'var(--dsw-alias-label-dimmed)', wordBreak: 'break-all',
      },
      state: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      off: { fontSize: '11px', color: 'var(--dsw-alias-state-warning, #c90)' },
      error: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-danger, #d33)' },
      stats: { display: 'flex', flexWrap: 'wrap', gap: '16px', marginTop: '4px' },
      stat: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '68px' },
      statValue: { fontSize: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.1 },
      statLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      charts: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px', marginTop: '12px' },
      chart: { display: 'flex', flexDirection: 'column', gap: '4px' },
      // The summary is a chart title that happens to be clickable, so it is
      // spelled out again here rather than spread off `chartTitle`: the object
      // literal cannot reference itself, and a folded chart with a plain body
      // summary reads as a stray paragraph instead of as a section head.
      disclosure: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '0' },
      disclosureSummary: {
        fontSize: '11px', color: 'var(--dsw-alias-label-secondary)',
        textTransform: 'uppercase', letterSpacing: '0.04em', cursor: 'pointer',
      },
      chartTitle: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' },
      stackTrack: {
        display: 'flex', width: '100%', height: '10px', borderRadius: '5px',
        overflow: 'hidden', background: SERIES.track,
      },
      legend: { display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '2px' },
      legendItem: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      legendValue: { color: 'var(--dsw-alias-label-primary)' },
      swatch: { width: '8px', height: '8px', borderRadius: '2px', display: 'inline-block' },
      barLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      barValue: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', minWidth: '22px', textAlign: 'right' },
      badge: {
        fontSize: '10px', padding: '1px 5px', borderRadius: 'var(--dsw-radius-xs)',
        background: 'var(--dsw-alias-interactive-bg-active)', color: 'var(--dsw-alias-label-secondary)',
      },
    }

    /**
     * Resolve a host reason code. The Host sends codes rather than prose so
     * the page can read in the reader's language; an unrecognised code shows
     * itself, because a new code should be visible rather than flattened into
     * "unknown".
     */
    function translateReason(code, t) {
      if (code === undefined || code === '') return t('reasonUnknown')
      const key = REASON_KEY[code]
      return key === undefined ? code : t(key)
    }

    /**
     * The mode a rule states for itself, as opposed to one an override forces.
     *
     * The report carries both because an overridden rule no longer says what it
     * would have said, and the selector's "follow the rule" option has to name
     * what following means. A rule that states no mode at all follows the
     * profile's `ttsr.interruptMode` instead, which is what an absent value
     * says everywhere else on the page.
     */
    function ownMode(rule) {
      return rule.modeOverride === undefined ? rule.interruptMode : rule.ownInterruptMode
    }

    /** One line of a rule, shared by the audit table and the toggle list. */
    function RuleLine(props) {
      const rule = props.rule
      const t = props.t
      return h('div', { style: styles.row },
        // Selection drives the bulk bar; the switch on the right is what
        // actually flips the rule. Overloading one control for both made the
        // checkbox look like a switch and do nothing.
        h('div', { style: styles.rowControl },
        props.checkbox && h('input', {
          style: styles.rowCheck,
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.busy === true,
          onChange: () => props.onSelect(rule.name),
          title: t('selectHint'),
        }),
        props.switchable === true && h('button', {
          type: 'button',
          style: { ...styles.switchButton, color: rule.active ? SERIES.on : SERIES.off },
          disabled: props.busy === true,
          title: rule.active ? t('disableHint') : t('enableHint'),
          onClick: () => props.onSwitch(rule.name),
          // The label is the action, not the state: a button reading "on" for
          // an enabled rule reads as "turn it on".
        }, t(rule.active ? 'off' : 'on'))),
        h('span', {
          style: {
            display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '1 1 auto',
            fontSize: '13px', lineHeight: styles.rowLine,
          },
        },
          h('span', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap', minHeight: styles.rowLine } },
            h('span', { style: { ...styles.name, lineHeight: styles.rowLine, minHeight: styles.rowLine } }, rule.name),
            h('span', { style: rule.active ? styles.state : styles.off },
              rule.active ? t('inForceState') : t('offState', { reason: translateReason(rule.reason, t) })),
            // The mode selector, on every row including the bundled ones: 27 of
            // the rules that ship with this plugin have no file a reader can
            // edit, so this control is the only way to change how one of them
            // interrupts. It writes to the profile rather than to a rule file,
            // which is why a project rule's own value is offered as an option
            // instead of being overwritten by the same gesture.
            props.onMode !== undefined && h('select', {
              style: styles.modeSelect,
              value: rule.modeOverride ?? '',
              disabled: props.busy === true,
              title: t('modeHint'),
              onChange: event => props.onMode(rule.name, event.target.value),
            }, [
              h('option', { key: 'follow', value: '' }, ownMode(rule) === undefined
                ? t('modeFollow')
                : t('modeFollowsRule', { mode: ownMode(rule) })),
              ...INTERRUPT_MODES.map(mode => h('option', { key: mode, value: mode }, mode)),
            ]),
            props.trailing !== undefined && h('span', { style: styles.badge }, props.trailing),
            props.onEdit !== undefined && h('button', {
              type: 'button', style: styles.button,
              title: t('editRule'),
              onClick: () => props.onEdit(rule.name),
            }, t('editRule'))),
          rule.description !== undefined && rule.description !== '' &&
            h('span', { style: styles.description }, rule.description),
          h('span', { style: styles.path }, `${sourceLabelFor(props.locale, rule.provider, rule.scope)} · ${rule.path}`)))
    }

    /** Count rows for a chart, biggest first, with a stable colour each. */
    function tally(counts, palette) {
      const rows = Object.entries(counts)
        .filter(([, value]) => value > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([label, value], index) => ({
          label,
          value,
          color: palette[index % palette.length],
        }))
      return { rows, max: rows.reduce((top, row) => Math.max(top, row.value), 0) }
    }

    /**
     * The numbers first: how many rules exist, how many are in force, and how
     * often each has actually been delivered to the model.
     */
    function RuleDashboard(props) {
      const report = props.report
      const t = props.t

      const sources = tally(
        report.rules.reduce((counts, rule) => {
          const label = sourceLabelFor(props.locale, rule.provider, rule.scope)
          counts[label] = (counts[label] ?? 0) + 1
          return counts
        }, {}),
        CATEGORY,
      )
      const triggersByKind = tally(
        report.rules.reduce((counts, rule) => {
          for (const kind of rule.triggers ?? []) counts[kind] = (counts[kind] ?? 0) + 1
          return counts
        }, {}),
        CATEGORY,
      )
      // The ledger is per profile and the rule set is per workspace, so a count
      // can name a rule this workspace has never heard of. Counting those here
      // would put "6 delivered" beside "29 never fired" and have both be true.
      const inScope = new Set(report.rules.map(rule => rule.name))
      const triggered = report.triggered ?? {}
      const scopedCounts = Object.entries(triggered).filter(([name]) => inScope.has(name))
      const elsewhere = Object.entries(triggered)
        .filter(([name]) => !inScope.has(name))
        .reduce((total, [, count]) => total + count, 0)

      const delivered = scopedCounts.reduce((total, [, count]) => total + count, 0)
      const neverFired = report.rules.filter(rule => (triggered[rule.name] ?? 0) === 0).length
      const withTrigger = report.rules.filter(rule => (rule.triggers?.length ?? 0) > 0).length

      // How delivery is spread, rather than which rule leads it. A ranking
      // answered a question almost nobody has while hiding the one they do
      // have: it grew a row per rule, its scale was set by whichever rule
      // happened to fire most, and on a real profile that winner is 5 — so a
      // page-wide field of one colour with a length set by one rule said more
      // about how many rules exist than about delivery. Five buckets are fixed
      // on purpose, so two profiles stay comparable, and the last one absorbs
      // everything from four up: a single runaway rule can neither stretch the
      // scale nor append a sixth bucket the reader has never seen.
      //
      // Every value is a count of rules, and the five of them add up to the
      // rule total — the track is a whole partitioned into parts, which is what
      // `Stack` draws and what `Chart` cannot.
      const distribution = [
        { label: t('bucketNeverFired'), value: neverFired, color: SERIES.neutral },
        { label: t('bucketOnce'), value: scopedCounts.filter(([, count]) => count === 1).length, color: CATEGORY[0] },
        { label: t('bucketTwice'), value: scopedCounts.filter(([, count]) => count === 2).length, color: CATEGORY[2] },
        { label: t('bucketThrice'), value: scopedCounts.filter(([, count]) => count === 3).length, color: SERIES.off },
        { label: t('bucketFourPlus'), value: scopedCounts.filter(([, count]) => count >= 4).length, color: CATEGORY[1] },
      ]

      // The per-rule ranking survives for the reader who has to go act on one
      // rule, but folded: it is the answer to a narrower question than the
      // distribution is, and open by default it outshouted the chart above it.
      // Neutral rather than the alert red it used to wear — a high count is not
      // a fault, and painting the whole panel red for one delivered rule made
      // the colour mean nothing.
      const busiest = scopedCounts
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([label, value]) => ({ label, value, color: SERIES.neutral }))

      return h('div', { 'data-dsh-rules': 'dashboard' },
        // Deliberately no counts of how many rules exist or how many are in
        // force: the toggle list directly below states the exact number in both
        // directions, and saying it twice makes one of them look stale.
        h('div', { style: styles.stats },
          h(Stat, { value: delivered, label: t('deliveriesHere') }),
          elsewhere > 0 && h(Stat, { value: elsewhere, label: t('deliveredElsewhere') }),
          h(Stat, { value: neverFired, label: t('neverFired') })),
        h('div', { style: styles.charts },
          h(Stack, { title: t('chartSource'), rows: sources.rows, empty: t('noMatch') }),
          h(Stack, {
            title: t('triggerRuleCount', { with: withTrigger, total: report.rules.length }),
            rows: triggersByKind.rows,
            empty: t('noTrigger'),
          }),
          h('div', { 'data-dsh-rules': 'distribution' },
            h(Stack, {
              title: t('chartDistribution'),
              // With nothing delivered the distribution is one bar at a
              // hundred percent in the "never fired" bucket, which states what
              // the stat row above already states and looks like a chart. The
              // sentence below the track says the same thing without drawing a
              // shape that implies there is a spread to read.
              rows: delivered === 0 ? [] : distribution,
              note: t('distributionNote'),
              empty: t('noDelivered'),
            })),
          // Native disclosure rather than a `useState` toggle: the folded state
          // is the default, and `<details>` is the one element that stays
          // folded across a re-render without the page having to remember that
          // the reader never opened it.
          h('details', { style: styles.disclosure, 'data-dsh-rules': 'delivery-detail' },
            h('summary', { style: styles.disclosureSummary },
              t('chartDelivered', { count: busiest.length })),
            h(Chart, {
              rows: busiest,
              max: busiest.reduce((top, row) => Math.max(top, row.value), 0),
              empty: t('noDelivered'),
            }))),
        h('p', { style: styles.hint },
          `${t('deliveryNote')} ${elsewhere > 0 ? t('deliveryNoteElsewhere') : t('deliveryNoteScoped')}`))
    }

    /**
     * The audit: every rule discovery found, grouped by where it came from.
     */
    function RuleAudit(props) {
      const ctx = props.ctx
      const locale = useLocale(ctx)
      const t = translator(locale)
      // A caller may hand in the report it already has. The page itself never
      // does, but the seam is what makes the dashboard, the stale branch, and
      // the empty states reachable from a test at all.
      const [loaded, setLoaded] = useState(props.report)
      const [error, setError] = useState(undefined)
      const report = props.report ?? loaded

      const refresh = useCallback(() => {
        // A missing namespace or a thrown call is a page-level fault, not a
        // reason to take the whole Plugins page down with a crashed slot.
        try {
          const remote = ctx && ctx.remote && ctx.remote.dshRules
          if (remote === undefined) {
            setError('this deployment did not mount the dshRules Remote namespace')
            return
          }
          Promise.resolve(remote.audit()).then(
            envelope => {
              const result = unwrap(envelope)
              if (result && Array.isArray(result.rules)) { setLoaded(result); setError(undefined) }
              else setError(envelope?.error?.code ?? envelope?.code ?? t('readFailedShort'))
            },
            failure => setError(failure instanceof Error ? failure.message : String(failure)),
          )
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ctx])

      useEffect(() => { refresh() }, [refresh])

      // Same seam as the report: a caller may supply the list, which is what
      // makes the control renderable without a live remote call.
      const [workspaces, setWorkspaces] = useState(props.workspaces ?? [])
      const [chosen, setChosen] = useState('')
      const [typed, setTyped] = useState('')

      const loadWorkspaces = useCallback(() => {
        let call
        try {
          call = Promise.resolve(ctx.remote.dshRules.listWorkspaces())
        } catch {
          return
        }
        call.then(
          envelope => {
            const list = unwrap(envelope)
            if (Array.isArray(list)) setWorkspaces(list)
          },
          // A host without a workspace registry simply offers none; the panel
          // still audits whatever the last session left behind.
          () => undefined,
        )
      }, [ctx])

      useEffect(() => { loadWorkspaces() }, [loadWorkspaces])

      /**
       * Audit one workspace, or clear back to none.
       *
       * Without this the panel can only ever describe a workspace a session
       * happened to open: archiving every session left it showing that dead
       * workspace's rules with nothing on screen saying whose they were.
       */
      const openOne = useCallback(path => {
        setChosen(path)
        setTyped(path)
        let call
        try {
          call = Promise.resolve(ctx.remote.dshRules.openWorkspace(path))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return
        }
        call.then(
          envelope => {
            const outcome = unwrap(envelope)
            if (outcome && outcome.ok === true) { setError(undefined); refresh() }
            else setError(outcome?.guidance ?? t('openFailed'))
          },
          failure => setError(failure instanceof Error ? failure.message : String(failure)),
        )
      }, [ctx, refresh, t])

      /** Close the workspace: the panel's own action, not an empty open. */
      const closeOne = useCallback(() => {
        setChosen('')
        let call
        try {
          call = Promise.resolve(ctx.remote.dshRules.closeWorkspace())
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return
        }
        call.then(
          () => { setError(undefined); refresh() },
          failure => setError(failure instanceof Error ? failure.message : String(failure)),
        )
      }, [ctx, refresh])

      // Variadic: each branch passes its own children, and a single-parameter
      // shell would silently drop all but the first.
      // The header carries no counts: the toggle list below states the exact
      // number in both directions, so repeating it here only creates a second
      // number that can disagree with the first.
      const shell = (...body) => h('section', { style: styles.section, 'data-dsh-rules': 'audit' },
        h('div', { style: styles.header },
          h('h3', { style: styles.title }, t('auditTitle'))),
        h('div', { style: styles.workspace },
          workspaces.length > 0
            ? h('select', {
              style: styles.search,
              value: chosen,
              onChange: event => setChosen(event.target.value),
            }, [
              h('option', { key: '', value: '' }, t('workspaceNone')),
              // A blank option is unusable: the reader cannot tell which
              // project they are about to audit. Fall through every field the
              // entity carries before giving up.
              ...workspaces.map(workspace => h('option', {
                key: workspace.id,
                value: workspace.path,
              }, workspaceLabel(workspace))),
            ])
            : h('p', { style: styles.hint }, t('noWorkspacesRegistered')),
          workspaces.length === 0 && h('input', {
            style: styles.search, type: 'text', value: typed,
            placeholder: t('workspacePathPlaceholder'),
            onChange: event => setTyped(event.target.value),
          }),
          h('button', {
            type: 'button', style: styles.button,
            disabled: (workspaces.length > 0 ? chosen : typed).trim() === '',
            onClick: () => openOne(workspaces.length > 0 ? chosen : typed.trim()),
          }, t('workspaceOpen')),
          h('button', {
            type: 'button', style: styles.button, disabled: report?.cwd === undefined || report.cwd === '',
            onClick: closeOne,
          }, t('workspaceClose'))),
        // Children arrive as an array, so React needs keys; Children.map
        // assigns them without every branch having to invent one.
        React.Children.map(body, child => child))

      if (error !== undefined) return shell(h('p', { style: styles.error }, t('readFailed', { reason: error })))
      if (report === undefined) return shell(h('p', { style: styles.hint }, t('reading')))
      if (report.stale !== undefined) {
        return shell(
          h('p', { style: styles.hint }, t('staleWorkspace', { cwd: report.stale.cwd })),
          h('p', { style: styles.hint }, t('staleHint')))
      }
      // No rule-by-rule table here. The toggle list further down already
      // enumerates every rule with its source, description, path and state;
      // printing the same inventory twice meant one of the two lists could
      // disagree with the other and with the counts above.
      if (report.cwd !== '') {
        return shell(
          h(RuleDashboard, { report, t, locale }),
          // A bare path said where the rules came from without saying what was
          // found there; naming the sources next to it answers both at a glance.
          h('p', { style: styles.hint },
            `${t('auditOfCwd')} ${report.cwd} · ${
              [...new Set(report.rules.map(rule => sourceLabelFor(locale, rule.provider, rule.scope)))].join(', ')
            }`))
      }
      // No workspace is a different state from an empty filter: the page said
      // "no rules match the current filter" for what was really "nothing open".
      return shell(h('p', { style: styles.hint }, t('noWorkspace')))
    }

    /**
     * Bundled rules, filterable and multi-selectable.
     *
     * Reads come from the audit; writes go through the configuration form,
     * which owns the profile patch. Routing a write through any other door is
     * how the two surfaces drift apart.
     */
    function BundledRuleToggles(props) {
      const ctx = props.ctx
      const locale = useLocale(ctx)
      const t = translator(locale)
      // Same seam as the audit: a caller may supply the report, which is what
      // makes this section renderable outside a live remote call.
      const [loaded, setLoaded] = useState(props.report)
      const report = props.report ?? loaded
      const [selected, setSelected] = useState([])
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(undefined)
      const [family, setFamily] = useState('all')
      // A second filter, not a replacement for the first: narrowing by prefix
      // and narrowing by workspace are independent questions, and answering
      // one must not discard the answer to the other.
      const [scope, setScope] = useState('all')
      const [query, setQuery] = useState('')

      const refresh = useCallback(() => {
        Promise.resolve(ctx.remote.dshRules.audit()).then(
          envelope => {
            const result = unwrap(envelope)
            if (result && Array.isArray(result.rules)) setLoaded(result)
          },
          () => undefined,
        )
      }, [ctx])

      useEffect(() => { refresh() }, [refresh])

      // Every rule the current workspace discovered, not only the bundled
      // catalog: `ttsr.disabledRules` matches by name across every provider, so
      // a project rule is as toggleable as a built-in one and hiding it here
      // only meant editing those rules somewhere else.
      const rows = useMemo(() => {
        const discovered = report?.rules ?? []
        // The bundled catalog is the fallback when no report has arrived, so the
        // list is never empty just because the audit call has not landed.
        const source = discovered.length > 0
          ? discovered
          : BUNDLED.map(rule => ({ ...rule, provider: 'builtin-defaults', path: rule.name, active: true }))
        return [...source].sort((a, b) => a.name.localeCompare(b.name))
      }, [report])

      // What the reader actually switched off, which is not what `active: false`
      // means. The Host folds five unrelated reasons into it — `disabled`,
      // `builtins-off`, `agent-filter`, `no-trigger`, `shadowed` — and the bulk
      // buttons below *replace* the whole list, so writing that set back put
      // every rule a config or a shadow had taken out of force into the user's
      // `ttsr.disabledRules`, each of them then reported as "listed in
      // ttsr.disabledRules" the moment the config came back on.
      const off = useMemo(
        () => new Set((report?.rules ?? []).filter(rule => rule.reason === 'disabled').map(rule => rule.name)),
        [report])

      const families = useMemo(() => {
        const counts = {}
        for (const rule of rows) counts[familyOf(rule.name)] = (counts[familyOf(rule.name)] ?? 0) + 1
        return Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))
      }, [rows])

      const scopes = useMemo(() => {
        const counts = {}
        for (const rule of rows) {
          // A rule with no scope is still a distinct bucket. Folding it into
          // the empty string gave the bundled rules the same label as the
          // all-workspaces chip, so the row read "all 46 | all 27 | Modu 19".
          const key = scopeKeyOf(rule)
          counts[key] = (counts[key] ?? 0) + 1
        }
        return Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))
      }, [rows])

      // A selection whose rows have all gone would filter everything out while
      // no chip looked active, leaving a blank panel with no explanation.
      useEffect(() => {
        if (scope === 'all') return
        if (!scopes.some(([name]) => name === scope)) setScope('all')
      }, [scopes, scope])

      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase()
        return rows.filter(rule =>
          (family === 'all' || familyOf(rule.name) === family) &&
          (scope === 'all' || scopeKeyOf(rule) === scope) &&
          (needle === '' || rule.name.toLowerCase().includes(needle) ||
            (rule.description ?? '').toLowerCase().includes(needle) ||
            (rule.path ?? '').toLowerCase().includes(needle)))
      }, [rows, family, scope, query])

      /**
       * How long a write waits before the page stops waiting.
       *
       * A dropped connection leaves the Remote retrying, so the promise never
       * settles: nothing rejects, nothing renders, and `busy` stays pinned true
       * so every control is disabled for the life of the page. That is the exact
       * shape of "the button does nothing", so the wait needs a bound.
       */
      const WRITE_TIMEOUT_MS = 20000

      /** Settle `promise`, or reject once `ms` has passed. */
      function withinTimeout(promise, ms) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timedOut')), ms)
          promise.then(
            value => { clearTimeout(timer); resolve(value) },
            failure => { clearTimeout(timer); reject(failure) },
          )
        })
      }

      /**
       * Run one Remote write, and never leave the page latched.
       *
       * A Remote call can throw synchronously — the gateway validates every
       * inbound argument with the client-contributed codec before it opens a
       * request, and `writeRule` takes two of them — or never settle at all when
       * the connection drops. Either way an unguarded call skips its `finally`,
       * pins the control disabled, and leaves an empty panel with no message.
       * Every write here goes through this one wrapper so the next editor does
       * not re-invent the hole.
       *
       * @param invoke - performs the call; may throw synchronously.
       * @param options - how to report, and what to do on success.
       * @param options.t - translator for the timeout message.
       * @param options.onError - receives a message for every failure mode.
       * @param options.onOk - receives the unwrapped payload on success.
       * @param options.onDone - always runs, so the caller can clear busy.
       */
      function runWrite(invoke, options) {
        let call
        try {
          call = withinTimeout(Promise.resolve(invoke()), WRITE_TIMEOUT_MS)
        } catch (failure) {
          options.onError(failure instanceof Error ? failure.message : String(failure))
          options.onDone()
          return
        }
        call.then(
          envelope => {
            const outcome = unwrap(envelope)
            // Only `setDisabled`, `openWorkspace` and `writeRule` carry their own
            // `ok`; the audit report does not, and judging it on `ok` would
            // reject every successful read.
            if (outcome && outcome.ok === true) options.onOk(outcome)
            else options.onError(outcome?.guidance ?? options.t('writeFailed'))
          },
          failure => options.onError(
            failure instanceof Error && failure.message === 'timedOut'
              ? options.t('writeTimedOut')
              : failure instanceof Error ? failure.message : String(failure),
          ),
        ).finally(options.onDone)
      }

      /**
       * Replace the whole disabled set through the Host's settings service.
       *
       * Deliberately not the page's configuration form: that form only exists
       * on the keyed `plugins.row.config` page, so depending on it made every
       * write fail anywhere else. The Host owns the profile patch either way.
       *
       * Declared before `toggleOne`: a `useCallback` dependency array is
       * evaluated where it is written, so referencing `apply` from one declared
       * above it reads an uninitialised binding.
       */
      /**
       * Edit one rule's source file in place.
       *
       * The Host resolves the file from the rule's own name, so the editor can
       * only ever reach the file that rule was discovered in. The path is shown
       * before anything is written, because this is the reader's project and a
       * save overwrites it.
       */
      const [editing, setEditing] = useState(undefined)
      const [draft, setDraft] = useState('')
      const [saving, setSaving] = useState(false)
      const [saved, setSaved] = useState(undefined)

      const openEditor = useCallback(name => {
        setError(undefined)
        setSaved(undefined)
        let call
        try {
          call = Promise.resolve(ctx.remote.dshRules.readRule(name))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return
        }
        call.then(
          envelope => {
            // Refused rather than rejected, so the guidance arrives intact.
            const outcome = unwrap(envelope)
            if (outcome?.ok !== true) { setError(outcome?.guidance ?? t('readRuleFailed', { name })); return }
            if (!outcome.file.editable) { setError(`${name} ${t('shippedWithPlugin')}`); return }
            setEditing({ name, path: outcome.file.path })
            setDraft(outcome.file.content)
          },
          failure => setError(failure instanceof Error ? failure.message : String(failure)),
        )
      }, [ctx, t])

      const saveEditor = useCallback(() => {
        if (editing === undefined) return
        setSaving(true)
        const name = editing.name
        runWrite(() => ctx.remote.dshRules.writeRule(name, draft), {
          t,
          onOk: () => {
            // Scoped to the editor this save was started from. Closing or
            // confirming against whatever is current when the write lands would
            // discard an unrelated editor's unsaved draft and report success
            // for a rule the reader never saved.
            setEditing(current => (current === undefined || current.name !== name ? current : undefined))
            setError(undefined)
            setSaved(current => (current === undefined || current === name ? name : current))
            refresh()
          },
          onError: setError,
          onDone: () => setSaving(false),
        })
      }, [ctx, editing, draft, refresh, t])

      const apply = useCallback(next => {
        setBusy(true)
        setError(undefined)
        runWrite(() => ctx.remote.dshRules.setDisabled(next), {
          t,
          onOk: () => refresh(),
          onError: setError,
          onDone: () => { setBusy(false); setSelected([]) },
        })
      }, [ctx, refresh, t])

      /** Flip one rule, for the per-row switch. */
      const toggleOne = useCallback(name => {
        apply(off.has(name) ? [...off].filter(entry => entry !== name) : [...off, name].sort())
      }, [off, apply])

      /**
       * Set or clear one rule's interrupt-mode override, for the per-row mode
       * selector.
       *
       * Goes through the same wrapper as every other write, and reads the
       * report back afterwards rather than patching the row: the Host has
       * already applied the change to the report it serves, and a selector
       * optimistically showing a mode the write refused would be a lie.
       */
      const chooseMode = useCallback((name, mode) => {
        setBusy(true)
        setError(undefined)
        runWrite(() => ctx.remote.dshRules.setMode(name, mode), {
          t,
          onOk: () => refresh(),
          onError: setError,
          onDone: () => setBusy(false),
        })
      }, [ctx, refresh, t])

      // The checkbox selects; the bulk bar acts. Overloading one control with
      // "click to toggle, click again to select" made the counters lie.
      const toggleSelect = useCallback(name => {
        setSelected(current => current.includes(name) ? current.filter(entry => entry !== name) : [...current, name])
      }, [])

      const chosen = selected.filter(name => visible.some(rule => rule.name === name))
      const allChosen = visible.length > 0 && chosen.length === visible.length

      return h('section', { style: styles.section, 'data-dsh-rules': 'bundled' },
        // A modal, not a panel at the bottom of the list: with 46 rules the
        // editor sat thousands of pixels below the row that opened it, so
        // opening one meant scrolling to find it. Rendered here because this is
        // the component that owns the editor's state.
        editing !== undefined && h(RuleEditorModal, {
          editing, draft, setDraft, saving, saveEditor, error, setError,
          onCancel: () => { setEditing(undefined); setError(undefined) },
          t,
        }),
        h('div', { style: styles.header },
          h('h3', { style: styles.title }, t('togglesTitle')),
          // In force, not merely unlisted: with `ttsr.builtinRules: false` every
          // bundled rule is off for a reason the reader did not choose, and
          // "27 of 27 on" over that list is a lie about their own settings.
          h('span', { style: styles.count }, t('togglesOn', {
            on: rows.filter(rule => rule.active === true).length,
            total: rows.length,
          }))),
        h('p', { style: styles.hint }, t('togglesHint')),
        h('div', { style: styles.toolbar },
          h('span', { style: styles.chip(family === 'all'), onClick: () => setFamily('all') }, `${t('filterAll')} ${rows.length}`),
          ...families.map(([name, count]) => h('span', {
            key: name, style: styles.chip(family === name), onClick: () => setFamily(name),
          }, `${name} ${count}`))),
        // Its own row: these answer a different question from the prefixes, and
        // running the two together on one line made the row unreadable.
        h('div', { style: styles.toolbar },
          h('span', { style: styles.filterLabel }, t('filtersByScope')),
          h('span', { style: styles.chip(scope === 'all'), onClick: () => setScope('all') },
            `${t('filterAllScopes')} ${rows.length}`),
          ...scopes.map(([name, count]) => h('span', {
            key: `scope:${name}`,
            style: styles.chip(scope === name),
            onClick: () => setScope(name),
          }, `${scopeLabel(name, t)} ${count}`))),
        h('input', {
          style: styles.search, type: 'search', value: query, placeholder: t('bundledFilter'),
          onChange: event => setQuery(event.target.value),
        }),
        h('div', { style: styles.bulk },
          h('button', {
            type: 'button', style: styles.button,
            onClick: () => setSelected(allChosen ? [] : visible.map(rule => rule.name)),
          }, allChosen ? t('clearSelection') : t('selectAllN', { count: visible.length })),
          h('button', {
            type: 'button', style: styles.button, disabled: chosen.length === 0,
            onClick: () => toggleSelect(visible.map(rule => rule.name)),
          }, t('invertSelection', { count: chosen.length })),
          h('button', {
            type: 'button', style: styles.button, disabled: chosen.length === 0 || busy,
            onClick: () => apply([...new Set([...off, ...chosen])].sort()),
          }, t('disableSelected', { count: chosen.length })),
          h('button', {
            type: 'button', style: styles.button, disabled: chosen.length === 0 || busy,
            onClick: () => apply([...new Set([...off].filter(name => !chosen.includes(name)))].sort()),
          }, t('enableSelected', { count: chosen.length }))),
        // Without this, an empty intersection looks identical to a hung audit:
        // no rows, and a header still counting rules that are not on screen.
        visible.length === 0 && h('p', { style: styles.hint }, t('noMatch')),
        h('div', { style: styles.list, 'data-dsh-rules': 'list' }, visible.map(rule =>
          h(RuleLine, {
            key: rule.name,
            rule: {
              name: rule.name,
              // The row carries the rule's own provenance: a project rule used
              // to be relabelled as `builtin-defaults` here, which hid both its
              // origin and the project it came from.
              provider: rule.provider,
              path: rule.path,
              scope: rule.scope,
              triggers: rule.triggers,
              interruptMode: rule.interruptMode,
              ownInterruptMode: rule.ownInterruptMode,
              modeOverride: rule.modeOverride,
              // The row states what the Host reported, which is not the same
              // thing as membership of the user's own list: a shadowed or
              // triggerless rule is off for a reason the reader never chose,
              // and calling it `disabled` there read as "you turned this off".
              active: rule.reason === undefined,
              description: rule.description,
              reason: rule.reason,
            },
            t,
            locale,
            checkbox: true,
            switchable: true,
            checked: selected.includes(rule.name),
            busy,
            onSelect: toggleSelect,
            onSwitch: toggleOne,
            onMode: chooseMode,
            onEdit: rule.provider === 'builtin-defaults' ? undefined : () => openEditor(rule.name),
          }))),
        saved !== undefined && h('p', { style: styles.hint }, t('savedRule', { name: saved })),
        error !== undefined && h('p', { style: styles.error }, error))
    }

    /**
     * The rule editor, as a modal over the page.
     *
     * The form is the point: a raw textarea of the whole `.md` file is the file,
     * not an editor, and reading the source tells the reader nothing about what
     * `condition` or `interruptMode` mean. Raw mode stays available for anyone
     * pasting a whole rule or handing it to another model.
     */
    function RuleEditorModal(props) {
      // `setError` is passed in from the section that owns the state and is not
      // in scope in this module: `rewrite` calls it when the serialiser refuses,
      // and without it in this list the one handler standing between a partial
      // write and the page is itself a ReferenceError.
      const { editing, draft, setDraft, saving, saveEditor, error, setError, onCancel, t } = props
      // Parsing is deferred to the module when it lands; until then the modal
      // still renders, in raw mode, rather than refusing to open.
      const module = require('./frontmatter.js')
      const parsed = module.parseRuleFile(draft)
      // The gate. A form save rewrites the file, so the form is only offered
      // when it provably reproduces it byte for byte — otherwise a save quietly
      // reformats the reader's hand-written quoting and comma-separated lists.
      // Measured on the bundled rules, parsing and re-serialising is
      // *semantically* lossless but not byte-identical, so without this check
      // every project rule would be rewritten on save.
      // The original frontmatter lines come along so untouched fields — and any
      // key the form does not know, such as one the author added for their own
      // tools — are emitted verbatim. Without them the gate failed for every
      // hand-written file and the form was unreachable in practice.
      const faithful = parsed.ok
        && module.serialiseRuleFile(parsed.fields, parsed.body, parsed.frontmatterLines) === draft
      const [mode, setMode] = useState(faithful ? 'form' : 'raw')

      const fields = faithful ? parsed.fields : undefined
      const body = faithful ? parsed.body : draft

      // `serialiseRuleFile` throws on purpose — a partial write is the failure
      // this module exists to prevent — so every call through the UI is guarded.
      // An escape here would blank the modal mid-edit, taking the reader's
      // unsaved draft with it.
      const rewrite = (nextFields, nextBody, frontmatterLines) => {
        try {
          setDraft(require('./frontmatter.js').serialiseRuleFile(nextFields, nextBody, frontmatterLines))
          return null
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure)
          setError(message)
          return message
        }
      }

      /**
       * Set a field, or drop it entirely when the value is `undefined`.
       *
       * "Dropped" has to mean the key is absent. Building the next object by
       * spreading and assigning `undefined` leaves the key present, and the
       * serializer then reads it as dropped while rewriting a block that already
       * had it, meets the same key again when writing fields the original file
       * did not have, and refuses — a text field has no undefined form. One
       * place decides this so every caller is covered.
       */
      const setField = (key, value) => {
        const next = { ...fields }
        if (value === undefined) delete next[key]
        else next[key] = value
        rewrite(next, body, parsed.frontmatterLines)
      }

      const specs = require('./frontmatter.js').FIELD_SPECS
      // Written out rather than derived from the field name: the page reads in
      // the reader's language, and a computed key would be invisible to the
      // locale-coverage guard that catches a missing translation.
      const HELP_KEY = {
        description: 'helpDescription',
        alwaysApply: 'helpAlwaysApply',
        globs: 'helpGlobs',
        condition: 'helpCondition',
        astCondition: 'helpAstCondition',
        question: 'helpQuestion',
        agents: 'helpAgents',
        scope: 'helpScope',
        interruptMode: 'helpInterruptMode',
        ttsr_trigger: 'helpTtsr_trigger',
        ttsrTrigger: 'helpTtsr_trigger',
        name: 'helpName',
      }
      const helpKeyFor = key => HELP_KEY[key] ?? 'helpUnknownField'

      return h('div', {
        style: styles.modalBackdrop,
        'data-dsh-rules': 'editor',
        onClick: event => { if (event.target === event.currentTarget) onCancel() },
      },
        h('div', { style: styles.modal, role: 'dialog', 'aria-modal': 'true' },
          h('div', { style: styles.header },
            h('h4', { style: styles.title }, t('editingRule', { name: editing.name })),
            h('div', { style: styles.editorTabs },
              faithful && h('button', {
                type: 'button', style: styles.chip(mode === 'form'),
                onClick: () => setMode('form'),
              }, t('modeForm')),
              h('button', {
                type: 'button', style: styles.chip(mode === 'raw'),
                onClick: () => setMode('raw'),
              }, t('modeRaw')))),
          h('p', { style: styles.code }, editing.path),
          h('p', { style: styles.hint }, t('editorIntro')),
          // Says which of the two reasons applies: the parser refused, or the
          // round trip would reformat the file.
          !faithful && h('p', { style: styles.hint }, t(
            'formUnavailable',
            { reason: parsed.ok ? t('formWouldReformat') : parsed.reason },
          )),
          mode === 'form' && faithful
            ? h('div', { style: styles.form },
              specs.map(spec => h('label', { key: spec.key, style: styles.field },
                h('span', { style: styles.fieldName }, spec.key),
                h('span', { style: styles.fieldHelp }, t(helpKeyFor(spec.key))),
                spec.kind === 'bool'
                  ? h('input', {
                    style: styles.rowCheck, type: 'checkbox',
                    checked: fields[spec.key] === true,
                    onChange: event => setField(spec.key, event.target.checked),
                  })
                  : spec.kind === 'lines'
                    ? h('textarea', {
                      style: styles.fieldLines,
                      spellCheck: false,
                      value: Array.isArray(fields[spec.key]) ? fields[spec.key].join('\n') : '',
                      placeholder: t('onePerLine'),
                      onChange: event => setField(
                        spec.key,
                        event.target.value.split('\n').map(line => line.trim()).filter(line => line !== ''),
                      ),
                    })
                    // A field with a fixed vocabulary gets a select. As a free
                    // text box it invited typos, and a misspelled `interruptMode`
                    // is not rejected — it falls back to the default, which is the
                    // most aggressive value, so a rule written to stay quiet
                    // ends up the one that interrupts everything.
                    : spec.options !== undefined
                      ? h('select', {
                        style: styles.fieldInput,
                        value: typeof fields[spec.key] === 'string' ? fields[spec.key] : '',
                        onChange: event => setField(spec.key, event.target.value === '' ? undefined : event.target.value),
                      }, [
                        // An absent value is not the same as an empty one: it is
                        // what lets the rule inherit the profile default, so the
                        // blank option must stay selectable and must serialise to
                        // nothing rather than to an empty string.
                        h('option', { key: '', value: '' }, t('fieldUnset')),
                        ...spec.options.map(option =>
                          h('option', { key: option, value: option }, option)),
                      ])
                      : h('input', {
                        style: styles.fieldInput, type: 'text',
                        value: typeof fields[spec.key] === 'string' ? fields[spec.key] : '',
                        onChange: event => setField(spec.key, event.target.value),
                      }))),
              h('label', { style: styles.field },
                h('span', { style: styles.fieldName }, t('fieldBody')),
                h('span', { style: styles.fieldHelp }, t('helpBody')),
                h('textarea', {
                  style: styles.editorArea,
                  spellCheck: false,
                  value: body,
                  onChange: event => { rewrite(fields, event.target.value, parsed.frontmatterLines) },
                })))
            : h('textarea', {
              style: styles.editorArea,
              spellCheck: false,
              value: draft,
              onChange: event => setDraft(event.target.value),
            }),
          h('div', { style: styles.editorActions },
            h('button', {
              // Disabled while saving: cancelling mid-write would read as an
              // abort while the file is still overwritten behind the reader.
              type: 'button', style: styles.button, disabled: saving,
              onClick: onCancel,
            }, t('cancelEdit')),
            h('button', {
              type: 'button', style: styles.button, disabled: saving,
              onClick: saveEditor,
            }, t('saveRule'))),
          error !== undefined && h('p', { style: styles.error }, error)))
    }

    /** The audit panel: where the rules came from, why each is in force, and the toggles. */
    function RulesSection(props) {
      // The hook runs before the subject check: returning early would make the
      // hook count depend on the page, which React rejects outright.
      const locale = useLocale(props.ctx)
      const t = translator(locale)
      // `settings.plugins.tab` entries carry no subject — that slot is a page of
      // its own, not a view of one plugin row — so the subject check applies
      // only where a subject exists. Without this the panel would render on the
      // Plugins page and be absent from the tab a reader actually navigates to.
      if (props.subject !== undefined && !ownsSubject(props.subject)) return null
      return h(React.Fragment, null,
        h(RuleAudit, { ctx: props.ctx, report: props.report, workspaces: props.workspaces }),
        // The keyed `plugins.row.config` slot belongs to the platform's own form
        // for this entry; taking it would strand every other setting, so the
        // toggles ride here on the detail page instead.
        h(BundledRuleToggles, { ctx: props.ctx, report: props.report }),
        h('section', { style: styles.section, 'data-dsh-rules': 'detail' },
          h('h3', { style: styles.title }, t('sourcesTitle')),
          h('p', { style: styles.hint },
            t('sourcesBody'),
            ' ',
            h('code', { style: styles.code }, t('codeOmpRules')),
            ' ',
            // Copy, not a comparison against the Chinese string: reading the
            // locale off the translated text meant any edit to that one line
            // silently put an English "and" in the middle of a Chinese sentence.
            t('sourcesAnd'),
            ' ',
            h('code', { style: styles.code }, t('codeOmpRoot')),
            // The sentence promises user rules and named none, so a reader had
            // nowhere to put their own `.md` files.
            ' · ',
            h('code', { style: styles.code }, t('codeUserRules')),
            '. ',
            t('sourcesNote'))))
    }

    // The host keys the client plugin by its package name, so this is the scoped
    // name rather than the row id the loader envelope above uses.
    exports.name = PACKAGE_NAME
    exports.inject = ['slots', 'remote', 'locale']

    /**
     * Mount this plugin's Remote namespace, then register both page
     * contributions. The namespace is mounted here rather than declared in
     * `inject` because only this plugin contributes it; `locale` is declared so
     * the page follows Settings → Language without a switch of its own.
     *
     * @param ctx - client root context.
     */
    exports.apply = async function apply(ctx) {
      const disposeRemote = await ctx.remote.$mount(RULES_REMOTE)
      try {
        await ctx.inject(['remote.dshRules', 'locale'], root => {
          root.slots.inject('plugins.detail.section', () => root.slots.register(
            { name: 'plugins.detail.section', id: 'dsh-rules' },
            props => RulesSection({ ...props, ctx: root })))
          // The same panel on the Settings page, which is where a reader goes
          // to configure a plugin. `settings.plugins.tab` is a tab inside the
          // Plugins section rather than a top-level navigation entry, and it is
          // where the host puts its own read-only plugin inventory — so this is
          // the same shape the platform already expects. `order` places it after
          // the host's own tab. `locale` is a registrant-scoped namespace under
          // `settings.`, following the host's `settings.pluginInventory`
          // convention rather than naming the section itself.
          root.slots.inject('settings.plugins.tab', () => root.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'dsh-rules',
              order: 50,
              label: () => translator(localeNow(root))('togglesTitle'),
              locale: 'settings.dshRules',
            },
            props => RulesSection({ ...props, ctx: root })))
        })
      } catch (error) {
        await disposeRemote()
        throw error
      }
      return disposeRemote
    }

    return module.exports
  },
})
