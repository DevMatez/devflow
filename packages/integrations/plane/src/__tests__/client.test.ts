import { describe, expect, it, vi } from 'vitest';
import { createPlaneClient, PlaneApiError } from '../client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createPlaneClient', () => {
  it('sends the X-API-Key header and returns parsed JSON on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createPlaneClient({ apiToken: 'test-token', fetch: fetchImpl });

    const result = await client.get<{ id: string }>('/api/v1/workspaces/acme/');

    expect(result).toEqual({ id: '1' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.plane.so/api/v1/workspaces/acme/',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'X-API-Key': 'test-token' }),
      }),
    );
  });

  it('uses a custom baseUrl when provided (self-hosted instances)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = createPlaneClient({
      apiToken: 'test-token',
      baseUrl: 'https://plane.internal.example.com',
      fetch: fetchImpl,
    });

    await client.get('/api/v1/workspaces/acme/');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://plane.internal.example.com/api/v1/workspaces/acme/',
      expect.anything(),
    );
  });

  it('sends a JSON body on post/patch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }, 201));
    const client = createPlaneClient({ apiToken: 'test-token', fetch: fetchImpl });

    await client.post('/api/v1/workspaces/acme/projects/1/work-items/', { name: 'Test' });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Test' }),
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
      }),
    );
  });

  it('returns undefined for a 204 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createPlaneClient({ apiToken: 'test-token', fetch: fetchImpl });

    const result = await client.get('/api/v1/workspaces/acme/projects/1/');
    expect(result).toBeUndefined();
  });

  it('throws PlaneApiError with the status on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));
    const client = createPlaneClient({ apiToken: 'test-token', fetch: fetchImpl });

    await expect(client.get('/api/v1/workspaces/missing/')).rejects.toThrow(PlaneApiError);
    await expect(client.get('/api/v1/workspaces/missing/')).rejects.toMatchObject({ status: 404 });
  });
});
