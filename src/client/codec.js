/**
 * Wire codecs for the browser half.
 *
 * The gateway validates every inbound argument with `codec.create().parse(value)`,
 * using the descriptor the *client* contributed — so a placeholder codec does
 * not merely skip validation, it throws `gateway/input-invalid` and the call
 * never leaves the browser. That is why a Remote whose methods take parameters
 * needs a real parser even though the Host keeps validating with zod.
 *
 * zod itself is not reachable from the module loader's platform table, and
 * these wire shapes are small, so each one gets a hand-written parser. The Host
 * still validates the same value with its own schema, so this is the client's
 * half of the boundary, not a replacement for it.
 */

/** Fail with the message the gateway wraps into `gateway/input-invalid`. */
function fail(message) {
  throw new TypeError(message)
}

/**
 * Build a strict codec the gateway can decode with.
 *
 * @param name - stable type symbol, namespaced to this package.
 * @param parse - validates and returns the value.
 */
function strictCodec(name, parse) {
  return {
    mode: 'strict',
    typeSymbol: `dsh-rules#${name}`,
    create: () => ({ parse }),
  }
}

/** Parse a non-empty array of plain strings. */
function parseStringList(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  if (value.length > 64) fail(`${label} accepts at most 64 entries`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) fail(`${label}[${index}] must be a non-empty string`)
    return entry
  })
}

/** Coerce a JSON value to a plain object, or fail. */
function parseObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}

/** The codecs the client contribution declares. */
export const CODECS = {
  /** `setDisabled(names: string[])` argument. */
  ruleNames: () => strictCodec('RuleNames', value => parseStringList(value, 'names')),
  /** `audit()` result. */
  auditReport: () => strictCodec('RuleAuditReport', value => parseObject(value, 'report')),
  /** `setDisabled` / `openWorkspace` result. */
  toggleResult: () => strictCodec('ToggleResult', value => parseObject(value, 'result')),
  /** `listWorkspaces` result: each entry needs at least an id, path and title. */
  workspaceList: () => strictCodec('WorkspaceList', value => {
    if (!Array.isArray(value)) fail('workspaces must be an array')
    return value.map((entry, index) => {
      const row = parseObject(entry, `workspaces[${index}]`)
      for (const field of ['id', 'path', 'title']) {
        if (typeof row[field] !== 'string') fail(`workspaces[${index}].${field} must be a string`)
      }
      return row
    })
  }),
  /** `openWorkspace` argument. */
  workspacePath: () => strictCodec('WorkspacePath', value => {
    if (typeof value !== 'string') fail('path must be a string')
    return value
  }),
  /** `readRule` argument. */
  ruleName: () => strictCodec('RuleName', value => {
    if (typeof value !== 'string' || value.length === 0) fail('name must be a non-empty string')
    return value
  }),
  /** `writeRule` argument: the whole file, frontmatter included. */
  ruleBody: () => strictCodec('RuleBody', value => {
    if (typeof value !== 'string') fail('content must be a string')
    return value
  }),
  /** `readRule` result: refused with guidance, or the file itself. */
  readRuleResult: () => strictCodec('ReadRuleResult', value => {
    const row = parseObject(value, 'read result')
    if (typeof row.ok !== 'boolean') fail('read result ok must be a boolean')
    if (row.ok === false && typeof row.guidance !== 'string') fail('a refusal must carry guidance')
    if (row.ok === true && row.file === undefined) fail('a successful read must carry a file')
    return row
  }),
  /** The backing file a successful `readRule` returns. */
  ruleSourceFile: () => strictCodec('RuleSourceFile', value => {
    const row = parseObject(value, 'rule file')
    for (const field of ['name', 'path', 'content']) {
      if (typeof row[field] !== 'string') fail(`rule file ${field} must be a string`)
    }
    if (typeof row.editable !== 'boolean') fail('rule file editable must be a boolean')
    return row
  }),
  /** A method that returns nothing. */
  nothing: () => strictCodec('Nothing', () => undefined),
}