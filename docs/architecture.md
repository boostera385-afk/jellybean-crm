# Architecture

How JellyBean is put together: the request lifecycle, the data layer, caching
and realtime strategy, and the conventions that new code is expected to follow.

For a system overview and setup instructions see the [README](../README.md). For
production findings see [`backend-verification.md`](backend-verification.md).

---

## 1. Rendering model

JellyBean is a **server-rendered React application** built on TanStack Start. The
Nitro server handles the initial request, renders the route tree on the server,
and streams the result; the client then takes over as a normal SPA.

```
Browser ──▶ Nitro (src/server.ts)
              │
              ├─▶ errorMiddleware        ← requestMiddleware, src/start.ts
              │     catches anything without a statusCode and renders a
              │     branded 500 page instead of a stack trace
              │
              ├─▶ route match            ← src/routeTree.gen.ts (generated)
              │     shellComponent: RootShell  (src/routes/__root.tsx)
              │     notFoundComponent / errorComponent
              │
              ├─▶ server functions       ← createServerFn, one HTTP round trip
              │     requireSupabaseAuth middleware attaches a request-scoped
              │     Supabase client + userId to context
              │
              └─▶ Supabase (Postgres + Auth + Realtime)
```

### Entry points

| File                           | Responsibility                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `src/server.ts`                | SSR entry. Wraps `fetch`, normalises h3's swallowed `{"unhandled":true}` 500s into the branded error page |
| `src/start.ts`                 | `createStart()` — registers `errorMiddleware` and `attachSupabaseAuth`                                    |
| `src/router.tsx`               | Creates the router and a `QueryClient` per router instance                                                |
| `src/routeTree.gen.ts`         | **Generated.** Never hand-edit; regenerate via the router plugin                                          |
| `server/plugins/env-bridge.ts` | Copies Cloudflare `globalThis.__env__` into `process.env` on each request                                 |

### Auth propagation

The client never talks to the database directly for privileged work. Instead:

1. `attachSupabaseAuth` (`src/integrations/supabase/auth-attacher.ts`) runs as
   `functionMiddleware` on **every** server function and forwards the browser's
   `Authorization: Bearer <access_token>` header.
2. `requireSupabaseAuth` (`src/integrations/supabase/auth-middleware.ts`) requires
   a Bearer token, builds a **request-scoped** Supabase client pinned to that
   token, validates it with `supabase.auth.getClaims(token)`, and injects
   `{ supabase, userId, claims }` into the handler context.
3. Handlers use that request-scoped client, so **Postgres RLS applies using the
   real user's identity**. This is why most server functions do not need
   hand-written role checks — the database enforces it. Handlers add explicit
   checks only for finer-grained rules (for example `requireUserManager`).

`auth-middleware.ts` is marked auto-generated — edit `client.ts` patterns rather
than that file.

### Service-role escape hatch

`src/integrations/supabase/client.server.ts` exports `supabaseAdmin`, a lazily
initialised `Proxy` around a service-role client. Service role **bypasses RLS**.

It exists for legitimate privileged operations — bulk AI decision writes, Crisp
credential Vault access, admin user provisioning. Use it only where RLS
legitimately cannot express the rule, and never return its results to a caller
who should not see them.

---

## 2. Authorization layers

Access is checked four times over. A change to any single layer cannot grant
access on its own.

| #   | Layer           | File                                       | Enforces                                                  |
| --- | --------------- | ------------------------------------------ | --------------------------------------------------------- |
| 1   | Route guard     | `src/routes/app.tsx`                       | Session, `is_active`, role present, non-admin access code |
| 2   | Render gate     | `RoleGate`, `src/components/page.tsx:56`   | Per-route role allow-list                                 |
| 3   | Server function | `requireSupabaseAuth` + per-handler checks | Token validity, role delegation rules                     |
| 4   | Database        | RLS policies (`supabase/migrations/`)      | Row-level authorisation                                   |

### Role resolution

`primaryRole` is a fixed precedence chain, not "the first role found"
(`src/hooks/use-auth.ts:158`):

```
admin > sub_admin > cs_admin > scraping > maturing > cs > acc_handler > facebook > seo
```

Navigation is derived from `primaryRole` only, in
`src/components/app-shell.tsx:59`. `admin` and `sub_admin` additionally receive
grouped navigation (Operations / Customer service / Intelligence /
Administration); everyone else gets a single flat group.

Because navigation and rendering are driven by one function, adding a role means
touching three places: the `AppRole` union, the Postgres `app_role` enum, and
`itemsForRole()`. Keep them in sync.

---

## 3. Data access patterns

### Server functions

All server-side data access goes through `createServerFn` from
`@tanstack/react-start`. The convention:

```ts
export const someOperation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(zodSchema)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context; // request-scoped, RLS applies
    // …
  });
```

Every boundary validates with Zod. Validation is not optional here — these
functions are reachable over HTTP.

There are exactly two deliberate exceptions, both documented in code:

- `bootstrapFirstAdmin` — unauthenticated, safe only because it hard-fails once
  any profile or admin exists
- `saveGoogleSheetsConfigServerFn` — a tier-3 fallback in the Sheets config
  cascade

### Client → server

Routes call server functions through `useServerFn(...)`. Results are cached by
TanStack Query.

### Bypassing the ORM

There is no ORM. PostgREST query builders are used directly
(`.from("table").select(...).eq(...)`). Note that PostgREST infers result types
only from **terminal** methods — a bare builder has no `.data` / `.error`. Await
the builder, or apply `.single()` / `.maybeSingle()`.

---

## 4. Caching and client state

### Server state — TanStack Query v5

Configured once per router instance in `src/router.tsx`:

```ts
new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000, // 1 minute
      gcTime: 10 * 60_000, // 10 minutes
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
    },
  },
});
```

Refetch-on-focus and refetch-on-reconnect are **off by design**: this app is
polling plus realtime-driven, and focus-refetching every query on tab switch
produced redundant database load. Mutations invalidate explicitly via
`queryClient.invalidateQueries`.

Use `placeholderData: keepPreviousData` for paginated lists so page transitions
do not flash empty.

### Client state — React Context only

No Redux, Zustand, or Jotai. Two providers exist:

- `AuthProvider` / `useAuth()` — `src/hooks/use-auth.ts`
- `ConfirmDialogProvider` — `src/components/confirm-dialog.tsx`

Everything else is local `useState` / `useMemo` / `useRef`. Toasts use `sonner`.

> Most list pages still hold pagination and filters in component state rather
> than the URL. Only `/app/settings` and `/app/cs-leads` use `validateSearch`.
> URL-driven filter state was proposed in `.lovable/plan.md` and never started.

---

## 5. Realtime

Three Supabase Realtime channels, each scoped to what a role actually needs.

| Channel                      | Hook                       | Scope                                                                                                                                |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `crm-realtime-sync`          | `use-realtime-sync.ts`     | Per-role table set via `ROLE_TABLES`; 400 ms debounced invalidation; also dispatches Google Sheets sync on `qualified_leads` changes |
| `crisp-unread-nav-sync`      | `use-crisp-unread.ts`      | `crisp_conversations` + `crisp_workspaces`; 30 s heartbeat; refresh on `visibilitychange`                                            |
| `pending-reminders-nav-sync` | `use-pending-reminders.ts` | `lead_reminders`; 30 s poll; refresh on `visibilitychange`                                                                           |

Three design rules worth preserving:

1. **One channel per concern.** Commit `660462f` removed redundant duplicate
   subscriptions. Do not add a fourth channel for a new feature — extend
   `ROLE_TABLES` instead.
2. **Subscribe by role, not by page.** A user should not receive realtime events
   for tables they cannot read.
3. **Always pair realtime with a poll.** Realtime is an optimisation, not a
   guarantee; both nav badges poll on a 30 s heartbeat for that reason.

`raw_leads` and the Crisp tables use `REPLICA IDENTITY FULL` for broadcast
support.

---

## 6. Timezones

Deliberately inconsistent, and the single most likely source of subtle bugs:

| Scope                | Zone                         | Module                        |
| -------------------- | ---------------------------- | ----------------------------- |
| Application-wide     | `Asia/Karachi` (PKT)         | `src/lib/timezone.ts`         |
| **CS Pipeline only** | `America/New_York` (Eastern) | `src/lib/cs-pipeline-time.ts` |
| Stored timestamps    | UTC (`timestamptz`)          | Postgres                      |

The CS Pipeline's Eastern-time window governs which day a lead belongs to for
CS purposes, while the rest of the app reports in PKT. Before changing either
module, read both — and check
`src/lib/cs-pipeline-time.test.ts`, which pins the boundary behaviour.

---

## 7. Domain model

| Entity         | Table                                                                                                           | Notes                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Raw lead       | `raw_lead_cache`                                                                                                | Nextdoor scrape output. `data` is JSONB. Largest table |
| Raw lead       | `raw_leads`                                                                                                     | Reviewable leads with AI decisions                     |
| Qualified lead | `qualified_leads`                                                                                               | The CS pipeline record                                 |
| Identity       | `profiles`, `user_roles`, `user_access_codes`                                                                   |                                                        |
| Assignment     | `service_assignments`, `state_assignments`                                                                      | Auto-routing rules                                     |
| Crisp          | `crisp_workspaces`, `crisp_conversations`, `crisp_messages`, `crisp_webhook_events`, `crisp_conversation_notes` |                                                        |

### Assignment precedence

A qualified lead's owner resolves in this order
(`src/lib/service-assignment.ts`):

1. Explicit `assigned_to` on the lead
2. Matching `service_assignments` rule
3. Matching `state_assignments` rule

This is also implemented as a database trigger, and
`src/lib/service-assignment.test.ts` asserts the trigger's SQL text so the two
implementations cannot silently diverge.

### Enums

`app_role` (9 values), `cs_status` (21 values), `raw_lead_status`
(`new` / `qualified` / `cancelled`), `raw_lead_cancel_reason` (6 values).

`cs_status` is unusually wide because it encodes real call outcomes —
`wrong_number`, `service_provider_himself`, `already_received_before`,
`small_service`, and similar. Adding a value requires a Postgres enum migration
plus an entry in `STATUS_LABEL` and `STATUS_TONE`
(`src/lib/lead-statuses.ts`).

> `STATUS_TONE` uses explicit Tailwind hex classes rather than token references
> because the token-based classes were being purged from the production bundle.
> Preserve that when editing.

---

## 8. External integrations

| Integration       | Mechanism                                                      | Credentials                                |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------ |
| **OpenAI**        | Direct `fetch` to `api.openai.com/v1/chat/completions`; no SDK | `OPENAI_API_KEY`                           |
| **Crisp**         | REST + 4 Deno edge functions                                   | Per-workspace tokens in **Supabase Vault** |
| **Google Sheets** | Apps Script webhook from the browser, `mode: "no-cors"`        | URL in `app_settings` / `shared_state`     |
| **Nextdoor**      | Chrome extension → public webhook endpoint                     | Shared secret                              |
| **Incogniton**    | Local Node bridge at `127.0.0.1:27842`                         | Local process only                         |

### AI usage

Raw Leads classification remains in `src/lib/raw-leads-ai.functions.ts`.
CS generation runs inside the authenticated `cs-compose-lead` Edge Function,
using Supabase's sealed `OPENAI_API_KEY` secret.

| Purpose        | Model                     | Shape                                                   |
| -------------- | ------------------------- | ------------------------------------------------------- |
| Classification | `gpt-5.4-nano-2026-03-17` | `raw_lead_classification`, `strict: true`, 10 per batch |
| Composition    | `gpt-5.4-nano-2026-03-17` | `cs_compose_target`, strict JSON, ONE call              |

### CS composition is a catalogue lookup, not a generation task

`2026-10-17.catalogue-v3` moved question selection out of the prompt and into
`cs-ask-catalogue.generated.ts`, measured by `scripts/build-ask-catalogue.py`
over 23,167 delivered messages. The model no longer chooses, orders or words a
question. It returns two things only: which item a multi-item post is about,
and the noun phrase that completes "I saw that you are looking for ___."
Everything else is deterministic, so grammar, repetition and question choice
cannot regress with model quality.

Why it changed: v2 asked a nano model to free-write questions under a 78-line,
~1,450-token prompt of prohibitions with no worked example, then paid a second
nano call to review the first. Measured against the same export, the delivered
messages are a rigid three-part template (97.6% close with "so I can check the
schedule for a visit"), their asks are short fragments, and question choice is
strongly sub-category dependent. v2 contradicted all three.

| Layer                                                | Source                             |
| ---------------------------------------------------- | ---------------------------------- |
| Which asks are candidates                            | ladder per `object\|action`         |
| Ask order and legal pairs                            | per-sub-category joint pair counts |
| Exact wording                                        | `intent \| object` lexicon          |
| Brand / problem / size / quantity suppression        | measured 2-18x suppression         |
| Availability / ownership / photo / storey suppression | **code** — data showed ~1.0x       |
| Ask count                                            | **code** — data showed no decrease |
| Which item a multi-item post is about                | the model                          |

The last three rows are deliberate overrides. The export does NOT suppress
availability (8.6% asked when given vs 8.5% when not), ownership (9.5% vs
9.3%), supplied photos (82.9% vs 55.9% — it asks *more*) or storeys, and it
does not ask fewer questions when the customer said more (76.1% two asks at
zero known facts, 84.7% at two). Those habits are overridden in
`cs-detect.ts`, whose `HARD_GUARDS` set is asserted by test so the override
stays deliberate. A supplied fact is never re-asked, whatever the data did.
`ADDRESS` is likewise never emitted as slot 1, though 0.5% of delivered
messages led with it.

Classification is **batched** — `.in()` lookups chunked by 10, posts under 20
characters skipped, duplicates excluded, at most 50 rows per request, results
written back through the single `batch_update_raw_lead_decisions` RPC.

Responses are parsed and validated by the exported pure function
`parseAndValidateAiResults`, which is directly unit-tested. Model identifiers
and the CS safety policy are pinned in code; no environment variable silently
changes the model. The CS shared core is `supabase/functions/_shared/cs-composer.ts`.

All manual/bulk/auto CS paths pass a lead ID, not a partial client summary. The
Edge Function validates JWT, roles and row-level access, then loads the original
post, summary, saved CS notes, main/sub area and attachment metadata. Outgoing
drafts and suggested questions are explicitly NOT treated as customer answers,
and `sourceParts` keeps them out of both the detectors and the model payload.
Generation returns zero to two asks. Object detection is hierarchical and
masking, so "garage door" never also counts as "door"; actions are read only
after object spans are masked, so "washing machine" cannot read as a cleaning
job. A known brand is scoped to the appliance it was written against, so an LG
fridge never marks an adjacent stove's brand known. Existing screenshots are not
assumed to be job photos. A move inside one property never asks for a drop-off
address. Failures leave drafts intact.

`shared_state.cs_rephrase_prompt` stores **style preferences only**, tagged
with `policyVersion`; the v3 bump means a saved preference is ignored until it
is re-saved against the new version, which is the point of the gate. The migration archives the v1 address-first prompt in
`value.previous`. The code policy always takes precedence over style preferences.
`cs_compose_runs` records model/version/intents/warnings/latency, never raw customer
content; it is service-role-only. `cs_reserve_compose_run` atomically enforces
30 generation requests per actor/minute. `cs_compose_eval_jobs` permits management
administrators to queue bounded QA fixtures with hashed, expiring, single-use
tickets. Normal browser roles cannot create, claim or read these jobs. The Edge
gateway still requires a signed JWT; QA tickets cannot access live leads or alter
customer drafts.
The intentional service-only RLS setup appears as an informational
[RLS enabled / no policy advisor](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy),
not as an exposed client data path. Database regression tests verify the revoked
client grants, ticket expiry/replay protection and atomic rate limit.

The 2026-10-17 source CSV audit scanned **27,558** rows (194 duplicate context/post
pairs). It flagged 34 potential repeated-address, 172 timing, 74 symptom, 19 brand,
22 supplied-photo and 8 same-property-routing cases. These are **heuristic review
candidates**, not ground-truth accuracy measurements. The CSV is not clean enough
to blindly fine-tune or use its delivered replies as ideal labels. Raw CSV/customer
data is not committed. Re-run `scripts/audit-compose-csv.py` for local counts and
row-number-only diagnostics; `scripts/smoke-compose-live.ts` uses the actual shared
pipeline, or invokes the protected deployed Edge Function with a signed-in user's
JWT. Its intent gates do not replace human relevance review.

Auto-rephrase is gated by the `shared_state` toggle `cs_auto_rephrase_enabled`,
**off by default**, and never overwrites non-empty `marketing_notes`.

### Why Crisp credentials live in Vault

Crisp multi-workspace tokens are stored in Supabase Vault and linked through
`crisp_workspaces`. The inbound webhook compares its `?key=` against a
per-workspace secret with a timing-safe compare, and reads the token only at
send time. This is why there are deliberately **no** `CRISP_*` environment
variables, and why `crisp-send-message` and `crisp-mark-read` each re-verify the
caller's JWT and role independently.

---

## 9. Conventions for new code

**Routes.** Files in `src/routes` map to URLs. Add `pendingComponent:
() => <RouteSkeleton />` to any route that loads slowly.

**Components.** Feature components live in `src/components/`; shadcn primitives
in `src/components/ui/` and are exempt from the fast-refresh lint rule. Prefer
extending `LeadForm` (`src/components/lead-form.tsx`) over forking it — the
three lead routes share it, and a test asserts all three still render it.

**Server functions.** New file per domain area, named `<domain>.functions.ts`.
Always attach `requireSupabaseAuth` unless there is a documented reason not to,
and always add `.inputValidator()`.

**Migrations.** `supabase migration new <description>`. Never edit an applied
migration. Prefer a new RPC over a wide `select *` when the query is hot — the
I/O work in [`database-io-optimization.md`](database-io-optimization.md) exists
because broad reads were the dominant cost.

**Tests.** Vitest, colocated as `<module>.test.ts`. Target pure logic. When you
fix a bug, add the case that would have caught it.

**Time.** Use the helpers in `src/lib/timezone.ts` or `src/lib/cs-pipeline-time.ts`
rather than calling `new Date()` directly in a component.

---

## Further reading

| Document                                                     | Contents                      |
| ------------------------------------------------------------ | ----------------------------- |
| [`backend-verification.md`](backend-verification.md)         | Read-only production audit    |
| [`known-issues.md`](known-issues.md)                         | Open defects, prioritised     |
| [`database-io-optimization.md`](database-io-optimization.md) | Query and I/O audit           |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md)                      | Workflow and review checklist |
