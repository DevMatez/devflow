import { QueryProvider } from '@/lib/providers/query-provider';
import type { ReactNode } from 'react';

export function AppProviders({ children }: { children: ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
