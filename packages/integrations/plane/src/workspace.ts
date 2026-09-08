import { createPlaneClient, type PlaneClientOptions } from './client';

export interface PlaneWorkspace {
  id: string;
  slug: string;
  name: string;
}

/** Validates the token and resolves the workspace UUID (connect flow only, design doc §6). */
export async function fetchPlaneWorkspace(
  options: PlaneClientOptions,
  workspaceSlug: string,
): Promise<PlaneWorkspace> {
  const client = createPlaneClient(options);
  return client.get<PlaneWorkspace>(`/api/v1/workspaces/${workspaceSlug}/`);
}
