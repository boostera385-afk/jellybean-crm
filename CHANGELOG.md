# Changelog

All notable changes to JellyBean, newest first.

This file exists so changes can be **reviewed in groups** rather than as one
large diff. Each release lists review units: what changed, why, the risk, and
how to verify it independently.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed

- CS Pipeline AI status is now guarded automation instead of comparison-only:
  a person must select Delivered once, after which Quo/AI may update the
  existing status and marks it with an AI badge.
- Human status changes remove AI provenance; results completed after a newer
  human decision are rejected as stale.
- Inconclusive or failed classifications keep the current status and enter the
  new filter-aware Needs Review section.
- Updated the Reports wording and in-app Quo documentation to describe the live
  automation, one-minute sweep, and uncapped queue accurately.

### Database

- Added status provenance, automation-gate, and review columns to
  `qualified_leads`, plus a partial Needs Review index.
- Updated the fenced Quo completion, webhook queue, no-reply transition, and CS
  count functions without changing any existing `cs_status` enum identifier.

---

## 2026-10-01 — Documentation rewrite, type fixes, CI green

First CI-green state. Three commits, eight review units.

| Commit    | Type          | Files |         Net |
| --------- | ------------- | ----: | ----------: |
| `7c08ad6` | `style(lint)` |    20 | +338 / −260 |
| `c591d29` | `fix(types)`  |    11 | +306 / −180 |
| `38fceaa` | `docs`        |     7 | +1596 / −74 |

### Outcome

| Gate                             | Before        | After       |
| -------------------------------- | ------------- | ----------- |
| `bunx tsc --noEmit`              | 34 errors     | **0**       |
| `bunx eslint . --max-warnings 0` | 35 warnings   | **0**       |
| `bun run test:run`               | 46 / 46       | 46 / 46     |
| `bun run build`                  | not run in CI | passes      |
| **CI**                           | **failure**   | **success** |

No database migration. No environment variable added or removed. No change to
RLS, authentication, or the lead lifecycle.

---

### Review unit 1 — `docs`: README rewrite

**Files:** `README.md`, `.env.example`, `.lovable/plan.md`

The README described a system that no longer matched the code.

| Claimed               | Actual                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| Role `processor`      | Renamed `maturing` in migration `20260619183000`                       |
| 8 roles               | 9 — `cs_admin` was missing entirely                                    |
| AI model `gpt-5-nano` | `gpt-5.4-nano-2026-03-17` (classification), `gpt-4o-mini` (rephrasing) |
| Crisp integration     | Not mentioned at all — 4 edge functions, 5 tables, 11 server functions |
| —                     | Access-code second factor for non-admins not mentioned                 |
| —                     | Supabase Vault credential storage not mentioned                        |
| —                     | PKT / Eastern / UTC timezone split not mentioned                       |

`.env.example` gaps closed: `VITE_GOOGLE_SHEETS_WEBHOOK_URL` is read by
`google-sheets-sync.ts` but was undocumented; `OPENAI_MODEL` and
`VITE_SUPABASE_PROJECT_ID` are declared but read by no code, now flagged as such.

`.lovable/plan.md` is an 8-stage performance plan that was never started. Now
carries a banner listing what it proposed versus what actually exists, so it
cannot be mistaken for a description of the system.

**Risk:** none — documentation only.

---

### Review unit 2 — `docs`: new technical documentation

**Files:** `docs/architecture.md`, `docs/backend-verification.md`, `docs/known-issues.md`, `CONTRIBUTING.md`

- **`architecture.md`** — request lifecycle, auth propagation, the four
  independent authorization layers, caching config, realtime channel rules, the
  domain model, and conventions for new code.
- **`backend-verification.md`** — read-only production audit of the live Supabase
  project. Method, evidence, and reproduction commands.
- **`known-issues.md`** — prioritised P1–P8 defect register plus a record of
  everything resolved and why.
- **`CONTRIBUTING.md`** — workflow, conventions, review checklist.

**Risk:** none.

---

### Review unit 3 — `fix(types)`: the `TS2589` generic collapse

**Files:** `src/lib/crisp.functions.ts`

The single highest-leverage fix; **caused roughly 30 of the 34 errors**.

`assertCrispAccess` and `assertAdmin` declared their own structural Supabase
client type. TypeScript therefore had to structurally compare that shape against
`SupabaseClient<Database>`, which forced instantiation of the entire generated
schema (~1,718 lines: 24 tables, 3 views, ~40 functions, 3 enums) and exhausted
the compiler's instantiation budget.

```text
error TS2589: Type instantiation is excessively deep and possibly infinite.
```

Every `TS2345` elsewhere in the file was the same generic collapsing one level up.

**Fix:** both guards now accept the client as `unknown` and narrow once through a
shared `fetchCallerRoles` helper, so accepting a client costs no structural
comparison. A deliberately shallow `RoleQueryClient` type documents the single
query performed. **No `any` introduced.**

**Risk:** low. Access control logic is unchanged — same roles, same rejection
message. Verify by attempting Crisp Chat as `maturing` and confirming it is still
refused.

---

### Review unit 4 — `fix(types)`: untyped Crisp payloads

**Files:** `src/routes/app.crisp-chat.tsx`, `src/lib/crisp.server.ts`

The highest **real-world** risk in the set, because customer attachments are
involved.

`MessageRecord.raw_payload` was `Record<string, unknown>`, so a
`typeof x === "object"` guard narrowed to bare `object` and reading `.url`,
`.size` or `.duration` failed to compile. A mistyped attachment field silently
drops a customer's photo.

**Fix:** explicit `CrispAttachmentContent` and `CrispRawPayload` shapes, narrowed
once into a local `attachmentContent` reused for the later `duration` read.
`parseMessageContent` now narrows `raw` before reading `.text` / `.name`.

**Risk:** low, but visually verifiable. Confirm customer image and file
attachments still render, and voice notes still show "(Ns)".

---

### Review unit 5 — `fix(types)`: `QueryBuilder` shape

**Files:** `src/lib/crisp.server.ts`

`.data` / `.error` were destructured from a `QueryBuilder` type that modelled
only chaining. PostgREST builders are **both** chainable and thenable, so
`QueryBuilder` is now an `interface` extending `PromiseLike<…>`.

This also fixes runtime typing for the bulk message upsert.

**Risk:** low.

---

### Review unit 6 — `fix(types)`: literal shape mismatches

**Files:** `src/lib/crisp.functions.ts`, `src/components/crisp-message-notifier.tsx`, `src/lib/nextdoor-leads-webhook.ts`

- Crisp API response cast to the `Json` column type (which is what `res.json()`
  actually returns).
- `crisp-message-notifier.tsx`: `conversation_id` is `string | undefined` but is
  used both to fetch the conversation and to build the alert. Added a real guard
  (`if (!newMsg?.id || !newMsg.conversation_id) return;`) rather than a cast —
  an alert with no conversation cannot be actioned, so dropping it is correct.
- `nextdoor-leads-webhook.ts`: declared `data?: Record<string, string> | null`
  while the column is JSONB. `data` was never read from those rows, so the unused
  field was dropped instead of cast.

**Risk:** low. The notifier guard means a message with no `conversation_id` no
longer raises a toast — correct, but it is a behaviour change worth noting.

---

### Review unit 7 — `fix(types)`: Deno edge functions

**Files:** `supabase/functions/deno.json` (new), `supabase/functions/crisp-sync-history/index.ts`, `tsconfig.json`

Edge Functions are Deno, not Node. They had no `deno.json`, so editors
misdiagnosed them — the giveaway was diagnostics pointing at VS Code's own
`lib.scripthost.d.ts`. Underneath that noise were **genuine** errors:
`messagesList` is `Record<string, unknown>[]`, so `timestamp` was `unknown` and
the code did arithmetic and `new Date()` on it.

- Added `supabase/functions/deno.json` with Deno compiler options.
- Explicitly excluded `supabase/` from the app `tsconfig.json`.
- Added a `toTimestamp()` coercion helper handling epoch ms, numeric strings and
  ISO strings.

Side benefit: `toTimestamp` removes the literal string `"undefined"` from
generated Crisp message IDs, which could previously have collided.

**Risk:** low-medium — this is production sync code. The coercion is strictly more
robust than `x.timestamp || 0`. **Recommend one manual sync run** and a check that
`crisp_messages.sent_at` is still correct and messages are still in order.

---

### Review unit 8 — `style(lint)`: memoisation, imports, fast refresh

**Files:** 20 — `app.analytics.tsx`, `app.reports.tsx`, `app.crisp-chat.tsx`, `app.cs-leads.tsx`, `app.submit-lead.tsx`, `lead-form.tsx`, `confirm-dialog.tsx`, `lead-attachments.tsx`, `app.forwarded-leads.tsx`, `app.raw-leads.tsx`, `app.lead-assignment.tsx`, `drafts-dialog.tsx`, `service-assignment-tab.tsx`, `settings/crm-updates-tab.tsx`, 3 new modules

**8a — 14 real performance fixes.** Values like `x.data ?? []` allocate a fresh
array every render, so dependent `useMemo`s **never memoised** and recomputed on
every render. Affected `series`, `prevSeries`, `csBuckets`, `forwarders`,
`deptRows`, `rawRows`, `rawUsers`, `allProfiles`. Analytics and Reports should
feel noticeably snappier.

**8b — 2 genuine missing dependencies.** `isFacebook` is a boolean primitive;
`qc` is the context QueryClient singleton whose identity is fixed for the app
lifetime, so the mount-once Realtime subscription at `app.cs-leads.tsx` still
runs exactly once.

**8c — 5 deliberate suppressions in `app.crisp-chat.tsx`.** `loadConversations`,
`loadMessages`, `loadNotes`, `loadWorkspaces`, `loadWorkspaceCounts` are plain
`async` functions with a new identity every render. The page already mirrors
mutable state into refs to keep these effects mount-once. Adding them as
dependencies would re-run those effects **every render** — for the effect at
line 891 that means rebuilding the Supabase Realtime channel and 30 s poll
interval each render. `app.cs-leads.tsx` carries an explicit comment that a
duplicate Realtime subscription would **double message billing for every CS
user**. Obeying the rule here is actively harmful, so each site is suppressed
with a comment explaining why.

> **Follow-up:** stabilise the loaders with `useCallback` so the rule can be
> satisfied honestly. Needs `convPage` mirrored to a ref, and browser
> verification of infinite scroll. Tracked in `docs/known-issues.md`.

**8d — 14 fast-refresh hygiene fixes.** Non-component exports moved out of
component modules so Fast Refresh works correctly in development.

| New module                           | Contents                                                       | Importers updated |
| ------------------------------------ | -------------------------------------------------------------- | ----------------: |
| `components/confirm-dialog-store.ts` | `confirmDialog`, `confirmDiscardUnsaved`, types, pending store |                 7 |
| `lib/lead-form-utils.ts`             | `formatPhoneInput`, `uploadLeadImages`                         |                 2 |
| `lib/lead-attachments.ts`            | `toStoragePath`, `useSignedLeadUrls` (split from `.tsx`)       |                 2 |

Eight file-local exports in `app.crisp-chat.tsx` and `app.reports.tsx` were dead
`export` keywords — nothing imported them, so the keyword was simply removed.

**Risk:** low for 8a, 8b, 8d. **8c is deliberate no-op** — current behaviour
preserved exactly.

---

### Duplications found and deliberately NOT fixed

Worth a product decision rather than a silent code change.

| Duplication                       | Detail                                                                | Why left                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CS_LABELS` defined 3×            | `app.reports.tsx`, `app.analytics.tsx`, `app.index.tsx`               | **Not identical** — coverage and casing differ (`"Wrong Number"` vs `"Wrong number"`). Consolidating changes rendered labels. |
| `isCrispMaskedMessage` defined 3× | `app.crisp-chat.tsx`, `crisp-message-notifier.tsx`, `crisp.server.ts` | Bodies equivalent, but two copies are client-side and one server-side. A shared import needs care.                            |
| `formatPhoneInput` defined 2×     | `lead-form.tsx` (now `lib/lead-form-utils.ts`), `app.raw-leads.tsx`   | Local copy in `app.raw-leads.tsx` kept to avoid widening that file's diff.                                                    |

---

### Verification performed

| Check | Command                          | Result             |
| ----- | -------------------------------- | ------------------ |
| Types | `bunx tsc --noEmit`              | 0 errors           |
| Lint  | `bunx eslint . --max-warnings 0` | 0 warnings, exit 0 |
| Tests | `bun run test:run`               | 46 / 46            |
| Build | `bun run build`                  | succeeds           |
| CI    | GitHub Actions                   | **success**        |

### Recommended manual checks before release

Not covered by automated tests — no component, integration, or E2E layer exists.

1. **Crisp attachments** — customer image, file, and voice-note render correctly.
2. **Crisp history sync** — run one sync; confirm `sent_at` values and message order.
3. **Confirm dialogs** — `confirmDialog` and "discard unsaved changes" still work
   on Raw Leads, Forwarded Leads, Lead Assignment, Drafts, and the Users tab.
4. **Lead attachments** — image upload and thumbnail on the lead form and Manual Lead.
5. **Analytics and Reports** — charts and totals unchanged.
6. **Realtime** — open CS Pipeline in two browsers; a new incoming message should
   appear in both without duplicate toasts.

---

## Earlier work

Pre-2026-10-01 history is in `git log`. Notable prior milestones:

- `20260914` — pending-lead reminders and CS Pipeline routing
- `20260911` — bulk "assign N leads to me" and duplicate auto-routing
- `20260829` — database I/O optimisation (see `docs/database-io-optimization.md`)
- `20260818` — Crisp multi-workspace support with Vault-backed credentials
- `20260722` — service-based CS assignment routing
