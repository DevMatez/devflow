# Wave 5 — Frontend: architecture & design

**Status:** Draft — for review before implementation
**Scope source:** [`phase-1.md`](../../../phase-1.md) §8 · [`project.md`](../../../project.md) §6, §9, §12
**Builds on:** the Wave 1–4 HTTP API (`apps/api`, OpenAPI at `/docs`), and the scaffold in [`apps/web/README.md`](../README.md).

> **Done when** (from `phase-1.md`): a user completes the full flow in the UI —
> connect tools → create ticket → start work → see branch/PR → view AI review
> → merge → see timeline update live.

This doc follows the same pattern as the Wave 1–4 API docs: settle the
cross-cutting decisions and the gaps first, then slice the build into PRs.

---

## 1. Scope

In scope (`phase-1.md` §8): app shell + auth, integrations settings, developer
dashboard ("My Work"), work items (list, detail, create with AI, start work),
the PR review view (ticket, PR link, AI review findings, rerun), the activity
timeline, and live updates.

Out of scope for Phase 1:

| Item                                                                                   | Why                                                                                                             |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Merging from DevFlow                                                                   | Merge stays in GitHub (gates enforced at the source, `project.md` §3.8). The PR view links out to merge.        |
| Rendering the diff / inline human review                                               | GitHub owns the code-review surface; DevFlow shows its AI findings and links to the PR.                         |
| Org/team admin beyond members + invitations (teams UI, ownership transfer, org delete) | API exists; low value for the end-to-end flow. Add when needed.                                                 |
| Calendar UI                                                                            | The Calendar adapter connects in settings; no Phase 1 surface consumes calendar data yet.                       |
| Design-system package (`packages/ui`)                                                  | Build primitives in `apps/web/components/ui`; extract once a second app needs them (README already plans this). |

---

## 2. API gaps this wave depends on

Reviewing the frontend against the shipped API surfaced gaps. Each is small
and lands as its own API PR **before** the UI that needs it.

| #   | Gap                                                                                                                                                                                              | Needed by                         | Proposal                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **Projects API** — designed in Wave 1 (§5, §7) but never built; no way to create a project, so no way to create a ticket.                                                                        | everything                        | **Done in this PR**: `GET/POST /organizations/:orgId/projects`, `GET/PATCH …/:projectId` (admin+ to write), partial workflow-config merge, `project.*` events, 409 on duplicate slug.                                                                   |
| G2  | **Project → external mapping.** Creating a work item needs a Plane `externalProjectId`; starting work needs a GitHub `repo`. Neither is stored anywhere, so the UI would have to ask every time. | create ticket, start work         | Add optional `pmProjectId` and `defaultRepo` (+ optional `defaultBaseBranch`) to the project (columns, not `workflowConfig` — they are bindings, not policy). The existing endpoints keep accepting explicit values; the UI pre-fills from the project. |
| G3  | **Org-wide "my work items".** `GET …/projects/:projectId/work-items` is per-project; the dashboard needs "assigned to me, across projects".                                                      | dashboard                         | `GET /organizations/:orgId/work-items?assignee=me&workflowState=…` (Viewer+), same response shape.                                                                                                                                                      |
| G4  | **Realtime.** No SSE endpoint and no pub/sub fan-out exist (`project.md` §12).                                                                                                                   | live timeline, live review status | §6 below.                                                                                                                                                                                                                                               |
| G5  | **Picker data from providers** (Plane projects, GitHub repos, Slack channels).                                                                                                                   | project settings                  | `listRepositories`/`listChannels` exist on the ports; expose `GET …/integrations/:category/resources` returning `{ id, name }[]`. Plane needs a `listProjects` port method. Until then the settings form takes typed ids.                               |
| G6  | **CI status on the PR view** (roadmap: "CI/check status on the PR view").                                                                                                                        | PR review view                    | Phase 1: show the `devflow/ai-review` conclusion we own and link to GitHub's checks tab. Pulling third-party check runs is a later addition (needs a `listCheckRuns` port method + reconciliation of `check_run` webhooks, currently ignored).          |

---

## 3. Cross-cutting decisions

### 3.1 Same-origin API via a Next.js rewrite

The API's own defaults already assume this: the GitHub login callback defaults
to `http://localhost:3000/api/v1/auth/github/callback` (the **web** origin).
So `next.config.ts` rewrites `/api/:path*` → `${API_ORIGIN}/api/:path*`, and
the browser only ever talks to the web origin.

- The session cookie (`HttpOnly`, `SameSite=Lax`, set by the API) is then
  first-party; no CORS, no `credentials: 'include'` dance, and SSE works the
  same way.
- `API_ORIGIN` is a **server-side** env var (default `http://localhost:4000`).
  `NEXT_PUBLIC_API_URL` and `getApiBaseUrl()` in the scaffold are removed —
  client code calls relative `/api/v1/...` paths.
- Server Components that need data call the API directly at `API_ORIGIN`,
  forwarding the incoming `cookie` header.

### 3.2 Auth

- `GET /api/v1/auth/session` is the source of truth. `middleware.ts` only
  checks that the session cookie **exists** (cheap redirect to `/login` for
  logged-out users); the `(app)` layout then calls `/auth/session` server-side
  and redirects on 401. A forged/expired cookie therefore never renders data —
  every API call is still authorized by the API.
- Login = a plain link to `/api/v1/auth/github/authorize` (full-page
  navigation, the API sets the CSRF state cookie and redirects). Logout =
  `POST /api/v1/auth/logout` then `router.replace('/login')`.
- After login the API redirects to `/dashboard`; that route resolves the
  user's orgs and redirects to the last-used org (cookie `devflow_org`) or the
  first one, or to `/onboarding` (create an org) when there are none.

### 3.3 Org in the URL

All authenticated routes are under `/o/[orgSlug]/…`. Links are shareable and
the active org is never ambiguous across tabs. The layout resolves
`orgSlug → organization` from `GET /organizations` (already returns slug) and
puts `{ organizationId, role }` into an `OrgContext` React context. API calls
use the id; URLs use the slug.

### 3.4 Data layer

- One typed client, `lib/api/client.ts`: `apiFetch(path, { method, body,
schema })`. It validates every response with the **same Zod schemas the API
  uses** wherever they already live in `@devflow/validation`; feature modules
  define the rest next to their queries. A validation failure is a thrown
  `ApiContractError` (a bug, reported), not a silent `undefined`.
- Errors map to one `ApiError { status, message }`. 401 anywhere → redirect to
  `/login`; 403 → "You don't have access" state; 409 → shown inline (these are
  meaningful: start-work already running, rerun already pending, slug taken).
- TanStack Query keys are always org-scoped:
  `['org', orgId, 'work-items', filters]`, `['org', orgId, 'work-item', id]`,
  `['org', orgId, 'work-item', id, 'activity' | 'ai-reviews']`. Switching org
  can never show cached data from another org.
- Mutations invalidate the narrowest keys; realtime events (§6) invalidate by
  the same keys, so there is one cache-update path, not two.

### 3.5 Permissions in the UI

The org role from `OrgContext` hides actions the API would reject (e.g.
"New project" for developers, "Start work" for viewers), using the same rank
table as `modules/access/org-context.ts`. This is UX only — the API remains
the enforcement point.

### 3.6 Untrusted content

Ticket descriptions, PR titles, and AI findings come from third parties or a
model. Render as text, or as Markdown through a sanitizing renderer with raw
HTML disabled; links get `rel="noopener noreferrer"`. No
`dangerouslySetInnerHTML` anywhere.

---

## 4. Route map

```text
/login                                   GitHub sign-in
/onboarding                              create your first org (no orgs yet)
/invitations/[token]                     accept an invitation (calls the existing accept endpoint)

/o/[orgSlug]/dashboard                   My Work
/o/[orgSlug]/work-items                  list (project + state filters)
/o/[orgSlug]/work-items/new              create (manual or "Draft with AI")
/o/[orgSlug]/work-items/[id]             detail: state, branch/PR, AI reviews, timeline, actions
/o/[orgSlug]/projects                    list + create (admin+)
/o/[orgSlug]/projects/[id]/settings      name/key, Plane project, default repo, workflow config, Slack channel
/o/[orgSlug]/settings/integrations       connect/disconnect + health per category
/o/[orgSlug]/settings/members            members, roles, invitations (admin+)
```

The scaffold's `/reviews` route is dropped: the "PR review experience" is the
review panel on the work-item detail page (one PR per work item in Phase 1),
and the dashboard's "Waiting on review" group is the list view.

---

## 5. Feature modules

Each lives in `modules/<name>/` with its queries, hooks, and components
(README layering rules).

### 5.1 Shell (`components/layout`, `modules/orgs`)

Sidebar nav, org switcher (lists orgs, remembers the choice in
`devflow_org`), user menu (logout). Empty states route to onboarding.

### 5.2 Integrations settings (`modules/integrations`)

Per category (Source control, Project management, Chat, Calendar): provider
name, `status`, `lastSyncedAt`, `lastError`, token expiry, connect/disconnect.

- GitHub / Slack / Calendar: "Connect" navigates to the existing
  `…/install` / `…/authorize` endpoints (full-page redirects; their callbacks
  land back on the API, which redirects to the web app).
- Plane: a form (workspace slug, API token, webhook secret) posting to
  `…/integrations/plane/connect`. The token field is write-only.
- Admin+ only (the list endpoint is admin-only today).

### 5.3 Projects (`modules/projects`)

List, create (name, optional slug/key), and settings: workflow-config fields,
`notificationChannelId`, and — after G2 — Plane project + default repo.

### 5.4 Dashboard — My Work (`modules/dashboard`)

Groups the caller's work items (G3) by what needs doing:

| Group             | Rule                                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| Action required   | `blocked`, or `workflowExecutionStatus = failed`, or latest AI review `failure` |
| In progress       | `in_progress`                                                                   |
| Waiting on review | `in_review` with no blocking AI result                                          |
| Recently shipped  | `done` in the last 14 days                                                      |

(The AI-review condition needs the latest review's conclusion on the list
response — G3 includes `latestAiReview: { status, policyConclusion } | null`.)

### 5.5 Work items (`modules/work-items`)

- **List**: table with project/state filters, link to detail.
- **Create**: form (project, title, description). "Draft with AI" calls
  `…/work-items/draft`, fills the form, and the user edits before submitting
  the existing create endpoint — the AI never creates the ticket (Wave 4 §4).
  "Improve" calls `…/draft/improve` with the current form values. Handles 503
  (AI not configured → hide the AI buttons) and 429/502 inline.
- **Detail**: title, external issue link, state + allowed transitions
  (advance/block/unblock/cancel — mirrors the state machine; invalid ones are
  hidden, a 409 still shows inline), **Start work** (repo/base pre-filled from
  the project), branch + PR links, automation status/error with retry (start
  again resumes a failed run — Wave 3 §4.5).

### 5.6 AI review panel (`modules/ai-reviews`)

On the work-item detail page: latest review first (commit sha, status,
conclusion, summary, findings grouped by severity with file:line, model +
prompt version), older commits collapsed, **Re-run** (Developer+; 409 →
"already running"). Pending reviews show a spinner and update live (§6).
Failed reviews say plainly that the check is neutral and a human review is
needed.

### 5.7 Activity timeline (`modules/activity`)

Per work item, newest first, paginated (`limit`/`offset`). Actor type drives
the icon (user / system / external); reconciliation anomalies are visually
distinct. Live-updating via §6.

---

## 6. Realtime (G4)

`project.md` §12 names the mechanism: Redis pub/sub fan-out on
`org:{id}:events`, delivered to browsers over SSE.

- **Publish**: the outbox relay already sees every committed event. After it
  routes an event, it publishes a **minimal envelope**
  `{ id, type, aggregateId, workItemId?, occurredAt }` to
  `org:{organizationId}:events`. No payloads — the client refetches through
  the normal authorized endpoints, so realtime can never leak data a user
  couldn't read.
- **Subscribe**: `GET /api/v1/organizations/:orgId/events` (Viewer+),
  `text/event-stream`. One Redis subscriber per API process, multiplexed to
  connections in memory; heartbeat comment every 25 s; `retry: 5000`.
- **Client**: one `EventSource` per tab for the active org
  (`useOrgEvents()`), mapping event types → query-key invalidations
  (e.g. `ai.review_completed` → that work item's `ai-reviews` + `activity` +
  dashboard lists). On reconnect it invalidates the org's active queries
  (events missed while disconnected are recovered by refetch, not replay —
  no `Last-Event-ID` store in Phase 1).

---

## 7. Testing

| Layer                    | What                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (Vitest)            | API client (validation, error mapping), dashboard grouping, permission helpers, event → query-key mapping.                                     |
| Component (Vitest + RTL) | Forms (create ticket + AI draft states, Plane connect), AI review panel states, timeline rendering of untrusted text.                          |
| API (existing Vitest)    | Each G-PR ships with route tests, as in Waves 1–4.                                                                                             |
| E2E (Playwright)         | The done-when flow against a real API + Postgres + Redis, with GitHub/Plane/AI behind test doubles (env-selected fake adapters in `apps/api`). |

The E2E double layer is new: a `FAKE_PROVIDERS=1` mode in `apps/api` that
swaps the resolve functions (already injectable everywhere) for in-memory
fakes. It also closes the remaining Phase 1 definition-of-done item (E2E
full-flow test).

---

## 8. Build sequence (PR slicing)

1. **G1 Projects API** — this PR.
2. **Web foundation** — rewrite proxy, API client + error model, auth
   middleware + session guard, `/login`, `/onboarding`, `/o/[orgSlug]` shell
   with org switcher, logout. Removes the placeholder routes.
3. **Projects + integrations UI** — needs G1; G2 lands with it (API + form).
4. **Work items UI** — list, create (+ AI draft), detail, transitions, start
   work. Needs G2.
5. **G3 + dashboard.**
6. **AI review panel + activity timeline** (polling at first).
7. **G4 realtime** — SSE endpoint + relay publish + `useOrgEvents`; switch 6
   from polling to live.
8. **E2E** — fake-provider mode + the full-flow Playwright spec; members/
   invitations UI.

Each step is independently shippable and leaves the app usable.

---

## 9. Open questions

1. **Org in URL by slug (§3.3)?** Proposal: yes, `/o/[orgSlug]`. Alternative:
   id in URL (no lookup, uglier links).
2. **G2 shape** — project columns (`pm_project_id`, `default_repo`,
   `default_base_branch`) as proposed, or a separate
   `project_repositories` table (Wave 1 §5 anticipated one)? Proposal:
   columns now; one repo per project matches Phase 1's one-PR-per-work-item
   model. Revisit with multi-repo projects.
3. **Markdown in ticket descriptions and AI findings** — render (sanitized)
   or plain text for Phase 1? Proposal: sanitized Markdown, raw HTML off.
4. **Styling** — Tailwind + hand-rolled primitives (proposal), or adopt a
   headless kit (Radix) for menus/dialogs/accessibility? Proposal: Radix
   primitives for dialog/dropdown/popover only, styled with Tailwind.

---

## 10. Design-review resolution log

_(to be filled after review)_
