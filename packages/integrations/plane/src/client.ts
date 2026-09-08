const DEFAULT_BASE_URL = 'https://api.plane.so';

export interface PlaneClientOptions {
  apiToken: string;
  /** Plane Cloud by default; self-hosted instances use their own domain. */
  baseUrl?: string;
  /** Injected for tests (matches the codebase's fetchImpl DI convention); defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export class PlaneApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thin fetch wrapper — Plane has no official Node SDK, so this is the entire "vendor client" surface. */
export function createPlaneClient(options: PlaneClientOptions) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = options.fetch ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'X-API-Key': options.apiToken,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PlaneApiError(
        res.status,
        `Plane API ${method} ${path} failed (${res.status}): ${text}`,
      );
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  };
}

export type PlaneClient = ReturnType<typeof createPlaneClient>;
