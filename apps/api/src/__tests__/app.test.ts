import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp } from '../app';

describe('app', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 404 for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

    expect(res.statusCode).toBe(404);
  });

  it('serves the OpenAPI spec with documented paths and tags', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(res.statusCode).toBe(200);

    const spec = res.json();
    expect(spec.paths['/api/v1/health']).toBeDefined();
    expect(spec.tags.map((t: { name: string }) => t.name)).toContain('Health');
  });
});
