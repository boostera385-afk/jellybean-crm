# Lead Explorer — Phase 1 plan and implementation

## Purpose and placement

Explore qualified leads through a compact hierarchy tree and a separate,
paginated results panel. Leads are never children in the tree.

- Route: `/app/lead-explorer`.
- Sidebar: immediately below CS Pipeline/dashboard for admin, CS admin and CS.
- Existing modules, authentication, role precedence, RLS policies and enum
  identifiers remain unchanged.
- Only the new Explorer API and UI enforce the Explorer role allow-list.

## Phase 1 scope

1. Area grouping: State → Main area → Sub-area. Do not assume main area is a city.
2. Service grouping: Category → Service, using the existing service catalog and
   case/whitespace matching behavior without rewriting historical values.
3. Lazy branch counts, 50-row keyset pages, search and date/status/owner filters.
4. Lead detail drawer with the existing CS Pipeline `leadId` deep link.
5. Validated URL state for grouping, branch, non-sensitive filters and lead ID.
   Search text stays in page memory and POST requests, never in shared URLs.
6. Mobile breadcrumb drill-down, collapsible filters and full-width lead details.
7. Shared realtime invalidation, preserving expanded branches and selection.

Out of scope: Pipeline grouping, customer history, saved views and raw-lead data.

## Data and security contract

- All reads use the signed-in user's Supabase client and existing table RLS.
- Aggregation/result RPC: `STABLE SECURITY INVOKER SET search_path = public`.
- Counts, summaries and results share the same parameterized filter builder.
- No service-role/admin credentials enter application code.
- Preserve Unknown state, Unspecified area/sub-area, Unspecified service and
  Unmapped services branches, including zero-count fallbacks.
- Preserve raw historical field values; normalize only for matching/grouping.
- Results sort by `created_at DESC, id DESC`, returning 50 rows plus a cursor.
- Search treats wildcard characters literally and supports formatted phones.
- Existing `converted` status continues to display as Delivered, not Won.
- No indexes or RLS changes were added.

Existing SELECT visibility remains:

| Role | Existing qualified-lead visibility |
| --- | --- |
| admin, cs_admin, sub_admin | All rows |
| cs | Assigned to self, unassigned, or created by self |
| fb_admin | Facebook submissions plus own rows |
| Other authenticated roles | Own created rows |

Disallowed Explorer roles retain their original access in other modules.

## Design

- Existing Public Sans/theme tokens, indigo/sky accents and glass section panels.
- Compact flat tree rows with connector lines, chevrons, count pills and one
  optional new-lead badge; no diagram or nested glass cards.
- Distinct selection, hover and keyboard focus.
- Arrow keys, Home/End, Enter/Space, tree/treeitem/group semantics.
- Breadcrumbs, collapse-all, clear filters, loading states and branch retries.
- Separate lead results and a read-only detail drawer with focus restoration.
- Mobile drill-down replaces deep indentation; filters collapse on narrow screens.
- Dates explicitly use application-wide PKT; existing Pipeline Eastern dates
  are not changed.

## Implementation files

- `src/routes/app.lead-explorer.tsx`
- `src/components/lead-explorer/`
- `src/hooks/use-lead-explorer.ts`
- `src/lib/lead-explorer.ts`
- `src/lib/lead-explorer.functions.ts`
- `src/lib/lead-explorer.test.ts`
- Feature-only additions to sidebar and shared realtime query keys.
- Generated database types and router tree.

Applied additive migrations:

1. `20261114102019_lead_explorer.sql`
2. `20261114103055_lead_explorer_whitespace.sql`
3. `20261114103357_lead_explorer_trim_inline.sql`

The latter two correct whitespace handling and keep the new pure trim helper
inlineable. No previously applied migration was edited. Existing lead policies
were compared before/after deployment and remained identical.

## Audit and validation

Audit scale: approximately 43,100 qualified leads; 12,367 missing states,
1,017 missing main areas, 148 missing sub-areas and 2,932 missing services.
Initial catalog comparison found 2,221 distinct unmatched nonblank service
values across 19,415 leads. Counts change as the live system receives leads.

Existing state, main-area/sub-area trigram and service trigram indexes were
verified. No composite geography index exists; measured performance did not
justify adding an index.

Latest live signed-in-role RPC execution timings:

| Query | admin | cs_admin | cs |
| --- | ---: | ---: | ---: |
| States | 92 ms | 94 ms | 78 ms |
| Main areas under TX | 34 ms | 42 ms | 39 ms |
| Sub-areas under Houston, TX | 18 ms | 18 ms | 22 ms |
| Service categories | 267 ms | 285 ms | 133 ms |
| Plumbing services | 251 ms | 273 ms | 128 ms |
| TX result page | 11 ms | 13 ms | 45 ms |

- `bun run test:run`: 48 files, 644 tests passed on the last full run.
- `bunx tsc --noEmit`: passed.
- `bun run build`: passed; another final build was running when local commit
  was requested.
- Feature-scoped ESLint passed before the latest small UI/helper refinements.
- Full-repo `bun run lint`: blocked by 35 existing formatting errors in
  unrelated files; those files were deliberately left untouched.
- Actual PostgreSQL offline fixtures test eight roles, unchanged RLS, complete
  cursor traversal, branch counts, literal search, fallbacks and detail access.
- Live read-only tests compare five branches per grouping per allowed role:
  node count = summary = direct RLS-visible count; first pages match page size.
  Complete multi-page traversal is covered offline, not exhaustively over all
  production leads.
- Live CS visibility matched 12,940 rows under existing RLS. Disallowed live
  roles were denied by the new RPC. No live scraping user exists, so scraping
  coverage uses the offline PostgreSQL fixture.
- Browser component fixtures passed 320/768/1280px, both themes, tree keyboard
  navigation, drawer/focus restoration, retries, search privacy and retained
  expansion. The latest mobile filter compaction still needs the final rerun.
- Browser fixtures use synthetic auth/data. A real logged-in production UI
  walkthrough, actual screen-reader use and a live realtime write event were
  not performed.

Re-run:

```sh
bun run test:run
bunx tsc --noEmit
bun run build
node scripts/test-lead-explorer.mjs
bun scripts/test-lead-explorer-browser.ts
bun scripts/test-lead-explorer-live.ts
```

The browser script requires a production build and Playwright Chromium.
The live audit script reads its management token from the environment or the
existing protected local credential file; it runs role checks in read-only
transactions and never prints the token.
