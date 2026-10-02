/**
 * Lossless frontmatter <-> form-fields conversion for the rule editor.
 *
 * The editor used to hand the whole `.md` file to a textarea. A labelled form is
 * nicer, but it rewrites real files that people hand-edit, so anything the form
 * cannot represent faithfully has to be refused rather than dropped: a silently
 * discarded `scope` or a mangled `condition` regex is worse than no editor at
 * all. Every refusal names the offending key or line so the textarea can stay
 * open with the reason attached.
 *
 * The contract with the caller:
 *
 * - `parseRuleFile` never throws. It returns
 *   `{ok: true, fields, body, frontmatterLines, unknownKeys}` or
 *   `{ok: false, reason}`.
 * - `serialiseRuleFile` THROWS on anything it cannot write back as a file this
 *   parser reads identically — a key in `fields` this editor does not know, a
 *   wrong-typed value, a non-string body, `frontmatterLines` that this parser
 *   did not produce. Callers must wrap it; that is deliberate, because a save
 *   that silently wrote a broken file was the failure mode this module exists
 *   to prevent.
 * - A key the editor does not know is NOT a refusal. `src/frontmatter.ts`, the
 *   module the engine itself reads with, already ignores whatever it does not
 *   recognise, so a rule carrying a field this plugin does not model is a legal
 *   rule; refusing it sent those files to the raw textarea for no reason. Such a
 *   key is carried through `unknownKeys` and written back from
 *   `frontmatterLines` byte for byte.
 * - `serialiseRuleFile(fields, body, parsed.frontmatterLines)` is the lossy-free
 *   path: every original line comes back verbatim unless the caller changed the
 *   value of the field that line holds, and then only that field's own lines
 *   are rewritten. Without `frontmatterLines` the block is normalised on the
 *   way out (comments, blank lines, quoting style and kebab-case spellings are
 *   the author's formatting, not meaning), but no *meaning* changes either way:
 *   the body is byte-identical, and each field keeps its value, its type and
 *   its position.
 *
 * Field coverage mirrors what `src/rule.ts` actually reads. Values follow the
 * engine, not taste: a list field may be written as a comma-separated string
 * (`scope: "tool:edit(*.go), tool:write(*.go)"` is how the bundled rules spell
 * it) and is split with the same brace-aware splitter `rule.ts` uses, so a form
 * edit cannot silently retarget a rule that relied on that spelling.
 */

/** One field the editor renders as a labelled control. */
export const FIELD_SPECS = [
  {
    key: 'description',
    kind: 'text',
    label: 'Description',
    help: 'One line saying what this rule is for; it is shown wherever rules are listed so you can tell them apart.',
  },
  {
    key: 'alwaysApply',
    kind: 'bool',
    label: 'Always apply',
    aliases: ['always-apply'],
    help: 'On means the rule text is added to the model instructions at the start of every session, instead of waiting for a trigger to match.',
  },
  {
    key: 'globs',
    kind: 'lines',
    label: 'File patterns',
    help: 'File patterns such as src/**/*.ts; the rule only applies while the agent is working on files that match one of them.',
  },
  {
    key: 'condition',
    kind: 'lines',
    label: 'Triggers',
    help: 'Patterns checked against the model output as it is written; the rule fires when one of them matches. An entry shaped like a file path, such as src/**/*.ts, counts as a path restriction instead of a pattern.',
  },
  {
    key: 'astCondition',
    kind: 'lines',
    label: 'Code patterns',
    aliases: ['ast-condition'],
    help: 'ast-grep patterns such as new(expr), checked against the code an edit or write tool is about to change.',
  },
  {
    key: 'question',
    kind: 'text',
    label: 'Question',
    help: 'A yes-or-no question asked about the finished answer; the rule fires when the answer is yes.',
  },
  {
    key: 'agents',
    kind: 'lines',
    label: 'Agents',
    help: 'Which agents the rule applies to, by name or by pattern such as {scout,reviewer}; leave empty to let it apply to every agent.',
  },
  {
    key: 'scope',
    kind: 'lines',
    label: 'Watched output',
    help: 'Which parts of the reply the rule watches: text, thinking, tool, or a narrower target such as tool:bash(*.sh).',
  },
  {
    key: 'interruptMode',
    kind: 'text',
    label: 'Interrupt mode',
    aliases: ['interrupt-mode'],
    options: ['never', 'prose-only', 'tool-only', 'always'],
    help: 'How hard the rule hits when it fires: never only records it, prose-only and tool-only limit it to one kind of output, and always stops the stream wherever it matches.',
  },
  {
    key: 'ttsr_trigger',
    kind: 'lines',
    label: 'Triggers (old spelling)',
    deprecated: 'Use condition instead; OMP still reads this spelling.',
    help: 'Older hyphenated spelling of Triggers that OMP still reads, so the form can open a file that uses it; rewrite it as condition when you next save.',
  },
  {
    key: 'ttsrTrigger',
    kind: 'lines',
    label: 'Triggers (old spelling)',
    aliases: ['ttsr-trigger'],
    deprecated: 'Use condition instead; OMP still reads this spelling.',
    help: 'Older camelCase spelling of Triggers that OMP still reads, so the form can open a file that uses it; rewrite it as condition when you next save.',
  },
]

const SPEC_BY_KEY = new Map(FIELD_SPECS.map(spec => [spec.key, spec]))

/** A block whose only content is blank lines: nothing to represent, but legal. */
const EMPTY_BLOCK = /^---[ \t]*\r?\n(?:[ \t]*\r?\n)*---[ \t]*(?:\r?\n([\s\S]*))?$/
/** The closing `---` has to start a line, or a value ending in `---` would close the block. */
const BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\n---[ \t]*(?:\r?\n([\s\S]*))?$/
const OPEN = /^---[ \t]*\r?\n/
const ENTRY = /^([\w-]+)[ \t]*:(.*)$/
const ITEM = /^([ \t]+)-[ \t]*(.*)$/

/** Scalars YAML reads as something other than text, so the form must refuse them. */
const NULL_WORDS = new Set(['null', 'Null', 'NULL', '~'])
const NUMERIC = /^[-+]?(?:\d[\d_]*(?:\.[\d_]*)?(?:[eE][-+]?\d+)?|0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+)$/
const DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ].*)?$/
const FLOAT = /^[-+]?\.(?:inf|Inf|INF|nan|NaN|NAN)$/
const TRUE_WORDS = new Set(['true', 'True', 'TRUE'])
const FALSE_WORDS = new Set(['false', 'False', 'FALSE'])

/** Escapes a double-quoted YAML scalar may carry. */
const ESCAPES = {
  '"': '"',
  "'": "'",
  '\\': '\\',
  '/': '/',
  n: '\n',
  r: '\r',
  t: '\t',
  0: '\0',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  e: '\x1b',
  ' ': ' ',
  N: '\u0085',
  _: '\u00a0',
  L: '\u2028',
  P: '\u2029',
}

/** A refusal raised inside the parser and turned into `{ok: false}` at the edge. */
class Refusal extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

/**
 * Refuse one line, naming it in the reason.
 * @param at - 1-based line number in the document.
 * @param what - what is wrong, naming the key or the offending text.
 */
function refuse(at, what) {
  throw new Refusal(`line ${at}: ${what}`)
}

/** Describe a rejected value for the refusal reason. */
function show(value) {
  return JSON.stringify(value)
}

/**
 * Normalize a key the way `parseFrontmatter` does, so the form writes back the
 * spelling the engine reads.
 * @param key - raw key text from the block.
 * @returns camelCase key.
 */
function normalizeKey(key) {
  return key.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase())
}

/**
 * Split a comma-separated field, leaving commas inside `{…}` or `[…]` alone.
 *
 * The same splitter `rule.ts` applies, so a brace group like
 * `tool:edit(**\/*.{ts,tsx})` keeps its commas and stays one entry.
 * @param value - one field value that the engine treats as a list.
 * @returns the entries, with blank ones dropped.
 */
function splitTopLevel(value) {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
    .map(part => part.trim().replace(/^["']|["']$/g, '').trim())
    .filter(part => part !== '')
}

/**
 * Report whether an unquoted scalar would come back from YAML as a number,
 * boolean, null or date rather than as text.
 * @param value - plain scalar text.
 * @returns the word for the reason, or undefined when it stays text.
 */
function reservedKind(value) {
  if (NULL_WORDS.has(value)) return 'null'
  if (TRUE_WORDS.has(value) || FALSE_WORDS.has(value)) return 'true or false'
  if (NUMERIC.test(value) || FLOAT.test(value)) return 'a number'
  if (DATE.test(value)) return 'a date'
  return undefined
}

/**
 * Read one quoted scalar starting at `start`.
 * @param raw - the whole inline value.
 * @param start - index of the opening quote.
 * @param at - line number, for refusals.
 * @param key - field name, for refusals.
 * @returns the decoded text and the index just past the closing quote.
 */
function scanQuoted(raw, start, at, key) {
  const quote = raw[start]
  let value = ''
  let i = start + 1
  while (i < raw.length) {
    const char = raw[i]
    if (quote === '"' && char === '\\') {
      const code = raw[i + 1]
      if (code === undefined) refuse(at, `field "${key}" ends with a dangling escape`)
      if (code === 'x' || code === 'u' || code === 'U') {
        const width = code === 'x' ? 2 : code === 'u' ? 4 : 8
        const digits = raw.slice(i + 2, i + 2 + width)
        if (digits.length !== width || !/^[\da-fA-F]+$/.test(digits)) {
          refuse(at, `field "${key}" has a malformed \\${code} escape`)
        }
        const point = Number.parseInt(digits, 16)
        if (point > 0x10ffff) refuse(at, `field "${key}" has an out-of-range \\${code} escape`)
        value += String.fromCodePoint(point)
        i += 2 + width
        continue
      }
      if (!Object.prototype.hasOwnProperty.call(ESCAPES, code)) {
        refuse(at, `field "${key}" uses the escape \\${code}, which is not valid YAML`)
      }
      value += ESCAPES[code]
      i += 2
      continue
    }
    if (char === quote) {
      if (quote === "'" && raw[i + 1] === "'") {
        value += "'"
        i += 2
        continue
      }
      return { value, end: i + 1 }
    }
    value += char
    i += 1
  }
  refuse(at, `field "${key}" opens a ${quote} quote that is never closed`)
  return null
}

/**
 * Read a `[a, b]` flow sequence.
 * @param raw - the whole inline value, opening bracket included.
 * @param at - line number, for refusals.
 * @param key - field name, for refusals.
 * @returns the items and the index just past the closing bracket.
 */
function scanFlowSequence(raw, at, key, kind) {
  const items = []
  let i = 1
  let current = ''
  let depth = 0
  let started = false
  while (i < raw.length) {
    const char = raw[i]
    if (char === '[') depth += 1
    if (char === ']') {
      if (depth === 0) {
        if (started) items.push(readFlowItem(current, at, key, kind))
        return { items, end: i + 1 }
      }
      depth -= 1
    }
    if (char === ',' && depth === 0) {
      items.push(readFlowItem(current, at, key, kind))
      current = ''
      started = false
      i += 1
      continue
    }
    current += char
    started = true
    i += 1
  }
  refuse(at, `field "${key}" opens a [ list that is never closed`)
  return null
}

/**
 * Read one entry of a flow sequence as plain text.
 * @param text - the entry text.
 * @param at - line number, for refusals.
 * @param key - field name, for refusals.
 * @param kind - the field's kind, so a switch keeps its reserved words.
 * @returns the entry text.
 */
function readFlowItem(text, at, key, kind) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) refuse(at, `field "${key}" holds a { mapping inside a list, which this editor cannot represent safely`)
  const read = reservedKind(trimmed)
  if (read !== undefined && kind !== 'bool') refuse(at, `a list entry of "${key}" is ${read} rather than text`)
  return trimmed
}

/**
 * Read one inline value: a quoted scalar, a flow sequence, or plain text.
 * @param raw - everything after `key:`.
 * @param at - line number, for refusals.
 * @param key - field name, for refusals.
 * @param kind - the field's kind, so a switch keeps its reserved words.
 * @returns a string, or a string array for a flow sequence.
 */
function readInlineValue(raw, at, key, kind) {
  const text = raw.trim()
  if (text === '') refuse(at, `field "${key}" has no value`)
  if (text.startsWith('&') || text.startsWith('*')) {
    refuse(at, `field "${key}" uses a YAML anchor or alias, which this editor cannot represent safely`)
  }
  if (text.startsWith('!')) refuse(at, `field "${key}" carries a YAML tag, which this editor cannot represent safely`)
  if (text.startsWith('|') || text.startsWith('>')) {
    refuse(at, `field "${key}" is a block scalar (| or >), which this editor cannot represent safely`)
  }
  if (text.startsWith('{')) refuse(at, `field "${key}" is a { mapping}, which this editor cannot represent safely`)
  if (text.startsWith('[')) {
    const scanned = scanFlowSequence(text, at, key, kind)
    if (!trailingIsEmpty(text, scanned.end)) refuse(at, `field "${key}" has text after its closing bracket`)
    return scanned.items
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    const scanned = scanQuoted(text, 0, at, key)
    if (!trailingIsEmpty(text, scanned.end, at, key)) refuse(at, `field "${key}" has text after its closing quote`)
    return scanned.value
  }
  const plain = text.replace(/\s+#.*$/, '').trim()
  if (plain === '') refuse(at, `field "${key}" has no value`)
  const read = reservedKind(plain)
  if (read !== undefined && kind !== 'bool') {
    refuse(at, `field "${key}" reads as ${read}, not as text; quote it in a way YAML keeps as text, or drop the field`)
  }
  return plain
}

/**
 * Report whether only whitespace or a comment follows a scanned scalar.
 * @param text - the whole inline value.
 * @param end - index just past the scalar.
 * @returns true when nothing but a comment is left.
 */
function trailingIsEmpty(text, end) {
  return text.slice(end).trim() === '' || text.slice(end).trim().startsWith('#')
}

/**
 * Read one `- item` line of a block sequence.
 * @param text - everything after the dash.
 * @param at - line number, for refusals.
 * @param key - field name, for refusals.
 * @param kind - the field's kind, so a switch keeps its reserved words.
 * @returns the item text.
 */
function readSequenceItem(text, at, key, kind) {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith('{')) refuse(at, `field "${key}" holds a { mapping} inside a list, which this editor cannot represent safely`)
  if (trimmed.startsWith('[')) refuse(at, `field "${key}" holds a nested [ list, which this editor cannot represent safely`)
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const scanned = scanQuoted(trimmed, 0, at, key)
    if (!trailingIsEmpty(trimmed, scanned.end)) refuse(at, `a list entry of "${key}" has text after its closing quote`)
    return scanned.value
  }
  if (trimmed.includes(': ') || trimmed.endsWith(':')) {
    refuse(at, `field "${key}" holds a nested mapping inside its list, which this editor cannot represent safely`)
  }
  const read = reservedKind(trimmed)
  if (read !== undefined && kind !== 'bool') refuse(at, `a list entry of "${key}" is ${read} rather than text`)
  return trimmed
}

/**
 * Read the whole frontmatter block into form fields.
 *
 * A key the editor does not know is not an error: its line, and any indented
 * lines under it, are carried through untouched for the serialiser to write
 * back verbatim. Everything the form itself has to draw still has to be
 * representable, so a known field keeps all of its refusals.
 * @param block - block text, already newline-normalised.
 * @returns `{fields, unknownKeys, spans, spansByLine}`. The two span maps hold
 *   only what `serialiseRuleFile` needs: where each known field's lines start
 *   and end, so it can copy the rest without re-reading them.
 */
function readBlock(block) {
  const fields = {}
  const firstLineOf = new Map()
  const unknownKeys = []
  const seenUnknown = new Set()
  const spans = new Map()
  const spansByLine = new Map()
  const lines = block.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const at = i + 2
    const bare = line.trim()
    if (bare === '' || bare.startsWith('#')) {
      i += 1
      continue
    }
    if (/^[ \t]/.test(line)) refuse(at, 'this line is indented, so the block holds a nested mapping or list that this editor cannot represent safely')
    const entry = ENTRY.exec(line)
    if (entry === null) refuse(at, `this line is not a "key: value" field (${show(bare)})`)
    const rawKey = entry[1]
    const key = normalizeKey(rawKey)
    const spec = SPEC_BY_KEY.get(key)
    if (spec === undefined) {
      if (!seenUnknown.has(rawKey)) {
        seenUnknown.add(rawKey)
        unknownKeys.push(rawKey)
      }
      i = skipUnknownEntry(lines, i + 1)
      continue
    }
    if (firstLineOf.has(key)) refuse(at, `field "${rawKey}" is set twice (first on line ${firstLineOf.get(key)})`)
    firstLineOf.set(key, at)
    const start = i
    const rest = entry[2]
    let value
    if (rest === undefined || rest.trim() === '' || rest.trim().startsWith('#')) {
      const items = []
      let j = i + 1
      let sawItem = false
      while (j < lines.length) {
        const next = lines[j]
        const nextBare = next.trim()
        if (nextBare === '' || nextBare.startsWith('#')) {
          j += 1
          continue
        }
        const item = ITEM.exec(next)
        if (item === null) break
        items.push(readSequenceItem(item[2], j + 2, key, spec.kind))
        sawItem = true
        j += 1
      }
      if (!sawItem) {
        const next = nextMeaningful(lines, i + 1)
        if (next !== undefined && /^[ \t]/.test(next.line)) {
          refuse(at, `field "${rawKey}" opens an indented block (nested mapping or block scalar), which this editor cannot represent safely`)
        }
        refuse(at, `field "${rawKey}" has no value`)
      }
      value = items
      // The item loop walks past blank and comment lines to reach the next
      // item, so it also walks past the ones that follow the last one. Those
      // are not the field's, and an edit must not take them with it.
      while (j > i + 1 && (lines[j - 1].trim() === '' || lines[j - 1].trim().startsWith('#'))) j -= 1
      i = j
    } else {
      value = readInlineValue(rest, at, key, spec.kind)
      i += 1
    }
    fields[key] = coerce(spec, value, rawKey, at)
    const span = { key, value: fields[key], start, end: i }
    spans.set(key, span)
    spansByLine.set(start, span)
  }
  return { fields, unknownKeys, spans, spansByLine }
}

/**
 * Skip the lines that belong to a key this editor does not know.
 *
 * An indented line after an unknown key belongs to that key, whatever shape it
 * is, and so does a blank line that is itself followed by one: that is what a
 * block scalar with a blank line inside it looks like. Neither is read, so
 * neither can be refused; both come back verbatim.
 * @param lines - block lines.
 * @param from - the first line after the unknown key's own line.
 * @returns the index of the first line that does not belong to it.
 */
function skipUnknownEntry(lines, from) {
  let j = from
  while (j < lines.length) {
    const line = lines[j]
    if (/^[ \t]/.test(line)) {
      j += 1
      continue
    }
    if (line.trim() === '' && j + 1 < lines.length && /^[ \t]/.test(lines[j + 1])) {
      j += 1
      continue
    }
    break
  }
  return j
}

/**
 * Find the next line that carries meaning, skipping blanks and comments.
 * @param lines - block lines.
 * @param from - index to start at.
 * @returns the line and its index, or undefined.
 */
function nextMeaningful(lines, from) {
  for (let i = from; i < lines.length; i += 1) {
    const bare = lines[i].trim()
    if (bare === '' || bare.startsWith('#')) continue
    return { line: lines[i], index: i }
  }
  return undefined
}

/**
 * Fit a parsed value to its field kind, refusing the shapes the form cannot show.
 * @param spec - the field descriptor.
 * @param value - parsed scalar or list.
 * @param rawKey - field name as written.
 * @param at - line number, for refusals.
 * @returns the value the form holds.
 */
function coerce(spec, value, rawKey, at) {
  if (spec.kind === 'bool') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string' && (TRUE_WORDS.has(value) || FALSE_WORDS.has(value))) {
      return TRUE_WORDS.has(value)
    }
    refuse(at, `field "${rawKey}" must be true or false, but is ${show(value)}`)
  }
  if (spec.kind === 'text') {
    if (Array.isArray(value)) refuse(at, `field "${rawKey}" is a list, but it must be a single line of text`)
    return value
  }
  if (Array.isArray(value)) return value
  return splitTopLevel(value)
}

/**
 * Read a rule file into the form's fields plus its untouched body.
 *
 * The raw block lines come back as `frontmatterLines` so `serialiseRuleFile`
 * can write the file back without touching a line the caller did not change —
 * which is the only way an unknown key, a comment or an odd spelling of a key
 * survives an edit to some other field.
 * @param text - the complete `.md` file.
 * @returns `{ok: true, fields, body, frontmatterLines, unknownKeys}`, or
 *   `{ok: false, reason}`.
 */
export function parseRuleFile(text) {
  if (typeof text !== 'string') return { ok: false, reason: `expected the file text, got ${typeof text}` }
  if (!OPEN.test(text)) {
    return { ok: false, reason: 'no frontmatter block: the file has to open with a --- line' }
  }
  const empty = EMPTY_BLOCK.exec(text)
  if (empty !== null) {
    return { ok: true, fields: {}, body: empty[1] ?? '', frontmatterLines: blankLines(text), unknownKeys: [] }
  }
  const matched = BLOCK.exec(text)
  if (matched === null) {
    return { ok: false, reason: 'frontmatter block is never closed: add a --- line after the last field' }
  }
  const raw = matched[1] ?? ''
  const block = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const body = matched[2] ?? ''
  try {
    const read = readBlock(block)
    return {
      ok: true,
      fields: read.fields,
      body,
      frontmatterLines: raw.split('\n'),
      unknownKeys: read.unknownKeys,
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Refusal ? error.reason : `frontmatter could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Report whether a file holds at least one field the form can edit.
 *
 * The editor asks this to decide whether a labelled form is worth opening at
 * all, and it answers from the block's key names alone: a rule carrying nothing
 * but comments, or only keys this editor does not know, has nothing to show, so
 * the raw textarea is the better view and no value is parsed to find that out.
 * @param text - the complete `.md` file.
 * @returns true when the block has a `key:` line naming a known field.
 */
export function hasFields(text) {
  if (typeof text !== 'string' || !OPEN.test(text)) return false
  // An empty block matches EMPTY_BLOCK, whose only group is the body, so it is
  // asked of BLOCK alone: a block with no `key:` line in it holds no fields.
  const matched = BLOCK.exec(text)
  if (matched === null) return false
  for (const line of (matched[1] ?? '').split('\n')) {
    const entry = /^([\w-]+)[ \t]*:/.exec(line)
    if (entry !== null && SPEC_BY_KEY.has(normalizeKey(entry[1]))) return true
  }
  return false
}

/**
 * Collect the blank lines of an otherwise empty frontmatter block.
 * @param text - the complete `.md` file.
 * @returns the lines between the fences.
 */
function blankLines(text) {
  const matched = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  return matched === null ? [] : matched[1].split('\n')
}

/**
 * Characters that force quoting wherever they appear: a comment marker, a key
 * separator, a flow indicator, or anything with a meaning in YAML. Space and
 * `-` are left out: `prose-only` is plain text.
 */
const NEEDS_QUOTING = /[#:,'"[\]{}\|&>!%@`\n\r\t]/

/**
 * Report whether a string can be written as bare text, quotes aside.
 * @param value - the string.
 * @returns true when YAML would read it back identically unquoted.
 */
function isPlainSafe(value) {
  if (value === '' || value !== value.trim()) return false
  if (!/^[\p{L}\p{N}_]/u.test(value)) return false
  if (NEEDS_QUOTING.test(value)) return false
  return reservedKind(value) === undefined
}

/**
 * Write one string as a YAML scalar, quoting only when it has to.
 * @param value - the string.
 * @returns the scalar text.
 */
function quoteScalar(value) {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0)
    if (char === '\\') out += '\\\\'
    else if (char === '"') out += '\\"'
    else if (char === '\n') out += '\\n'
    else if (char === '\t') out += '\\t'
    else if (char === '\r') out += '\\r'
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else if (code === 0x85) out += '\\N'
    else if (code === 0xa0) out += '\\_'
    else if (code === 0x2028) out += '\\L'
    else if (code === 0x2029) out += '\\P'
    else out += char
  }
  return `${out}"`
}

/**
 * Write one string as a YAML scalar.
 * @param value - the string.
 * @returns the scalar text, quoted only when bare text would be read differently.
 */
function scalar(value) {
  return isPlainSafe(value) ? value : quoteScalar(value)
}

/**
 * Describe a value the caller should not have passed, for the thrown message.
 * @param value - the value.
 * @returns a short type description.
 */
function shape(value) {
  if (Array.isArray(value)) return `a list (${value.map(item => (typeof item === 'string' ? show(item) : typeof item)).join(', ')})`
  if (value === null) return 'null'
  if (typeof value === 'string') return show(value)
  return typeof value
}

/**
 * Report whether a form value still holds what the file it came from held.
 * @param left - value the caller passed.
 * @param right - value parsed out of the original block.
 * @returns true when both are the same list or the same scalar.
 */
function sameValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => item === right[index])
  }
  return left === right
}

/**
 * Write the form's fields and body back into a rule file.
 *
 * With `frontmatterLines` — the raw block lines `parseRuleFile` handed back —
 * every line the caller did not touch is written out again byte for byte, in
 * its original position and spelling. Only a field whose value differs from the
 * parsed one is rewritten, and it is rewritten in this module's canonical form.
 * That is what keeps an unknown key, a comment, a blank line or a kebab-case
 * spelling from being rewritten as something else behind the user's back.
 *
 * Without them the block is rebuilt from `fields` alone, which normalises the
 * formatting but loses everything the form does not model.
 *
 * Throws rather than returning a partial result: a save that dropped a field
 * would rewrite the user's file with the rule's scope or triggers missing.
 * @param fields - field values keyed by field name, in the order to write them.
 * @param body - the rule text, written byte for byte.
 * @param frontmatterLines - the block's original lines, between the fences.
 * @returns the complete `.md` file text.
 */
export function serialiseRuleFile(fields, body, frontmatterLines) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError(`serialiseRuleFile: fields must be an object of field values, got ${shape(fields)}`)
  }
  if (typeof body !== 'string') throw new TypeError(`serialiseRuleFile: body must be a string, got ${shape(body)}`)
  if (frontmatterLines === undefined) return writeFields(fields, body)
  if (!Array.isArray(frontmatterLines) || frontmatterLines.some(line => typeof line !== 'string')) {
    throw new TypeError(`serialiseRuleFile: frontmatterLines must be a list of the original block lines, got ${shape(frontmatterLines)}`)
  }
  return writeOriginal(fields, body, frontmatterLines)
}

/**
 * Write a block from scratch, one canonical line per field.
 * @param fields - field values keyed by field name.
 * @param body - the rule text.
 * @returns the complete `.md` file text.
 */
function writeFields(fields, body) {
  const out = []
  for (const key of Object.keys(fields)) out.push(...writeField(key, fields[key]))
  return `---\n${out.length === 0 ? '' : `${out.join('\n')}\n`}---\n${body}`
}

/**
 * Write one field in canonical form, refusing anything the form cannot show.
 * @param key - field name.
 * @param value - the value the caller holds.
 * @returns the block's lines for it, without trailing newline.
 */
function writeField(key, value) {
  const spec = SPEC_BY_KEY.get(key)
  if (spec === undefined) {
    throw new TypeError(`serialiseRuleFile: "${key}" is not a field this editor knows, so a file holding it could not be read back`)
  }
  if (spec.kind === 'bool') {
    if (typeof value !== 'boolean') {
      throw new TypeError(`serialiseRuleFile: "${key}" must be true or false, got ${shape(value)}`)
    }
    return [`${key}: ${value}`]
  }
  if (spec.kind === 'text') {
    if (typeof value !== 'string') {
      throw new TypeError(`serialiseRuleFile: "${key}" must be a single line of text, got ${shape(value)}`)
    }
    return [`${key}: ${scalar(value)}`]
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError(`serialiseRuleFile: "${key}" must be a list of lines, got ${shape(value)}`)
  }
  if (value.length === 0) return [`${key}: []`]
  const out = [`${key}:`]
  for (const item of value) out.push(`  - ${item === '' ? '""' : scalar(item)}`)
  return out
}

/**
 * Write the block back with the caller's edits and everything else untouched.
 * @param fields - field values keyed by field name.
 * @param body - the rule text.
 * @param lines - the original block lines, between the fences.
 * @returns the complete `.md` file text.
 */
function writeOriginal(fields, body, lines) {
  const block = lines.map(line => line.replace(/\r$/, '')).join('\n')
  let spans
  try {
    spans = readBlock(block).spansByLine
  } catch (error) {
    // The lines came from a file this parser accepted, so this cannot happen for
    // a caller that passed what `parseRuleFile` returned. Anything else is a
    // caller error worth naming rather than quietly rewriting.
    throw new TypeError(
      `serialiseRuleFile: frontmatterLines are not the block of a file this editor could read (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  const out = []
  const written = new Set()
  let i = 0
  while (i < lines.length) {
    const span = spans.get(i)
    if (span === undefined) {
      out.push(lines[i])
      i += 1
      continue
    }
    const held = Object.prototype.hasOwnProperty.call(fields, span.key) ? fields[span.key] : undefined
    written.add(span.key)
    if (held === undefined) {
      // The caller dropped the field, so its lines go with it.
      i = span.end
      continue
    }
    if (sameValue(held, span.value)) {
      for (let j = span.start; j < span.end; j += 1) out.push(lines[j])
    } else {
      out.push(...writeField(span.key, held))
    }
    i = span.end
  }
  for (const key of Object.keys(fields)) {
    if (written.has(key)) continue
    for (const line of writeField(key, fields[key])) out.push(line)
  }
  return `---\n${out.length === 0 ? '' : `${out.join('\n')}\n`}---\n${body}`
}
