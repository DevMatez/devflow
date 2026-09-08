import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

export interface GithubAppClientOptions {
  appId: string;
  privateKey: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface GithubInstallationAccount {
  installationId: string;
  accountLogin: string;
  accountAvatarUrl: string | null;
}

/** App-level (JWT) client — no installation id yet, used only by the connect callback (design doc §5). */
export function createGithubAppClient(options: GithubAppClientOptions) {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: options.appId, privateKey: options.privateKey },
    ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
  });

  return {
    async getInstallation(installationId: string): Promise<GithubInstallationAccount> {
      const { data } = await octokit.apps.getInstallation({
        installation_id: Number(installationId),
      });
      const account = data.account as { login?: string; slug?: string; avatar_url?: string } | null;

      return {
        installationId: String(data.id),
        accountLogin: account?.login ?? account?.slug ?? 'unknown',
        accountAvatarUrl: account?.avatar_url ?? null,
      };
    },
  };
}
