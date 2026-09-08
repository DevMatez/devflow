/** Base URL for the Devflow API (`apps/api`). Override via `NEXT_PUBLIC_API_URL`. */
export function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
}
