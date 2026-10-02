/**
 * Hand-authored Typert manifest for this package's host face.
 *
 * dsh can generate this file, but the generator resolves packages through a
 * workspace root's `packages/` directory, which a standalone plugin is not.
 * `typert-loader` validates whatever the `./typert` export carries at boot, so
 * the manifest is written here in the shape it checks for: `package`, `face`,
 * `schemas`, a `model` object with `services`/`events`/`objects`, and
 * `invocations` describing each wire call.
 */

import { z } from 'zod'

/** A strict codec entry, as the gateway validates it. */
interface StrictCodec {
  mode: 'strict'
  typeSymbol: string
  schema: z.ZodType
  create: () => z.ZodType
}

const strictCodec = (name: string, schema: z.ZodType): StrictCodec => ({
  mode: 'strict',
  typeSymbol: `dsh-rules#${name}`,
  schema,
  create: () => schema,
})

const stringArray = z.array(z.string())
const workspaceSchema = z.object({ id: z.string(), path: z.string(), title: z.string() })
const ruleSourceFileSchema = z.object({
  name: z.string(),
  path: z.string(),
  content: z.string(),
  editable: z.boolean(),
})
const reportSchema = z.object({
  cwd: z.string(),
  rulebook: stringArray,
  alwaysApply: stringArray,
  ttsr: stringArray,
  rules: z.array(z.object({
    name: z.string(),
    provider: z.string(),
    path: z.string(),
    scope: z.string().optional(),
    active: z.boolean(),
    reason: z.string().optional(),
    description: z.string().optional(),
    globs: stringArray.optional(),
    interruptMode: z.string().optional(),
    triggers: stringArray,
  })),
  warnings: stringArray,
  // The codec is the whole contract: a field missing here is stripped by the
  // gateway before the browser ever sees the report.
  triggered: z.record(z.string(), z.number()),
  // The gateway validates against this schema, so a field missing here is
  // stripped before the browser ever sees the report.
  stale: z.object({ cwd: z.string() }).optional(),
})
const toggleSchema = z.object({
  ok: z.boolean(),
  guidance: z.string().optional(),
  disabled: stringArray,
})

const reportCodec = strictCodec('RuleAuditReport', reportSchema)
const toggleCodec = strictCodec('ToggleResult', toggleSchema)
const ruleNamesCodec = strictCodec('RuleNames', z.array(z.string()).max(64))

export const TYPERT = {
  package: 'dsh-rules',
  face: 'host',
  schemas: [],
  model: {
    services: [
      {
        key: 'dshRules',
        exportName: 'dshRules',
        summary: 'The rule audit surface the browser settings page reads.',
        description: 'Reports what the latest discovery pass found and toggles bundled rules.',
        jsDoc: '/** Rule audit surface for the Plugins page. */',
        tags: [],
        members: [
          { name: 'audit', signature: 'audit(): RuleAuditReport', kind: 'method', summary: 'Every discovered rule, whether it is in force, and why an inactive one is not.' },
          { name: 'setDisabled', signature: 'setDisabled(names: string[]): Promise<ToggleResult>', kind: 'method', summary: 'Replace the disabled set for every discovered rule, persisting it to the profile.' },
          { name: 'toggleable', signature: 'toggleable: readonly string[]', kind: 'property', summary: 'Rule names the page may toggle: everything the current report knows.' },
          { name: 'readRule', signature: 'readRule(name: string): Promise<ReadRuleResult>', kind: 'method', summary: 'One rule\'s backing file, for the page editor.' },
          { name: 'writeRule', signature: 'writeRule(name: string, content: string): Promise<ToggleResult>', kind: 'method', summary: 'Overwrite one rule\'s backing file.' },
          { name: 'listWorkspaces', signature: 'listWorkspaces(): WorkspaceRef[]', kind: 'method', summary: 'Registered workspaces the page may audit.' },
          { name: 'openWorkspace', signature: 'openWorkspace(path: string): Promise<ToggleResult>', kind: 'method', summary: 'Audit one workspace by absolute path; an empty path clears back to no workspace.' },
          { name: 'closeWorkspace', signature: 'closeWorkspace(): void', kind: 'method', summary: 'Stop auditing, returning the page to its no-workspace state.' },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: [
    {
      id: 'dsh-rules#dshRules/audit',
      service: 'dshRules',
      namespace: 'dshRules',
      method: 'audit',
      invocation: { kind: 'direct' },
      parameters: [],
      result: reportCodec,
    },
    {
      id: 'dsh-rules#dshRules/setDisabled',
      service: 'dshRules',
      namespace: 'dshRules',
      method: 'setDisabled',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'names', wire: 'names', source: 'json', codec: ruleNamesCodec },
      ],
      result: toggleCodec,
    },
    {
      id: 'dsh-rules#dshRules/readRule',
      service: 'dshRules',
      namespace: 'dshRules',
      method: 'readRule',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'name', wire: 'name', source: 'json', codec: strictCodec('RuleName', z.string().min(1)) },
      ],
      result: strictCodec('ReadRuleResult', z.object({
        ok: z.boolean(),
        file: ruleSourceFileSchema.optional(),
        guidance: z.string().optional(),
      })),
    },
    {
      id: 'dsh-rules#dshRules/writeRule',
      service: 'dshRules',
      namespace: 'dshRules',
      method: 'writeRule',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'name', wire: 'name', source: 'json', codec: strictCodec('RuleName', z.string().min(1)) },
        { name: 'content', wire: 'content', source: 'json', codec: strictCodec('RuleBody', z.string()) },
      ],
      result: toggleCodec,
    },
    {
      id: 'dsh-rules#dshRules/listWorkspaces',
      service: 'dshRules',
      namespace: 'dshRules',
      method: 'listWorkspaces',
      invocation: { kind: 'direct' },
      parameters: [],
      result: strictCodec('WorkspaceList', z.array(workspaceSchema)),
    },
    {
      id: 'dsh-rules#dshRules/openWorkspace',
      service: 'dshRules',
      namespace: 'dshRules',
      method: 'openWorkspace',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'path', wire: 'path', source: 'json', codec: strictCodec('WorkspacePath', z.string()) },
      ],
      result: toggleCodec,
    },
    {
      id: 'dsh-rules#dshRules/closeWorkspace',
      service: 'dshRules',
      namespace: 'dshRules',
      method: 'closeWorkspace',
      invocation: { kind: 'direct' },
      parameters: [],
      result: strictCodec('Nothing', z.undefined()),
    },
  ],
}

export default TYPERT
