import { type FastifyInstance } from 'fastify';
import { v1Routes } from './v1';

/**
 * Mounts every API version behind its prefix. New versions (v2, ...) are
 * registered here alongside v1 without touching existing versions.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(v1Routes, { prefix: '/api/v1' });
}
