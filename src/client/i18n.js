/**
 * Localized copy for the browser half.
 *
 * dsh ships a locale runtime on the client (`ctx.locale`) that tracks the
 * active language and notifies on change, so the page follows
 * Settings → Language instead of carrying its own switch. English is the
 * fallback and the key source; Chinese is the translation.
 */

export const COPY = {
  en: {
    auditTitle: 'Rule audit',
    workspaceNone: 'Choose a workspace',
    workspaceOpen: 'Audit it',
    workspaceClose: 'Close',
    openFailed: 'could not audit that workspace',
    deliveriesHere: 'deliveries here',
    deliveredElsewhere: 'delivered elsewhere',
    neverFired: 'never fired',
    chartSource: 'Where rules come from',
    chartDistribution: 'Delivery distribution',
    chartDelivered: 'Delivery detail ({{count}} rules)',
    distributionNote: 'Each figure counts rules, not deliveries.',
    bucketNeverFired: 'never fired',
    bucketOnce: '1 time',
    bucketTwice: '2 times',
    bucketThrice: '3 times',
    bucketFourPlus: '4 or more',
    triggerRuleCount: '{{with}} of {{total}} rules name a trigger',
    noDelivered: 'No rule has been delivered to the model yet.',
    noTrigger: 'No rule declares a trigger.',
    reading: 'Reading the rule report…',
    noMatch: 'No rule matched this filter.',
    staleWorkspace: 'These numbers described {{cwd}}, which no longer exists on this machine.',
    staleHint: 'Run a session in a workspace you still have, and the audit rebuilds for it.',
    readFailed: 'Could not read the rule report: {{reason}}',
    readFailedShort: 'Could not read the rule report',
    deliveryNote: 'A delivery is one rule reaching the model: an interrupt, a reminder folded into a tool result, a denied call, or a judged warning.',
    deliveryNoteScoped: 'Counts cover every session run against this dsh profile.',
    deliveryNoteElsewhere: '"Delivered elsewhere" counts rules this workspace has not discovered; the ledger is shared across every workspace on this profile.',
    filterAll: 'All',
    togglesTitle: 'Rule management',
    filtersByScope: 'Workspace',
    filterAllScopes: 'All',
    scopeBuiltin: 'Bundled with the plugin',
    scopeUser: 'User directory',
    auditOfCwd: 'Auditing',
    editRule: 'Edit',
    saveRule: 'Save',
    cancelEdit: 'Cancel',
    editorIntro: 'Edits are written straight to the file this rule was read from.',
    savedRule: 'Saved {{name}}.',
    readRuleFailed: 'Could not read {{name}}.',
    shippedWithPlugin: 'ships with the plugin and has no file to edit.',
    editingRule: 'Editing {{name}}',
    modeForm: 'Form',
    modeRaw: 'Raw file',
    formUnavailable: 'Stays in raw mode: {{reason}}.',
    formWouldReformat: 'the form would reformat this file, so editing it here could quietly rewrite how you wrote it',
    onePerLine: 'One per line',
    fieldUnset: '(not set — use the profile default)',
    fieldBody: 'body',
    helpBody: 'The text the model reads. Say what to do and why, not just what is true.',
    helpDescription: 'One line describing the rule. Shown wherever the rule is listed.',
    helpCondition: 'When this rule applies, as a regular expression matched against the file being worked on.',
    helpAstCondition: 'Same idea, but matched against the code structure with ast-grep, so it survives renaming.',
    helpQuestion: 'Ask the model this before the rule fires, to decide whether it should.',
    helpScope: 'File types this rule applies to, as globs such as **/*.ts.',
    helpGlobs: 'Where this rule applies, as globs, if the rule is file-sensitive rather than universal.',
    helpAgents: 'Only apply this rule to the named agent roles.',
    helpAlwaysApply: 'Put the whole rule in the system prompt every turn, instead of delivering it on demand.',
    helpInterruptMode: 'never: never interrupt output. prose-only: only as prose. tool-only: only into tool results. always: may cut the stream mid-output.',
    helpTtsr_trigger: 'The older spellings of Triggers, which OMP still reads: the rule fires as soon as one of the lines matches. Rewrite the field as condition when you next save.',
    helpUnknownField: 'No description is registered for this field.',
    helpName: 'The rule\'s name. Leave as it is unless you are deliberately shadowing another rule.',
    togglesHint: 'Tick the rules you want to change, then use the buttons below. Changes save to this profile and apply on the next step.',
    noWorkspace: 'No workspace is open, so there is nothing to audit yet. Open one below to load its rules.',
    noWorkspacesRegistered: 'This profile has no workspaces yet. Type a directory path to audit it anyway.',
    workspacePathPlaceholder: 'Directory path',
    togglesOn: '{{on}} of {{total}} on',
    bundledFilter: 'Filter rules',
    selectAllN: 'Select all {{count}}',
    clearSelection: 'Clear selection',
    invertSelection: 'Invert selection ({{count}})',
    disableSelected: 'Disable {{count}} selected',
    enableSelected: 'Enable {{count}} selected',
    writeFailed: 'the host refused the change',
    writeTimedOut: 'the host did not answer in time, so nothing was saved. Check the connection and try again.',
    on: 'on',
    off: 'off',
    selectHint: 'Select for the bulk buttons below',
    enableHint: 'Turn this rule on',
    disableHint: 'Turn this rule off',
    inForceState: 'in force',
    offState: 'off · {{reason}}',
    modeFollow: 'Follow the profile default',
    modeFollowsRule: 'Follow the rule ({{mode}})',
    modeHint: 'When this rule may interrupt the model. Saved to this profile, not to the rule\'s file, so it reaches rules that ship with the plugin and have no file at all.',
    reasonUnknown: 'unknown',
    sourcesTitle: 'Where rules come from',
    sourcesBody: 'Project and user rules come from',
    sourcesAnd: 'and',
    sourcesNote: 'The model loads any rule body on demand, and the rule tool reports the same list in conversation.',
    codeOmpRules: '.omp/rules/',
    codeOmpRoot: '.omp/RULES.md',
    codeUserRules: '~/.omp/agent/rules/',
    reasonDisabled: 'listed in ttsr.disabledRules',
    reasonBuiltinsOff: 'bundled rules are disabled by ttsr.builtinRules',
    reasonAgentFilter: 'its agents filter does not match this session',
    reasonNoTrigger: 'it declares no trigger, no alwaysApply, and no description',
    reasonShadowed: 'shadowed by a higher-priority rule of the same name',
  },
  zh: {
    auditTitle: '规则审计',
    workspaceNone: '选择一个工作区',
    workspaceOpen: '审计它',
    workspaceClose: '关闭',
    openFailed: '无法审计该工作区',
    deliveriesHere: '本工作区投递',
    deliveredElsewhere: '其他工作区投递',
    neverFired: '从未触发',
    chartSource: '规则来源',
    chartDistribution: '投递分布',
    chartDelivered: '投递明细（{{count}} 条规则）',
    distributionNote: '图例里的数字是规则条数，不是投递次数。',
    bucketNeverFired: '从未触发',
    bucketOnce: '1 次',
    bucketTwice: '2 次',
    bucketThrice: '3 次',
    bucketFourPlus: '4 次以上',
    triggerRuleCount: '{{total}} 条中有 {{with}} 条声明了触发条件',
    noDelivered: '还没有任何规则被投递到模型。',
    noTrigger: '没有任何规则声明触发条件。',
    reading: '正在读取规则报告…',
    noMatch: '没有规则匹配当前筛选。',
    staleWorkspace: '这些数字描述的是 {{cwd}}，该目录在本机已不存在。',
    staleHint: '在一个仍然存在的工作区里跑一次会话，审计会按它重建。',
    readFailed: '无法读取规则报告：{{reason}}',
    readFailedShort: '无法读取规则报告',
    deliveryNote: '一次投递是指一条规则真正到达模型：一次中断、一条折进工具结果的提醒、一次被拒的调用，或一条判定警告。',
    deliveryNoteScoped: '统计覆盖该 dsh profile 上运行过的所有会话。',
    deliveryNoteElsewhere: '「其他工作区投递」统计的是本工作区未发现的规则；计数账本在该 profile 的所有工作区之间共享。',
    filterAll: '全部',
    togglesTitle: '规则管理',
    filtersByScope: '工作区',
    filterAllScopes: '全部',
    scopeBuiltin: '插件自带',
    scopeUser: '用户目录',
    auditOfCwd: '正在审计',
    editRule: '编辑',
    saveRule: '保存',
    cancelEdit: '取消',
    editorIntro: '改动会直接写回这条规则被读取的那个文件。',
    savedRule: '已保存 {{name}}。',
    readRuleFailed: '无法读取 {{name}}。',
    shippedWithPlugin: '随插件自带，没有文件可编辑。',
    editingRule: '正在编辑 {{name}}',
    modeForm: '表单',
    modeRaw: '原始文件',
    formUnavailable: '保持原始模式：{{reason}}。',
    formWouldReformat: '用表单保存会重排这个文件的写法',
    onePerLine: '每行一条',
    fieldUnset: '（不设置 — 用 profile 的默认值）',
    fieldBody: '正文',
    helpBody: '模型会读到的正文。写清楚该做什么、为什么，而不只是事实。',
    helpDescription: '一句话描述这条规则。会显示在所有规则列表里。',
    helpCondition: '这条规则何时生效：正则表达式，匹配正在改动的文件。',
    helpAstCondition: '同样的意思，但用 ast-grep 匹配代码结构，重命名后依然有效。',
    helpQuestion: '规则生效前先问模型这个问题，由它的回答决定是否生效。',
    helpScope: '这条规则适用的文件类型，glob 写法，例如 **/*.ts。',
    helpGlobs: '规则作用范围，glob 写法；用于对文件敏感的规则。',
    helpAgents: '只对指定角色的 agent 生效。',
    helpAlwaysApply: '每轮都把整条规则放进系统提示，而不是按需投递。',
    helpInterruptMode: 'never 从不打断输出；prose-only 只以文字提醒；tool-only 只写进工具结果；always 可以在输出中途截断。',
    helpTtsr_trigger: 'Triggers 的旧拼写，OMP 仍然会读取：其中任何一行匹配，规则就会触发。下次保存时把这个字段改写为 condition。',
    helpUnknownField: '这个字段还没有对应的说明。',
    helpName: '规则名称。除非你有意覆盖另一条同名规则，否则不要改。',
    togglesHint: '勾选要改动的规则，再用下面的按钮批量应用。改动保存到该 profile，并在下一步生效。',
    noWorkspace: '当前没有打开工作区，还没有可审计的内容。在下面选一个来载入它的规则。',
    noWorkspacesRegistered: '这个 profile 还没有工作区。直接填目录路径也能审计。',
    workspacePathPlaceholder: '目录路径',
    togglesOn: '{{on}} / {{total}} 条启用',
    bundledFilter: '筛选规则',
    selectAllN: '全选 {{count}} 条',
    clearSelection: '清除选择',
    invertSelection: '反选（{{count}}）',
    disableSelected: '停用选中的 {{count}} 条',
    enableSelected: '启用选中的 {{count}} 条',
    writeFailed: '宿主拒绝了这次改动',
    writeTimedOut: '宿主没有在超时前响应，改动未保存。请检查连接后重试。',
    on: '启用',
    off: '停用',
    selectHint: '选中以用于下方批量按钮',
    enableHint: '启用这条规则',
    disableHint: '停用这条规则',
    inForceState: '生效中',
    offState: '已停用 · {{reason}}',
    modeFollow: '跟随 profile 默认值',
    modeFollowsRule: '跟随规则自身（{{mode}}）',
    modeHint: '这条规则什么时候可以打断模型。保存到这个 profile，而不是规则文件——因此对随插件自带、根本没有文件的规则同样有效。',
    reasonUnknown: '原因未知',
    sourcesTitle: '规则从哪里来',
    sourcesBody: '项目与用户规则来自',
    sourcesAnd: '与',
    sourcesNote: '模型按需加载规则正文，rule 工具会在对话里给出同一份清单。',
    codeOmpRules: '.omp/rules/',
    codeOmpRoot: '.omp/RULES.md',
    codeUserRules: '~/.omp/agent/rules/',
    reasonDisabled: '已列在 ttsr.disabledRules 中',
    reasonBuiltinsOff: '内置规则已被 ttsr.builtinRules 整体关闭',
    reasonAgentFilter: '它的 agents 过滤条件与本会话不匹配',
    reasonNoTrigger: '既没有触发条件，也没有 alwaysApply 或 description',
    reasonShadowed: '被同名的更高优先级规则遮蔽',
  },
}

/** Replace `{{name}}` placeholders. */
function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? ''))
}

/**
 * Build a translator for one locale id.
 *
 * Chinese falls back to English key by key, so a missing translation degrades to
 * a readable string rather than a raw key.
 */
export function translator(locale) {
  const id = String(locale ?? 'en')
  const primary = COPY[id.startsWith('zh') ? 'zh' : 'en']
  const fallback = COPY.en
  return (key, values) => fill(primary[key] ?? fallback[key] ?? key, values ?? {})
}

/** Source labels in the page's own words, per locale. */
export const SOURCE_LABEL = {
  en: {
    'builtin-defaults': 'Bundled with the plugin',
    native: '.omp/rules',
    'omp-plugins': 'Plugin rules',
    agents: '.agent / .agents',
    cursor: 'Cursor',
    windsurf: 'Windsurf',
    cline: 'Cline',
    github: 'GitHub instructions',
  },
  zh: {
    'builtin-defaults': '插件自带',
    native: '.omp/rules',
    'omp-plugins': '插件提供的规则',
    agents: '.agent / .agents',
    cursor: 'Cursor',
    windsurf: 'Windsurf',
    cline: 'Cline',
    github: 'GitHub instructions',
  },
}

/**
 * Map a host reason code to its copy key.
 *
 * The Host sends codes, not prose, so the page renders the reason in the
 * reader's language. An unknown code is shown verbatim rather than flattened
 * into "unknown", because a new code should be visible, not hidden.
 */
export const REASON_KEY = {
  disabled: 'reasonDisabled',
  'builtins-off': 'reasonBuiltinsOff',
  'agent-filter': 'reasonAgentFilter',
  'no-trigger': 'reasonNoTrigger',
  shadowed: 'reasonShadowed',
}

/** The provider id behind a source label, for one locale. */
/**
 * Name a rule's origin.
 *
 * The provider alone cannot do it: every project on disk keeps its rules in
 * `.omp/rules`, so two projects produce two buckets with the same label and
 * nothing on screen says which is which. A rule carrying a `scope` — the
 * directory it was discovered under — is prefixed with it.
 *
 * @param locale - active locale.
 * @param provider - discovery provider id.
 * @param scope - the tree's own name, when the rule carries one.
 * @returns a label that distinguishes projects from each other.
 */
export function sourceLabel(locale, provider, scope) {
  const table = String(locale ?? '').startsWith('zh') ? SOURCE_LABEL.zh : SOURCE_LABEL.en
  const base = table[provider] ?? provider
  return scope === undefined || scope === '' ? base : `${scope} · ${base}`
}
