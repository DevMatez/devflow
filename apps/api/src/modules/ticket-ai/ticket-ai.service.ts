import { z } from 'zod';
import type { AiProvider } from '@devflow/ai';

export const ticketDraftSchema = z.object({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
});
export type TicketDraft = z.infer<typeof ticketDraftSchema>;

const DRAFT_MAX_OUTPUT_TOKENS = 4_000;

const TICKET_INSTRUCTIONS = `You help software teams write clear, actionable tickets for DevFlow, a developer workflow platform.

A good ticket has:
- title: a short imperative summary (under 80 characters), no ticket key or prefix.
- description: Markdown. State the problem or goal and the relevant context, then the intended change. Keep it concise; do not invent requirements, systems, or numbers the request doesn't support — when something important is unknown, say so as an open question at the end.
- acceptanceCriteria: 2–7 independently checkable statements of done, each one sentence.

Respond with the JSON object described by the schema.`;

/**
 * Ticket AI (design §4): returns a draft to the caller and persists nothing.
 * The human edits it and submits the existing create-work-item endpoint —
 * the only path that ever writes to the PM tool.
 */
export async function generateTicketDraft(
  ai: AiProvider,
  input: { prompt: string; projectName?: string },
): Promise<TicketDraft> {
  const context = input.projectName ? `Project: ${input.projectName}\n\n` : '';
  const result = await ai.generateStructuredOutput({
    capability: 'ticket-draft',
    schema: ticketDraftSchema,
    schemaName: 'ticket_draft',
    instructions: TICKET_INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content: `${context}Write a ticket for this request:\n\n${input.prompt}`,
      },
    ],
    maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
  });
  return result.output;
}

/** Tighten/expand an existing draft per the user's instructions. Persists nothing. */
export async function improveTicketDraft(
  ai: AiProvider,
  input: { draft: TicketDraft; instructions?: string },
): Promise<TicketDraft> {
  const ask = input.instructions
    ? `Revise it as follows: ${input.instructions}`
    : 'Improve it: make the title sharper, the description clearer, and the acceptance criteria specific and checkable. Keep the original intent.';
  const result = await ai.generateStructuredOutput({
    capability: 'ticket-draft',
    schema: ticketDraftSchema,
    schemaName: 'ticket_draft',
    instructions: TICKET_INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content: `Here is a ticket draft as JSON:\n\n${JSON.stringify(input.draft, null, 2)}\n\n${ask}`,
      },
    ],
    maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
  });
  return result.output;
}
