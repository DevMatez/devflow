const BASE_URL = 'https://slack.com/api';

export interface SlackClientOptions {
  botToken: string;
  /** Injected for tests (matches the codebase's fetchImpl DI convention); defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export class SlackApiError extends Error {
  constructor(public readonly slackError: string) {
    super(`Slack API error: ${slackError}`);
  }
}

interface SlackEnvelope {
  ok: boolean;
  error?: string;
}

/** Thin fetch wrapper over the Slack Web API — every method shares the same {ok, error} envelope. */
export function createSlackClient(options: SlackClientOptions) {
  const doFetch = options.fetch ?? fetch;

  async function call<T extends SlackEnvelope>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const res = await doFetch(`${BASE_URL}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as T;
    if (!data.ok) throw new SlackApiError(data.error ?? 'unknown_error');
    return data;
  }

  return { call };
}

export type SlackClient = ReturnType<typeof createSlackClient>;
