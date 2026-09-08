import { z } from 'zod';

export const githubCallbackQuerySchema = z.object({
  code: z.string().min(1).optional().describe('Authorization code issued by GitHub.'),
  state: z.string().min(1).optional().describe('CSRF state, must match the authorize-step cookie.'),
  error: z.string().optional().describe('Present when the user denies authorization on GitHub.'),
});

export const authSessionResponseSchema = z.object({
  user: z.object({
    id: z.string().describe('Internal user id.'),
    email: z.string().describe("The user's verified primary email."),
    name: z.string().nullable().describe('Display name from GitHub, if set.'),
    avatarUrl: z.string().nullable().describe('Avatar URL from GitHub, if set.'),
  }),
});
