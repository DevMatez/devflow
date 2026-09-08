export interface HealthSnapshot {
  uptime: number;
  timestamp: string;
}

/**
 * Data access layer for health. Returns process/runtime info today; will also
 * probe downstream dependencies (DB, Redis) as they are wired in.
 */
export function readHealthSnapshot(): HealthSnapshot {
  return {
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}
