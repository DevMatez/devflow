import type { IntegrationCategory } from '@devflow/types';

/** Not load-bearing yet (MVP adapters implement their full port) — declared now so the shape exists for P3's second-adapter-per-category. */
export interface ProviderCapabilities {
  category: IntegrationCategory;
  provider: string;
  supports: Record<string, boolean>;
}
