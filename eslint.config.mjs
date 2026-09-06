import baseConfig from '@devflow/eslint-config/base';

/**
 * Vendor SDKs may only be imported inside their own adapter package, so vendor
 * types never leak across a port (project.md §8 / wave-2 §11). Each entry maps
 * an adapter package directory to the import patterns it — and only it — may use.
 */
const vendorSdks = {
  github: {
    dir: 'packages/integrations/github',
    patterns: ['@octokit/*', 'octokit'],
  },
  slack: {
    dir: 'packages/integrations/slack',
    patterns: ['@slack/*'],
  },
  calendar: {
    dir: 'packages/integrations/calendar',
    patterns: ['googleapis', 'googleapis/*', 'google-auth-library'],
  },
  plane: {
    dir: 'packages/integrations/plane',
    patterns: ['@makeplane/*'],
  },
};

/** Restricted-import groups for every vendor SDK except the one owned by `allowKey`. */
function restrictionGroups(allowKey) {
  return Object.entries(vendorSdks)
    .filter(([key]) => key !== allowKey)
    .map(([, { dir, patterns }]) => ({
      group: patterns,
      message: `This vendor SDK may only be imported from its adapter package (${dir}); keep vendor types behind the port (project.md §8).`,
    }));
}

const vendorSdkRules = [
  {
    files: ['**/*.{ts,tsx,js,mjs,cts,mts}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: restrictionGroups(null) }],
    },
  },
  ...Object.entries(vendorSdks).map(([key, { dir }]) => ({
    files: [`${dir}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': ['error', { patterns: restrictionGroups(key) }],
    },
  })),
];

export default [
  ...baseConfig,
  ...vendorSdkRules,
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
];
