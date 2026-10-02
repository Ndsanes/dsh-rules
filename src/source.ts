/**
 * The plugin's message source.
 *
 * dsh 0.2 has no shared catch-all `plugin` kind: each producer declares its own
 * through `MessageSourceMap`. Both rule deliveries are `instructions`-form
 * context, which is what the transcript renders as plugin-authored guidance
 * rather than a human turn.
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm/message'

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    'dsh-rules': { kind: 'dsh-rules' } & ContextFormed
  }
}

/** Source stamped on every message this plugin delivers to a model. */
export const RULE_MESSAGE_SOURCE = { kind: 'dsh-rules', form: 'instructions' } as const
