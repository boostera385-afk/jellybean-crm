<div align="center">

# JellyBean

**Internal lead-operations CRM for home-services lead generation.**

Nextdoor scraping → AI qualification → customer-service pipeline → outcome tracking.

[![CI](https://github.com/boostera385-afk/jellybean-crm/actions/workflows/ci.yml/badge.svg)](https://github.com/boostera385-afk/jellybean-crm/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)

</div>

---

## Table of contents

- [Overview](#overview)
- [How it works](#how-it-works)
- [Roles and access](#roles-and-access)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Scripts](#scripts)
- [Daily tasks](#daily-tasks)
- [Project structure](#project-structure)
- [Database](#database)
- [Edge functions](#edge-functions)
- [Quality gates](#quality-gates)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security model](#security-model)
- [Further documentation](#further-documentation)

---

## Overview

JellyBean is the internal system of record for a home-services lead-generation operation. It ingests
raw demand signals from Nextdoor, uses AI to qualify them, routes qualified leads to a
customer-service pipeline, and records the commercial outcome of every lead.

It is a **private internal tool**. There is no public sign-up UI and no marketing surface — every
account is provisioned by an administrator.

|                    |                                                       |
| ------------------ | ----------------------------------------------------- |
| **Package name**   | `lead-flow-crm` (user-facing name is _JellyBean_)     |
| **Runtime**        | Bun (Node.js ≥ 22 compatible)                         |
| **Frontend**       | React 19 + TanStack Router / TanStack Start (SSR)     |
| **Backend**        | TanStack Start server functions on Nitro              |
| **Database**       | Supabase — PostgreSQL, Auth, Realtime, Storage, Vault |
| **Internal users** | ~9 role-based seats across operations, CS, and admin  |
| **Scale**          | 24 tables, 131 migrations, 22k+ live raw-lead rows    |

---

## How it works

```
 Nextdoor                JellyBean                              Supabase
 ─────────               ─────────                              ─────────
 Chrome extension ──POST──▶ /api/public/nextdoor-leads ──▶ raw_lead_cache
                              │                                  │
                              │  AI classification (OpenAI)      │
                              ▼                                  │
                        Raw Leads review ──▶ qualified_leads ◀──┘
                                                   │
                                     ┌─────────────┴─────────────┐
                                     ▼                           ▼
                              CS Pipeline                 Google Sheets
                        (contact + log outcome)          (Apps Script mirror)
                                     │
                                     ▼
                          Crisp live chat ◀── webhooks ──▶ Crisp
```

### The lead lifecycle

1. **Capture** — a Chrome extension scrapes relevant Nextdoor posts and `POST`s them to
   `/api/public/nextdoor-leads`. Rows land in `raw_lead_cache`.
2. **AI triage** — a processor selects rows and runs AI classification, which marks each post
   `qualified`, `cancelled`, or leaves it for human review. Cancelled posts require a reason.
3. **Qualification** — the processor confirms or overrides the AI decision. Approved rows are
   written to `qualified_leads`; a database trigger auto-routes `assigned_to` from service and
   state assignment rules.
4. **Contact** — the CS team works the CS Pipeline, composes an outreach message (AI-assisted),
   and records the outcome in `cs_status`.
5. **Sync** — every `qualified_leads` change is mirrored to Google Sheets via an Apps Script
   webhook, and the team can continue the conversation over Crisp live chat.

### Key subsystems

| Subsystem         | Entry point                               | Notes                                                |
| ----------------- | ----------------------------------------- | ---------------------------------------------------- |
| Lead ingest       | `src/routes/api.public.nextdoor-leads.ts` | Shared-secret webhook, `timingSafeEqual`             |
| AI classification | `src/lib/raw-leads-ai.functions.ts`       | Batched, schema-validated, frozen prompt             |
| AI rephrasing     | `src/lib/raw-leads-ai.functions.ts`       | Gated behind a `shared_state` toggle, off by default |
| Crisp chat        | `src/lib/crisp.functions.ts`              | Multi-workspace, credentials in Supabase Vault       |
| Google Sheets     | `src/lib/google-sheets-sync.ts`           | 3-tier config cascade, 3.5 s dedupe window           |
| Realtime sync     | `src/hooks/use-realtime-sync.ts`          | Role-scoped subscriptions, 400 ms debounce           |
| Browser profiles  | `src/lib/incogniton.ts`                   | Local Incogniton Bridge on `127.0.0.1:27842`         |
| Attachments       | `src/lib/lead-attachments.tsx`            | 1 h signed URLs from the `lead-attachments` bucket   |

---

## Roles and access

Access is enforced in **four independent layers**: route guards → render gates → server functions
→ Postgres RLS. A UI change alone can never grant access.

### The nine roles

| Role          | Responsibility                                                                         |
| ------------- | -------------------------------------------------------------------------------------- |
| `admin`       | Full access — every page, user management, settings, activity log                      |
| `sub_admin`   | All of `admin` **except** CS Pipeline, Pending Leads, Crisp Chat, and the Activity log |
| `scraping`    | Raw Leads, Browser Profiles                                                            |
| `maturing`    | Raw Leads, Forwarded Leads, Manual Lead submission                                     |
| `cs`          | CS Pipeline, Pending Leads, Crisp Chat                                                 |
| `cs_admin`    | CS Pipeline, Pending Leads, Crisp Chat, Lead Assignment, User management (`cs` only)   |
| `acc_handler` | Map, Browser Profiles, Raw Leads, Forwarded Leads, Manual Lead                         |
| `facebook`    | Submit Lead, Forwarded Leads                                                           |
| `seo`         | Submit Lead, Forwarded Leads                                                           |

Role definitions live in `src/hooks/use-auth.ts:14` (TypeScript) and in the Postgres `app_role`
enum. Navigation is built in `src/components/app-shell.tsx:59`.

### User-management delegation

Managers may only manage users whose role falls under their own:

| Manager     | May manage roles                             |
| ----------- | -------------------------------------------- |
| `admin`     | all eight non-admin roles                    |
| `sub_admin` | `maturing`, `facebook`, `seo`, `acc_handler` |
| `cs_admin`  | `cs`                                         |

Enforced in `src/lib/user-management-permissions.ts` and re-checked server-side by
`requireUserManager` / `requireTargetAccess`.

### Login is two-factor for non-admins

Beyond email/password (username also works, resolved via the `email_for_username` RPC), every
non-admin account must clear a **6-digit access code** before reaching the app — see
`src/components/access-code-gate.tsx`. The code is per-user, regenerable by a manager, and verified
with `verify_my_access_code`.

---

## Tech stack

| Layer                 | Choice                                                                           |
| --------------------- | -------------------------------------------------------------------------------- |
| Language              | TypeScript 5.8 (`strict`)                                                        |
| UI                    | React 19, React 19 DOM                                                           |
| Routing / SSR         | TanStack Router + TanStack Start on Vite 7, server-rendered by Nitro             |
| Server state          | TanStack Query v5 (60 s stale time, 10 min GC)                                   |
| Styling               | Tailwind CSS v4 (CSS-first config in `src/styles.css`), shadcn/ui, Radix, Lucide |
| Backend-as-a-function | Nitro, Cloudflare / Vercel presets                                               |
| Database              | Supabase Postgres + Auth + Realtime + Storage + Vault                            |
| AI                    | OpenAI — `gpt-5.4-nano-2026-03-17` (classification), `gpt-4o-mini` (rephrasing)  |
| Validation            | Zod at every server-function boundary                                            |
| Charts                | Recharts                                                                         |
| Maps                  | Leaflet + React-Leaflet                                                          |
| Media                 | FFmpeg WASM (in-browser video compression), ExcelJS, jsPDF                       |
| Testing               | Vitest 4                                                                         |
| Linting               | ESLint 9 (flat config) + Prettier 3, Prettier enforced via ESLint                |

> AI model identifiers are pinned in code (`raw-leads-ai.functions.ts:56`), **not** read from
> environment variables. `OPENAI_MODEL` in `.env` is currently unused — see
> [Environment variables](#environment-variables).

---

## Quick start

**Prerequisites:** [Bun](https://bun.sh) ≥ 1.0 and a Supabase project. Node.js 22 also works
(`.nvmrc` pins 22).

```bash
# 1. Install dependencies (bunfig.toml enforces a 24 h supply-chain guard)
bun install

# 2. Create your local environment file
cp .env.example .env
#    then fill in SUPABASE_* and OPENAI_API_KEY

# 3. Apply database migrations
supabase db push

# 4. Create the first admin account
#    (only works while the project has zero profiles and zero admins)
#    visit http://localhost:8080/setup

# 5. Run the dev server
bun dev
```

The dev server listens on **port 8080** with `strictPort` enabled — if 8080 is taken, startup fails
rather than silently picking another port. The shared config wrapper
(`@lovable.dev/vite-tanstack-config`) hardcodes this default and reads no `PORT` environment
variable, so to use a different port set `vite.server.port` explicitly in `vite.config.ts`.

### First-run note

`/setup` calls the `bootstrapFirstAdmin` server function, which is deliberately **unauthenticated**.
It is safe only because it hard-fails whenever any `profiles` row or any `admin` role already
exists, and it forces the `admin` role regardless of input. Once your first admin exists, the
`/setup` link disappears from `/login`.

---

## Environment variables

### Browser-exposed (safe to ship to the client)

Only `VITE_`-prefixed variables are inlined into the client bundle. Never place a secret in one.

| Variable                         | Required    | Description                                     |
| -------------------------------- | ----------- | ----------------------------------------------- |
| `VITE_SUPABASE_URL`              | Recommended | Supabase project URL                            |
| `VITE_SUPABASE_PUBLISHABLE_KEY`  | Recommended | Supabase publishable / anon key                 |
| `VITE_SUPABASE_ANON_KEY`         | No          | Legacy alias for the above                      |
| `VITE_SUPABASE_PROJECT_ID`       | No          | Declared in `.env.example` but currently unread |
| `VITE_GOOGLE_SHEETS_WEBHOOK_URL` | No          | Overrides the Apps Script webhook URL           |

### Server-only (never expose to the browser)

| Variable                    | Required        | Description                               |
| --------------------------- | --------------- | ----------------------------------------- |
| `SUPABASE_URL`              | Yes             | Supabase project URL for server functions |
| `SUPABASE_PUBLISHABLE_KEY`  | Yes             | Publishable key, server-side alias        |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes             | **Bypasses RLS.** Server use only         |
| `SERVICE_ROLE_KEY`          | No              | Fallback alias for the above              |
| `OPENAI_API_KEY`            | For AI features | Lead classification and rephrasing        |
| `NEXTDOOR_WEBHOOK_SECRET`   | Production      | Shared secret for the ingest webhook      |
| `WEBHOOK_SECRET`            | No              | Legacy alias for the same secret          |

### Resolution order

Client configuration falls back through
`import.meta.env` → `globalThis.__env__` → `process.env` → **hardcoded defaults**, in that order
(`src/integrations/supabase/client.ts:15`). A production Supabase URL and anon key are committed
as the final fallback. If you fork this project, replace them.

`OPENAI_MODEL` appears in `.env.example` but is **not read by any code** — the two model IDs are
pinned in `src/lib/raw-leads-ai.functions.ts`. `VITE_SUPABASE_PROJECT_ID` is likewise unread.

### Crisp credentials

Crisp workspace Website Tokens are managed **through the JellyBean admin UI**, stored individually
in **Supabase Vault**, and linked through the `crisp_workspaces` table. Do **not** add per-site
`CRISP_*` environment variables.

---

## Scripts

| Command             | Does                                                   |
| ------------------- | ------------------------------------------------------ |
| `bun dev`           | Vite dev server on `:8080` with HMR                    |
| `bun run build`     | Production build (Nitro server + client)               |
| `bun run build:dev` | Build in development mode                              |
| `bun run preview`   | Serve the production build locally                     |
| `bun run lint`      | ESLint across the repo                                 |
| `bun run format`    | Prettier write across the repo                         |
| `bun run test`      | Vitest in watch mode                                   |
| `bun run test:run`  | Vitest single pass (CI-style)                          |
| `bunx tsc --noEmit` | Type check — **no npm script exists; run it directly** |

---

## Daily tasks

If you use JellyBean to do your job, start at **[`docs/daily-tasks.md`](docs/daily-tasks.md)**
rather than here. It covers the daily routine for each of the nine roles, the raw
lead and CS status values, the two timezone rules, and what to do when something
breaks.

In short: the pipeline is **Raw Leads → Forwarded → CS Pipeline → outcome**, and
each stage has an owner. A lead's value depends on someone recording an honest,
specific status the same day they made contact.

---

## Project structure

```
src/
├── router.tsx              Router + QueryClient factory
├── routeTree.gen.ts        AUTO-GENERATED route tree — do not hand-edit
├── start.ts                createStart(): request + function middleware
├── server.ts               SSR entry, branded 500 handling
├── styles.css              Tailwind v4 CSS-first theme
├── routes/                 24 route modules (file-based routing)
├── components/             22 feature components + 46 shadcn/ui primitives
├── lib/                    39 modules: server functions, domain logic, pure helpers
├── hooks/                  7 hooks (auth, realtime, theme, clock skew, …)
├── integrations/supabase/  Client, admin client, auth middleware, generated types
├── data/                   Service catalogue (39 categories / 2,063 services)
└── assets/

supabase/
├── migrations/             131 SQL migrations
└── functions/              4 Deno edge functions (Crisp)

server/plugins/env-bridge.ts  Nitro plugin: Cloudflare __env__ → process.env
```

**File-based routing.** `src/routes/app.raw-leads.tsx` serves `/app/raw-leads`. Route modules export
`Route = createFileRoute('/app/raw-leads')({ … })`.

---

## Database

24 tables, 3 views, ~40 RPC functions, and a large body of RLS policy work.
(The counts cover what the application uses; enumerating every relation in the
database needs a `service_role` key.)

| Group      | Tables                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| Leads      | `raw_leads`, `raw_lead_cache`, `raw_lead_cache_counts`, `qualified_leads`                                       |
| Identity   | `profiles`, `user_roles`, `user_access_codes`                                                                   |
| Assignment | `service_assignments`, `state_assignments`                                                                      |
| Crisp      | `crisp_workspaces`, `crisp_conversations`, `crisp_messages`, `crisp_webhook_events`, `crisp_conversation_notes` |
| Work items | `lead_drafts`, `lead_reminders`, `crm_update_notifications`, `crm_update_notification_receipts`                 |
| Ops        | `activity_logs`, `app_settings`, `shared_state`, `map_snapshots`, `accounts`, `incogniton_profiles`             |

### Migrations

Migrations are plain SQL in `supabase/migrations/`, applied in filename order:

```bash
supabase db push            # apply pending migrations
supabase migration list     # inspect local vs remote state
```

Migration filenames encode intent, e.g. `20260914120000_cs_read_write_all_qualified_leads.sql`.
Add new migrations as `supabase migration new <description>` — never edit an applied migration.

### Timezone model

Deliberately split, and a frequent source of confusion:

| Concern                      | Zone                         | Module                        |
| ---------------------------- | ---------------------------- | ----------------------------- |
| Application-wide             | `Asia/Karachi` (PKT)         | `src/lib/timezone.ts`         |
| CS Pipeline filters **only** | `America/New_York` (Eastern) | `src/lib/cs-pipeline-time.ts` |
| Stored timestamps            | UTC                          | Postgres `timestamptz`        |

Do not "unify" these without reading both modules — the split is intentional.

---

## Edge functions

Four Deno functions under `supabase/functions/`, all Crisp-related. They each re-verify the
caller's JWT and role independently of the app.

| Function             | Purpose                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `crisp-webhook`      | Inbound Crisp events. Authenticates a per-workspace secret from Vault, idempotent via `event_fingerprint` |
| `crisp-send-message` | Outbound chat replies, role-checked against `admin` / `cs_admin` / `cs`                                   |
| `crisp-mark-read`    | Marks a conversation read; zeroes the unread counter                                                      |
| `crisp-sync-history` | Backfills conversations and message history for enabled workspaces                                        |

Each needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set as edge secrets; `crisp-mark-read`
additionally reads `SUPABASE_ANON_KEY`. Deploy with:

```bash
supabase functions deploy crisp-webhook
```

### Working on edge functions locally

Edge Functions are **Deno**, not Node. They are configured by
`supabase/functions/deno.json` and are explicitly **excluded** from the app's
`tsconfig.json` — their remote `https://` imports and the `Deno` global are
unresolvable in the app's Node/Vite project, and including them makes editors
report phantom errors against VS Code's internal libs.

Use the Deno CLI or the Deno VS Code extension for these files:

```bash
deno check supabase/functions/*/index.ts   # type check
deno lint  supabase/functions/*/index.ts   # lint
```

They are still formatted by Prettier through ESLint (`bun run format` covers
them), so keep `deno check` and `bun run lint` both clean.

---

## Quality gates

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and PR to `main`:

1. `bun install --frozen-lockfile`
2. `bunx tsc --noEmit`
3. `bunx eslint . --max-warnings 0`

A second workflow enforces [Conventional Commits](https://www.conventionalcommits.org/) PR titles.

> ### Current status: all CI gates green
>
> | Check                            | Result        |
> | -------------------------------- | ------------- |
> | `bun run test:run`               | ✅ 46 / 46    |
> | `bunx tsc --noEmit`              | ✅ 0 errors   |
> | `bunx eslint . --max-warnings 0` | ✅ 0 warnings |
>
> All three passed as of 2026-10-01 (previously 34 type errors and 35 lint
> warnings). Two gaps remain, documented in
> [`docs/known-issues.md`](docs/known-issues.md): `vitest` is not yet run in CI,
> and five `react-hooks/exhaustive-deps` suppressions in `app.crisp-chat.tsx` are
> deliberate — they stop the Realtime channel resubscribing on every render.

### Conventions

- Prettier runs through ESLint (`eslint-plugin-prettier/recommended`), so `bun run lint` also
  enforces formatting. `bun run format` writes changes.
- Commits and PR titles follow Conventional Commits: `feat(raw-leads):`, `fix(cs-pipeline):`,
  `docs(readme):`, `style(lib):`, `perf(realtime):`, `refactor`, `test`, `chore`.
- No git hooks are installed; CI is the only automated gate.

---

## Testing

Vitest 4, 6 files, 46 cases. Unit tests only — there is no component, integration, or E2E layer yet.

| File                                          | Cases |
| --------------------------------------------- | ----- |
| `src/lib/raw-leads-ai.functions.test.ts`      | 10    |
| `src/lib/raw-leads-keyset.test.ts`            | 10    |
| `src/lib/cs-pipeline-time.test.ts`            | 9     |
| `src/data/service-options.test.ts`            | 7     |
| `src/lib/service-assignment.test.ts`          | 7     |
| `src/lib/user-management-permissions.test.ts` | 3     |

```bash
bun run test:run
```

Tests cover pure logic: AI response parsing, keyset pagination maths, Eastern-time range
boundaries, service-catalogue integrity, assignment precedence, and role-delegation rules.

> Tests are **not** yet run in CI, and there is no coverage reporting. Adding both is tracked in
> [`docs/known-issues.md`](docs/known-issues.md).

---

## Deployment

`vite.config.ts` sets `nitro: true`, so every production build emits a Nitro server. Outside the
Lovable build environment, Nitro auto-detects the target from `NITRO_PRESET` or platform detection
(Vercel, Netlify, Cloudflare Pages).

### Vercel

`vercel.json` declares `framework: "tanstack-start"`. Import the repository, keep the preset, then
set the environment variables above for Production, Preview, and Development. Add the production
URL to **Supabase Auth → Redirect URLs**.

### Lovable

The app is primarily deployed through Lovable: push to `main` and Lovable builds and deploys. In
that environment `LOVABLE_NITRO_PRESET` pins the Cloudflare preset.

### Cloudflare (self-hosted, optional)

`wrangler.jsonc` is retained for a future self-hosted deployment and is **not** wired up today.

Lovable and Vercel can run simultaneously against the same Supabase project — they are two
frontends over one backend, not separate data stores.

---

## Security model

**Authentication.** Supabase email + password. The sign-in field accepts either email or username.
No OAuth, SSO, or magic links. Login OTP was explicitly disabled in migration
`20260613123000_disable_login_otp_everywhere.sql`.

**Authorization.** Four layers, all of which must agree:

1. `src/routes/app.tsx` — session, `is_active`, role presence, and the non-admin access code
2. `RoleGate` in `src/components/page.tsx:56` — render-time gate
3. Server functions — `requireSupabaseAuth` middleware plus per-handler role checks
4. Postgres RLS — ~131 migrations of policy work

**Secrets.** The service-role key bypasses RLS and must never reach a `VITE_` variable or the
client bundle. `src/integrations/supabase/client.server.ts` wraps it in a lazily-initialised proxy
and is the only sanctioned way to obtain it.

**Verified against production (read-only, anon role):**

- All 24 tables return **0 rows** to the `anon` role — RLS is correctly denying unauthenticated
  access everywhere.
- The `storage` schema is **not** exposed through PostgREST.
- The `lead-attachments` bucket is **not** readable without credentials, despite a migration named
  `make_lead_attachments_bucket_public`.
- Full detail, method, and findings: [`docs/backend-verification.md`](docs/backend-verification.md).

**Known gaps** — the Supabase project currently has **`disable_signup: false`**, meaning the auth
API accepts self-registration even though the app exposes no sign-up UI. Email confirmation is
required (`mailer_autoconfirm: false`) and the app's role gate blocks unassigned accounts, so this
is mitigated in practice — but see [`docs/known-issues.md`](docs/known-issues.md).

---

## Further documentation

| Document                                                               | Contents                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| [`docs/daily-tasks.md`](docs/daily-tasks.md)                           | **Start here** — daily routine for every role           |
| [`CHANGELOG.md`](CHANGELOG.md)                                         | Changes grouped into review units, with risk and checks |
| [`docs/architecture.md`](docs/architecture.md)                         | Request lifecycle, data layer, caching, realtime design |
| [`docs/backend-verification.md`](docs/backend-verification.md)         | Read-only production audit: schema, RLS, storage, auth  |
| [`docs/known-issues.md`](docs/known-issues.md)                         | Open defects and inconsistencies, with severity         |
| [`docs/database-io-optimization.md`](docs/database-io-optimization.md) | Database I/O audit and applied optimisations            |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                                   | Workflow, conventions, and review checklist             |

---

<div align="center">

Internal tool — not for external distribution.

</div>
