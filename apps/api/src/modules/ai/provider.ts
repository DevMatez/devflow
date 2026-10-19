import { createAiProvider, type AiProvider } from '@devflow/ai';
import { env } from '../../config/env';

let cached: AiProvider | null | undefined;

/**
 * The platform-level AI provider (composition edge — the only place env is
 * read for AI). `null` when `ANTHROPIC_API_KEY` is unset: AI features are
 * disabled rather than failing at boot.
 */
export function getPlatformAiProvider(): AiProvider | null {
  if (cached !== undefined) return cached;
  cached = env.ANTHROPIC_API_KEY
    ? createAiProvider({
        provider: 'anthropic',
        apiKey: env.ANTHROPIC_API_KEY,
        capabilities: {
          'code-review': { model: env.AI_CODE_REVIEW_MODEL, effort: env.AI_CODE_REVIEW_EFFORT },
          'ticket-draft': { model: env.AI_TICKET_DRAFT_MODEL, effort: env.AI_TICKET_DRAFT_EFFORT },
        },
      })
    : null;
  return cached;
}
