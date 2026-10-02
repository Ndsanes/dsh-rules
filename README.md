# dsh-rules

[简体中文](README.zh-CN.md)

OMP rules for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Discovers rule files from every convention OMP supports, injects the
always-apply and rulebook layers into the system prompt, lets the model load a
rule body on demand, and enforces **time-traveling stream rules** that interrupt
violating model output mid-turn.

## Install

```bash
dsh plugin --profile <name> add @ndsanes/dsh-rules
```

Then add the row to the profile's `cordis.patch.yml` if it is not already
applied by the package's own bundle patch, and reload the profile.

If the profile already carries this plugin under a different package name — a
stale `link:` dependency or a `dsh.profile.bundles` entry — remove it from
**both** `dependencies` and `dsh.profile.bundles` before adding. The loader
resolves a bundle row by the *current* package name, so a leftover entry points
at a module the profile no longer has, and the boot reports only
`import failed`. Nothing on the plugin side can diagnose that.

## Rule files

A rule is a Markdown file with YAML frontmatter:

```markdown
---
description: Read before writing a database migration.
globs: "Database/**/*.surql"
condition: "DEFINE (FIELD|TABLE|INDEX)"
scope: "tool:edit(*.surql), tool:write(*.surql)"
interruptMode: always
---

The migration body.
```

| Field | Meaning |
|---|---|
| `description` | Required for the rulebook listing. |
| `alwaysApply` | Injects the whole body into the system prompt. |
| `globs` | Path gate; a TTSR rule needs at least one matching candidate path. |
| `condition` | Regex triggers (legacy `ttsr_trigger` also accepted). |
| `astCondition` | ast-grep structural triggers, checked on tool arguments. |
| `question` | Natural-language question answered by a judge model. |
| `scope` | `text`, `thinking`, `tool`, `tool:<name>(<glob)`. |
| `agents` | Agent-name globs; `main` and `sub` are reserved. |
| `interruptMode` | `never` \| `prose-only` \| `tool-only` \| `always`. |

In the rule editor, a field with a fixed vocabulary — `interruptMode` today —
is a dropdown rather than a free text box, so its value cannot be misspelled.
That matters more than a missing menu: an unrecognised `interruptMode` is not
rejected, it falls back to the profile default, and the default is `always` —
so a rule written to stay quiet would otherwise end up interrupting everything.
The dropdown's first option means "inherit the profile default", and choosing it
**removes the line** from the file rather than writing an empty value, which
would parse as unrecognised and land on the same default.

Write regexes with single-quoted YAML scalars. A double-quoted scalar treats
`\s`, `(` and `(`-family sequences as YAML escapes, which makes js-yaml reject
the whole document. The plugin then falls back to reading the block line by line
and recovers the value anyway, so the rule still loads and still matches — but
the recovery cannot unescape a sequence YAML already refused, which is why the
single-quoted form is the one to write.

## Discovery

| Provider | Priority | Sources, most specific first |
|---|---|---|
| `native` | 100 | `<cwd>/.omp/rules/*.md(c)`, `<userRulesDir>/rules/*.md(c)`, sticky `RULES.md` |
| `omp-plugins` | 90 | `rules/` under each configured `pluginRoots` entry |
| `agents` | 70 | `.agent/rules`, `.agents/rules`, project walk then user |
| `cursor` | 50 | `<cwd>/.cursor/rules`, `~/.cursor/rules` |
| `windsurf` | 50 | `<cwd>/.windsurf/rules`, `~/.codeium/windsurf/memories/global_rules.md` |
| `cline` | 40 | nearest `.clinerules`, file or directory |
| `github` | 30 | `.github/instructions/*.instructions.md`, `applyTo` normalized |
| `builtin-defaults` | 1 | OMP's bundled rules, shipped in `src/builtin-rules/` |

Order within a row is load-bearing: identity is the rule name alone and the
merge keeps the first rule to claim it, so a user's `~/.cursor/rules/style.md`
loses to the workspace's `<cwd>/.cursor/rules/style.md` of the same name.

### Bundled rules

`src/builtin-rules/` holds OMP's 27 default rules — TypeScript, Go, and Rust —
verbatim, MIT licensed, under the same names, so a rule file in either harness
overrides the other. They are the source of truth; `pnpm run embed:rules`
inlines them into `src/generated/builtin-rules.ts` because the bundler cannot
import Markdown as text. Every one is a TTSR rule scoped to a file type, and
none of them blocks a write. The Go and Rust rules trigger on regular
expressions over the reconstructed source; the three that rely on `astCondition`
are subject to the grammar limit noted under [Differences from
OMP](#differences-from-omp).

## The Plugins page

`dsh-rules` ships a browser half. The same two sections appear twice: on the
Plugins page under this plugin's own entry, and as a tab under
**Settings → Plugins**, which is where a reader goes to configure a plugin. Both
render the same component; the Settings tab carries no plugin subject, so the
section draws unconditionally there.

The plugin's own configuration — `enabled`, `userRulesDir`, `pluginRoots`,
`copilotInstructionDirs`, and the `ttsr` block — is not drawn by this plugin at
all. The host derives a form from the `Config` schema and renders it against the
profile row id, which is why the switches live in Settings even on a deployment
that never opens this panel.

**Rule audit** — the numbers first, then the detail:

| | |
|---|---|
| Stat row | rules found, in force, switched off, deliveries here, deliveries elsewhere, never fired |
| Proportion | where rules come from, split by source convention |
| Proportion | what is in force |
| Proportion | what makes them fire — `condition`, `ast-grep`, `question` |
| Ranking | the rules delivered to the model most often |

The first three are composition, not ranking: one full-width bar split by share
with a legend beside it. Drawing a separate bar per category was strictly worse
than reading the numbers — the dominant category filled its whole track and the
minor one was a stub, so length carried nothing the label did not. Only the
delivered-rules chart is a ranking, so only that one uses bars. dsh's web client
ships no charting library, and `dsh-usage-chart` — the one community plugin that
draws charts — documents the same conclusion: a self-drawn SVG that matches the
platform's own rendering is smaller and steadier than a vendored library.

Delivery counts are persisted to `$DSH_HOME/dsh-rules/triggers.json`, because a
count held only in memory reads zero in every process that did not itself
deliver a rule — and sessions run in the web app, the CLI, and one-shot runs
alike. A delivery is one rule actually reaching the model: an interrupt, a
reminder folded into a tool result, a denied call, or a judged warning.

The ledger is per profile while the rule set is per workspace, so a count can
name a rule this workspace never discovered. The page keeps the two apart —
`deliveries here` counts only rules on screen, and anything else shows as
`delivered elsewhere` rather than being folded into the workspace's numbers.

Below the charts, the detail list:

| Control | What it does |
|---|---|
| Filter by source | one chip per convention, with counts: `Bundled with the plugin 27`, `.omp/rules 2`, and any other provider the profile contributes |
| Filter by text | matches rule name, description, and source path |
| Per row | name, whether it is in force, its description, and `source · path` |
| Inactive rows | say why — `off · listed in ttsr.disabledRules` — rather than a bare `off` |

The Host sends a stable reason code (`disabled`, `builtins-off`, `agent-filter`,
`no-trigger`, `shadowed`) and the page localizes it; a code the page does not
recognize is shown verbatim rather than flattened into "unknown". The `rule`
tool spells the same codes out in English, because its reader is a model.

**Bundled rules** — the 27 shipped rules, grouped by family (`ts` 13, `go` 8,
`rs` 6`) with a text filter, on the same page below the audit. Each row has its
own on/off switch, which is the direct action; the checkbox beside it only
selects, and the bar below acts on the whole selection at once — `Select all`,
`Invert selection`, `Disable N selected`, `Enable N selected`.

The plugin leaves the keyed `plugins.row.config` slot alone: that is the
platform's own configuration form for this entry, and taking it would strand
every setting that is not a toggle. Reads come from the audit; writes go through
the configuration form, which owns the profile patch. The `ttsr` block is volatile, so a change applies on the next
step rather than the next restart, and the audit rebuilds itself when it sees
the configuration has moved.

The page draws itself from `--dsw-*` tokens rather than importing dsh's client
packages: those are versioned on the client line, and pulling one into a host
package's dependency tree drags a second copy of the session projection along.

## Managing rules

The `rule` tool is the management surface.

| Call | Effect |
|---|---|
| `{"name": "x"}` | Load one rule's body. |
| `{"action": "list"}` | Every rule, its state, and why an inactive one is off. |
| `{"action": "disable", "name": "x"}` | Turn a bundled rule off. |
| `{"action": "enable", "name": "x"}` | Turn a bundled rule back on. |

Toggles are written to the profile patch through the settings service, so they
persist across restarts, and the `ttsr` config block is volatile, so they apply
on the **next step** rather than the next restart. When the deployment has no
settings service, the tool says so and prints the exact YAML to add instead of
claiming a change it did not make.

Only bundled rules are toggleable. A user or project rule is governed by its own
file, and the tool points you at that file rather than editing it for you.

The file-based equivalents are `ttsr.disabledRules` (a list of names) and
`ttsr.builtinRules: false` (all of them).

Identity is the rule name alone, so a name claimed by a higher-priority provider
wins and the loser is dropped. Sticky `RULES.md` files always share the name
`RULES` and are always applied; the user sticky therefore shadows the project
one, and a `rules/RULES.md` shadows both.

## The three layers

1. **rulebook** — `- <name> (<globs>): <description>` in `<domain-rules>`. The
   body costs no resident context; the model loads it by name.
2. **always-apply** — the whole body in `<generic-rules>`.
3. **TTSR** — a rule with any trigger field. It is registered, leaves the other
   two buckets, and is enforced while the model is still writing.

## Addressing a rule

dsh has no internal-URL protocol registry, so the `rule://<name>` address is
served by a model-facing tool. The prompt advertises `rule://<name>`; the model
calls `rule` with that name and receives the Markdown body. An unknown name
answers with the list of addressable rules.

The snapshot covers all three buckets, so a triggered TTSR rule stays
re-readable after it fires.

## Writing a rule

The tool also writes. When the user states a constraint that will still hold
next week, the system prompt tells the model to write it down rather than only
obey it once: call `rule` with `action: "create"`, a name, a `frontmatter`
block and a `body`, and the file lands in whichever directory that scope
resolves to — see below. It joins the audit like any other project rule, so it
can be edited or deleted from the panel.

Three things are refused rather than written:

- **A name that is a path.** The name becomes a filename, so `../`, a path
  separator, a leading dot or a character the filesystem reserves all stop it
  before anything is joined to a path.
- **A name a rule already holds.** Two files claiming one name is a
  configuration that silently applies only one of them.
- **An existing file.** The create is exclusive, checked on disk rather than
  against the discovered set — a rule that failed to parse is absent from that
  set and would otherwise be overwritten without a word.

The result tells the model to report where it wrote, because the file becomes
the user's to review.

### Which directory a rule lands in

Two conventions are in play. OMP keeps project rules in `<cwd>/.omp/rules` and
user rules in `~/.omp/agent/rules`. dsh has no rules directory of its own — it
reads `<cwd>/.dsh/AGENTS.md`, `<cwd>/.dsh/skills` and the matching paths under
`$DSH_HOME`, and nothing rule-shaped — so this plugin defines `<cwd>/.dsh/rules`
and `$DSH_HOME/rules`, following that layout rather than inventing a third one.

The choice is **OMP-first**, per scope:

| Scope | OMP directory | dsh directory |
|---|---|---|
| project | `<cwd>/.omp/rules` | `<cwd>/.dsh/rules` |
| global | `<userRulesDir>/rules` | `$DSH_HOME/rules` |

A scope that already holds at least one rule under OMP keeps receiving OMP
rules; one that holds none gets the dsh path. An existing but *empty* `.omp`
directory does not count — it may belong to an unrelated tool. The two scopes
resolve independently, so an OMP project does not make your global rules OMP.

Both directories are read by discovery, so a rule is governed the same way
wherever it sits.

### Migrating between the two

`rule` with `action: "migrate"` moves every rule from one directory to another.
Two axes are independent, so all four moves are expressible:

| Move | Arguments |
|---|---|
| `.omp` → dsh, same scope | `toConvention: "dsh"` |
| dsh → `.omp`, same scope | `fromConvention: "dsh"`, `toConvention: "omp"` |
| project → global | `toScope: "global"` |
| global → project | `scope: "global"`, `toScope: "project"` |

Both destination arguments are optional and **default to leaving that axis
alone**: omit `toScope` to keep the scope, omit `toConvention` to keep the
convention. A move that changes one axis takes one argument; both can change at
once, which is a real arrangement and works like any other.

A migration is a change of directory, not of meaning: both sides are read by
discovery, so the name, the body and what the rule does are untouched. Three
things are refused rather than guessed:

- **A name already taken at the destination.** Two files claiming one name
  means only one of them applies, and the loser is invisible in the audit, so
  the existing rule wins and the other file stays put.
- **`RULES.md`.** Sticky rules resolve by the directory they sit in, so moving
  the file would silently change which workspace it governs.
- **A same-directory move**, which would otherwise report a file as moved onto
  itself.

Files land by rename where the two paths share a filesystem, and by
copy-then-delete where they do not — a project on an external drive against a
home directory on the internal one fails `EXDEV` otherwise. The source is
removed only after the copy succeeds, so an interrupted move leaves the rules
where they were. Every file is reported afterwards: what moved, and what was
left alone.

## Enforcement

On `agent/assistant-stream`, every text, reasoning, and tool-argument delta is
matched against the eligible rules.

- A match whose `interruptMode` allows it calls
  `agent.cancel({ kind: 'hook', reason }, { keepInbox: true })` immediately,
  then immediately steers the rule body back in, so the next turn the loop runs
  starts with the rule in context.
- A prose match that does not interrupt is delivered as a reminder after the
  assistant message completes.
- A tool match that does not interrupt folds a `<system-reminder>` into that
  call's own result through `tools/post-execute`, ahead of the tool's content
  and preserving it verbatim.
- `tools/pre-execute` denies a call whose reconstructed source violates a rule
  whose interrupt mode covers the tool surface, so a violation never reaches
  the filesystem. A denial spends nothing on the repeat ledger: refusing a
  write is not a delivery, so a `repeatMode: once` rule keeps refusing instead
  of opening on the second attempt.

Tool-supplied paths are matched in every form a rule might have written them:
the literal argument, its workspace-relative form, and its basename. Without
that, a rule scoped to a `Docs` prefix would silently match nothing when a tool
names the file by absolute path.
- `question` rules are asked after an output completes and can only warn.

Defaults match OMP: `interruptMode: always`, `repeatMode: once`,
`repeatGap: 10`, `builtinRules: true`, `contextMode: keep`.

`repeatMode` governs delivery — interrupts, reminders, and judge warnings. A
pre-execute denial is not a delivery and is never suppressed by it.

## Configuration

```yaml
- id: dsh-rules
  name: '@ndsanes/dsh-rules'
  config:
    enabled: true
    userRulesDir: ~/.omp/agent
    pluginRoots: []
    copilotInstructionDirs: []
    ttsr:
      enabled: true
      interruptMode: always
      contextMode: keep
      repeatMode: once
      repeatGap: 10
      builtinRules: true
      disabledRules: []
      judge: auto
      judgeProvider: ''
      judgeModel: ''
```

The three path settings accept a leading `~` and expand it to the user's home
directory before discovery reads them; everything else is taken literally.

## Differences from OMP

- **`rule://` is a tool, not a URL protocol.** dsh has no internal URL registry,
  so the addressing form lives in the `rule` tool contract.
- **Interrupt and reminder deliveries are user-role messages.** dsh composes a
  step's system prompt through the section registry, so a message injected
  mid-turn is model-visible but not system-authoritative. A model asked to
  repeat a forbidden word, then told the rule through a reminder, has been
  observed weighing the two and answering with the forbidden word anyway — that
  is the `interruptMode: never` path behaving as specified, not a failure to
  deliver. Treat the reminder as strong guidance, not as a guarantee.
- **`contextMode: discard` is not implemented.** dsh commits partial assistant
  output durably on abort and offers no way to remove it, so the default is
  `keep` and the interrupted partial message stays in history.
- **The judge is a configured route, not a role.** OMP resolves `judge` to a
  native System One model and reads a probability. Here `judgeProvider` and
  `judgeModel` must both be set; the judge answers YES/NO per question and an
  unparseable answer counts as "not violated".
- **`matcherPaths` / `matcherDigest` do not exist.** Candidate paths come from
  the tool arguments, and the source snapshot from the arguments a write, edit,
  or multi-edit would produce.
- **AST grammars are the bundled ones, and Go/Rust are not among them.**
  `@ast-grep/napi@0.45` ships TypeScript, Tsx, JavaScript, HTML, and CSS only —
  `parse('Go', src)` throws `Go is not supported in napi`, and the plugin does
  not register dynamic languages, so the three bundled Go rules carrying
  `astCondition` (`go-range-int`, `go-bench-loop`, `go-new-expr`) cannot fire
  here. Their patterns are kept on the rule and each one records a warning, so
  they register as streaming rules and explain themselves instead of skipping
  silently; a path whose grammar is unknown is skipped rather than mis-parsed.
  The native addon is loaded on first AST match inside a guard, so a platform
  without a prebuild costs that one surface rather than the plugin's load.
- **Toggles land in the profile patch.** The `rule` tool writes through the
  settings service, so a deployment that does not mount one falls back to
  printed YAML. `settingsNamespace` names the profile row; it defaults to
  `dsh-rules`, matching the shipped `cordis.patch.yml`.
- **Injection state is per session.** Injected rule names are not persisted to
  the session log, so a reload makes a `repeatMode: once` rule eligible again.

## Late mounting

A plugin can mount into a harness whose agents already exist — a web app that
was already running, or a session that outlived a reload. `agent/created` is the
warm path, not the only one: every surface that can name an agent builds that
agent's session on first use, so a pre-existing agent is governed from its next
step rather than running rule-free.

Two consequences worth knowing:

- Prompt assembly and stream frames cannot await discovery, so the very first
  assembly after a late mount renders without the rule layers while the build
  runs. The next assembly includes them.
- `tools/pre-execute` is an async waterfall, so the first tool call waits for
  discovery and is then evaluated against the rules. A violation in that call
  is still blocked.

The `rule` tool distinguishes "still being discovered" from "no rules exist",
so a session that predates the mount says so instead of looking like a broken
rule directory.

## Development

```bash
pnpm install
pnpm test           # vitest
pnpm typecheck
pnpm build          # embed rules, tsc, host bundle, client bundle + loader envelope
pnpm run embed:rules   # after editing anything in src/builtin-rules/
```

`scripts/audit-rules.ts <project>` prints what the plugin parsed from a real
rule set, which is how backward compatibility against an existing `.omp`
directory is checked:

```bash
npx tsx scripts/audit-rules.ts /path/to/project
```

`scripts/render-prompt.ts <project>` mounts the plugin on a real dsh
system-prompt service and prints the prompt the model would receive. It needs
no model call, so it verifies prompt injection on a machine whose provider
cannot be reached:

```bash
npx tsx scripts/render-prompt.ts /path/to/project
```

`scripts/verify-interrupt.sh [dsh-home] [fixture]` runs one prompt twice against
a live dsh — once with a rule that interrupts, once with an identical rule that
only warns — and prints both transcripts so the difference is the evidence. The
fixture is a directory holding `.omp/rules/no-banana.md` and
`.omp/rules/no-banana-quiet.md`; both are parked and restored on every exit
path, so an interrupted run cannot leave it with neither rule:

```bash
scripts/verify-interrupt.sh /path/to/isolated/dsh-home /path/to/fixture
```

`tests/interrupt-loop.spec.ts` runs the same scenario offline: it mounts a real
`AgentLoop`, `SessionStore`, `LlmRuntime`, and tool registry through the dsh test
kit, points them at a scripted adapter that violates a rule on its first reply,
and asserts the abort, the `<system-interrupt>` retry, the `<system-reminder>`
path for `interruptMode: never`, and that `repeatMode: once` spends the rule.

## License

MIT
