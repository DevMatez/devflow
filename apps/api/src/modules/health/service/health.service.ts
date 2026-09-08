import { readHealthSnapshot } from '../dal/health.dal';

export interface HealthResult {
  status: 'ok';
  uptime: number;
  timestamp: string;
}

export function getHealth(): HealthResult {
  const snapshot = readHealthSnapshot();

  return {
    status: 'ok',
    uptime: snapshot.uptime,
    timestamp: snapshot.timestamp,
  };
}
