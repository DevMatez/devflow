import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Test files share one live Postgres/Redis (buildApp() runs real
    // migrations on boot); running them in parallel processes races on
    // schema creation, so keep them sequential.
    fileParallelism: false,
  },
});
