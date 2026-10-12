// JellyBean — Complete System Documentation content.
// Derived from the current codebase (routes, components, hooks,
// Supabase migrations, RLS policies and role helpers). Update when
// system workflows or permissions change.

export type DocTable = {
  kind: "table";
  headers: string[];
  rows: string[][];
};

export type DocParagraph = { kind: "p"; text: string };
export type DocList = { kind: "ul"; items: string[] };
export type DocSubheading = { kind: "h3"; text: string };
export type DocBlock = DocParagraph | DocList | DocTable | DocSubheading;

export type DocSection = {
  id: string;
  number: number;
  title: string;
  blocks: DocBlock[];
};

export const DOC_VERSION = "1.1";
export const DOC_DATE = "July 14, 2026";
export const DOC_TITLE = "JellyBean — Complete System Documentation";
export const DOC_SUBTITLE = `Version ${DOC_VERSION} · ${DOC_DATE} · Full reference for roles, leads, workflows, permissions, notifications, integrations, and technical architecture.`;

export const DOC_NOTE =
  "This documentation reflects the currently implemented JellyBean behavior and should be updated when system workflows or permissions change.";

export const DOC_SECTIONS: DocSection[] = [
  {
    id: "overview",
    number: 1,
    title: "Overview",
    blocks: [
      {
        kind: "p",
        text: "JellyBean is an internal lead-operations workspace that ingests raw leads from external sources, allows operators to qualify and forward them, and gives Customer Success (CS) a pipeline to work qualified leads to close.",
      },
      {
        kind: "p",
        text: "The complete lead flow moves through four stages: (1) raw leads land in raw_lead_cache from scrapers/webhooks, (2) operators categorize and forward them, (3) forwarded records become qualified_leads, (4) the CS pipeline drives follow-up and status transitions.",
      },
      { kind: "h3", text: "Frontend architecture" },
      {
        kind: "ul",
        items: [
          "TanStack Start (React 19) with file-based routing under src/routes/",
          "TanStack Query for data fetching, caching, and invalidation",
          "shadcn/ui + Tailwind v4 design system with light and dark themes",
          "Server functions via createServerFn for authenticated backend calls",
        ],
      },
      { kind: "h3", text: "Backend" },
      {
        kind: "ul",
        items: [
          "Supabase Postgres with Row Level Security on all user-facing tables",
          "SECURITY DEFINER RPCs for privileged reads and safe bulk operations",
          "Supabase Realtime channels for CRM Updates and live sync",
          "Supabase Storage for lead attachments with signed URLs",
        ],
      },
    ],
  },
  {
    id: "roles",
    number: 2,
    title: "User Roles and Permissions",
    blocks: [
      {
        kind: "p",
        text: "Roles are stored in the public.user_roles table (never on profiles) and checked through the has_role(user_id, role) SECURITY DEFINER function. The AppRole enum in src/hooks/use-auth.ts is the source of truth for role identifiers.",
      },
      {
        kind: "table",
        headers: ["Role", "Purpose", "Main Access", "Restricted Areas", "Important Permissions"],
        rows: [
          [
            "admin",
            "Full system administrator",
            "Every module",
            "None",
            "Manage users, publish CRM Updates, CSV export, bulk important-lead assignment",
          ],
          [
            "sub_admin",
            "Delegated admin (no user or logs access)",
            "Most admin modules",
            "CS Pipeline, Activity Logs, Settings, CRM Updates",
            "Read/write leads and forwarded leads",
          ],
          [
            "cs_admin",
            "CS pipeline lead",
            "CS Pipeline (full)",
            "Everything outside CS Pipeline",
            "Full CRUD in CS Pipeline, bulk important-lead assignment (no CSV export)",
          ],
          [
            "cs",
            "Customer Success operator",
            "CS Pipeline",
            "Admin modules",
            "Work assigned leads, update statuses, add follow-ups",
          ],
          [
            "maturing",
            "Lead maturing operator",
            "Raw Leads, Forwarded Leads, Manual Lead",
            "Admin modules",
            "Categorize, forward, manage drafts",
          ],
          [
            "acc_handler",
            "Account handler",
            "Map, Browser Profiles, Raw Leads, Forwarded Leads, Manual Lead",
            "Admin analytics/logs",
            "Handle account browser profiles, forward leads",
          ],
          [
            "facebook",
            "Facebook lead submitter",
            "Submit Lead, Forwarded Leads",
            "All admin modules",
            "Manual lead entry from Facebook",
          ],
          [
            "seo",
            "SEO lead submitter",
            "Submit Lead, Forwarded Leads",
            "All admin modules",
            "Manual lead entry from SEO sources",
          ],
        ],
      },
      {
        kind: "p",
        text: "Attachment previews and 'Forwarded By' metadata on CS Pipeline cards are gated to admin and cs_admin. Source/Via labels are admin-only. Notification popups only fire for a user whose exact role is listed in target_roles.",
      },
    ],
  },
  {
    id: "navigation",
    number: 3,
    title: "Navigation and Page Access",
    blocks: [
      {
        kind: "p",
        text: "The sidebar (src/components/app-shell.tsx) computes items via itemsForRole(role). Each role sees only the modules relevant to its workflow.",
      },
      {
        kind: "table",
        headers: ["Section", "Purpose", "Default Role Access", "Important Restrictions"],
        rows: [
          ["Dashboard", "KPIs and daily counts", "admin, sub_admin", "Hidden for CS, submitters"],
          [
            "Raw Leads",
            "Scraped/webhook leads",
            "admin, sub_admin, maturing, acc_handler",
            "Not shown to CS/CS Admin/submitters",
          ],
          [
            "CS Pipeline",
            "Qualified leads follow-up",
            "admin, cs_admin, cs",
            "Sub Admin has no access",
          ],
          [
            "Forwarded Leads",
            "Leads the user forwarded",
            "admin, sub_admin, maturing, acc_handler, facebook, seo",
            "Owner-only edit while status is 'new'",
          ],
          [
            "Manual Lead",
            "Manual lead entry form",
            "admin, sub_admin, maturing, acc_handler, facebook, seo",
            "—",
          ],
          ["Browser Profiles", "Incogniton profile records", "admin, sub_admin, acc_handler", "—"],
          ["Map", "Geographic lead view", "admin, sub_admin, acc_handler", "—"],
          ["Analytics", "Trend charts", "admin, sub_admin", "—"],
          ["Reports", "Operational reports", "admin, sub_admin", "CSV export admin-only"],
          [
            "Lead Assignment",
            "State-based routing + CS analytics",
            "admin, cs_admin",
            "Replaces CS Reports",
          ],
          ["Activity", "Audit log", "admin only", "Hidden from sub_admin"],
          ["Health", "System health checks", "admin, sub_admin", "—"],
          [
            "CRM Updates",
            "Publish live notifications",
            "admin only",
            "Hidden from all other roles",
          ],
          [
            "Settings",
            "System settings + user management",
            "admin only",
            "Non-admins see 'Restricted'",
          ],
        ],
      },
    ],
  },
  {
    id: "dashboard",
    number: 4,
    title: "Dashboard",
    blocks: [
      {
        kind: "ul",
        items: [
          "Displays total raw leads, today's leads, forwarded leads, and CS pipeline counts",
          "Counts come from planned-count queries on raw_lead_cache and qualified_leads",
          "Data refreshes on route entry and on manual refresh; no polling",
          "Visible to admin and sub_admin only",
        ],
      },
    ],
  },
  {
    id: "raw-leads",
    number: 5,
    title: "Raw Leads",
    blocks: [
      {
        kind: "p",
        text: "Raw Leads (src/routes/app.raw-leads.tsx) shows leads from raw_lead_cache — scraped Nextdoor posts and webhook ingestion. Data is loaded server-side through raw-leads.functions.ts.",
      },
      {
        kind: "ul",
        items: [
          "Fields: post text, account name, sub area (neighborhood), captured date and time in PKT, posted date, lead status, assignment",
          "Filtering: search box, lead-status categories, assignment filter (All / Unassigned / Assigned to me)",
          "Numbered pagination with page-size selector; page state is stable during list mutations",
          "Sorting: page-local only (sorts the current page). Captured Date and Time sorts chronologically; Posted Date parses relative and absolute values; statuses use a logical rank",
          "Assignment: 'Assign to me' claims a lead race-safely (only if assigned_to IS NULL)",
          "Draft Leads: leads moved to Draft are hidden from the live Raw Leads view and stored in lead_drafts",
          "Duplicate detection: automatic canonical Post ID / URL check plus 4-field fallback (name, area, posted time, post text)",
          "'Old Post' badge appears on any lead whose posted date/time is more than 24 hours old",
          "Send to CS opens the LeadForm dialog to categorize and forward the lead into qualified_leads",
        ],
      },
    ],
  },
  {
    id: "duplicates",
    number: 6,
    title: "Duplicate Lead Detection",
    blocks: [
      {
        kind: "ul",
        items: [
          "Canonical Post ID is derived from the Nextdoor post URL and stored on raw_lead_cache",
          "Canonical lead URL is normalized to strip tracking parameters",
          "A new raw lead is matched first by canonical_post_id, then by canonical URL",
          "Fallback: if neither ID nor URL match, compare account name, sub area, posted date/time, and post text (all four must match)",
          "The duplicate popup (get_raw_lead_duplicate_match_preview RPC) shows a side-by-side comparison and marks the source",
          "Phone-number duplicate check runs on the initial form and again on the 'Forward to CS' form using the same RPC (customerNumber and extraNumbers)",
          "'Continue Anyway' proceeds despite a duplicate hit; the choice is race-safe against concurrent forwards",
        ],
      },
    ],
  },
  {
    id: "drafts",
    number: 7,
    title: "Draft Leads",
    blocks: [
      {
        kind: "ul",
        items: [
          "Draft state stores full form values in public.lead_drafts (JSONB) keyed by (created_by, source_type, source_lead_id)",
          "Saving a draft auto-claims the raw lead to the current user if it is unassigned (race-safe update)",
          "Existing assignments are preserved; the draft never reassigns to another operator",
          "Draft status takes visual priority: drafted leads are hidden from live Raw Leads listings",
          "A red dot appears on the Drafts button when the current user has one or more drafts",
          "Restore reopens the draft in the same form with the original post link visible in the Drafts dialog",
          "Successful 'Send to CS' deletes the associated draft row",
        ],
      },
    ],
  },
  {
    id: "manual-lead",
    number: 8,
    title: "Manual Lead",
    blocks: [
      {
        kind: "ul",
        items: [
          "Manual lead form (src/routes/app.submit-lead.tsx) submits qualified leads directly without a raw-lead source",
          "Required: customer name, customer number, service category, area",
          "Optional: extra phone numbers, notes, attachments (screenshots)",
          "Customer number is required and duplicate-checked; extra numbers are duplicate-checked but optional",
          "Available to admin, sub_admin, maturing, acc_handler, facebook, seo",
          "On send the lead is inserted into qualified_leads with the submitter as forwarded_by",
        ],
      },
    ],
  },
  {
    id: "cs-pipeline",
    number: 9,
    title: "CS Pipeline",
    blocks: [
      {
        kind: "p",
        text: "The CS Pipeline (src/routes/app.cs-leads.tsx) is the working surface for qualified leads. Cards emphasize Customer Name, Service, then Area.",
      },
      {
        kind: "ul",
        items: [
          "Filters: search, owner (assigned CS), area, lead status",
          "Date range with Today / 7d / 30d preset pills; active preset is highlighted",
          "Timezone: all date display and filtering use America/New_York (Eastern Time). Database timestamps remain UTC.",
          "Numbered pagination; the list order freezes while selections exist so bulk actions stay stable",
          "'New leads available — click to load' banner appears when new rows arrive during work",
          "Card view is default; a secondary Table view is available",
          "Follow-up notes and status transitions are captured in the drawer with an AI Rephrase Assistant",
          "CSV export is restricted to admin",
        ],
      },
    ],
  },
  {
    id: "cs-visibility",
    number: 10,
    title: "CS Pipeline Role Visibility",
    blocks: [
      {
        kind: "table",
        headers: ["Feature", "Admin", "CS Admin", "CS", "Sub Admin"],
        rows: [
          ["Access CS Pipeline", "Yes", "Yes", "Yes", "No"],
          ["Source / Via labels", "Yes", "No", "No", "n/a"],
          ["Forwarded By information", "Yes", "No", "No", "n/a"],
          ["Conversation screenshots", "Yes", "Yes", "No", "n/a"],
          ["Attachment previews", "Yes", "Yes", "No", "n/a"],
          ["Attachment badges", "Yes", "Yes", "No", "n/a"],
          ["CSV export", "Yes", "No", "No", "n/a"],
          ["Bulk important-lead assign", "Yes", "Yes", "No", "n/a"],
        ],
      },
    ],
  },
  {
    id: "important",
    number: 11,
    title: "Important Leads",
    blocks: [
      {
        kind: "ul",
        items: [
          "An 'Assign Important Leads' dropdown is available in the CS Pipeline toolbar for admin and cs_admin",
          "The action calls bulkAssignImportantLeads (src/lib/cs-team.functions.ts) which performs one safe bulk update",
          "The dropdown lists active CS users so the operator can assign selected important leads in one call",
          "Selection is preserved across pagination and the assignment toolbar becomes sticky while any row is checked",
        ],
      },
    ],
  },
  {
    id: "forwarded",
    number: 12,
    title: "Forwarded Leads",
    blocks: [
      {
        kind: "ul",
        items: [
          "Forwarded Leads (src/routes/app.forwarded-leads.tsx) lists leads that the current user has forwarded",
          "Fields: customer name, service, area, original post link (when raw-lead sourced), assignment, status",
          "Edit and delete are limited to the owner while the CS status is 'new'",
          "Duplicate number validation runs when editing customer or extra phone numbers",
          "Numbered pagination, global search, and status filtering are supported",
          "Available to admin, sub_admin, maturing, acc_handler, facebook, seo",
        ],
      },
    ],
  },
  {
    id: "workflow",
    number: 13,
    title: "Lead Forwarding Workflow",
    blocks: [
      {
        kind: "p",
        text: "The end-to-end flow is: Raw Lead → Categorization → Assignment → Send to CS → Qualified Lead → CS Pipeline → Follow-up and status handling.",
      },
      {
        kind: "ul",
        items: [
          "raw_lead_cache holds the source record and its lead_status",
          "On send, the qualified record is inserted into qualified_leads with forwarded_by = current user",
          "The originating raw_lead_cache row is marked with the forwarded status so it stops appearing in the working queue",
          "CS receives the record in the CS Pipeline and drives it through status transitions until close",
        ],
      },
    ],
  },
  {
    id: "browser-profiles",
    number: 14,
    title: "Browser Profiles",
    blocks: [
      {
        kind: "ul",
        items: [
          "Browser Profiles (src/routes/app.browser-profiles.tsx) tracks Incogniton browser-profile records tied to accounts",
          "Available to admin, sub_admin, acc_handler",
          "Operators can view and manage the profile records used for account activity",
        ],
      },
    ],
  },
  {
    id: "map",
    number: 15,
    title: "Map",
    blocks: [
      {
        kind: "ul",
        items: [
          "The Map (src/routes/app.map.tsx) plots leads with location data on a Leaflet map",
          "Filtering by service area and lead status is available",
          "Available to admin, sub_admin, acc_handler",
        ],
      },
    ],
  },
  {
    id: "analytics",
    number: 16,
    title: "Analytics",
    blocks: [
      {
        kind: "ul",
        items: [
          "Analytics (src/routes/app.analytics.tsx) renders trend charts using Recharts",
          "Metrics cover raw and qualified lead volume, source split, and daily activity",
          "Data source: aggregate queries on raw_lead_cache and qualified_leads",
          "Available to admin and sub_admin",
        ],
      },
    ],
  },
  {
    id: "reports",
    number: 17,
    title: "Reports",
    blocks: [
      {
        kind: "ul",
        items: [
          "Reports (src/routes/app.reports.tsx) surfaces per-processor counts by day and range",
          "Includes 'Not Found' counts (leads without a match) and processor attribution",
          "Uses SECURITY DEFINER RPCs to bypass RLS safely and return aggregate rows",
          "CSV export is restricted to admin",
        ],
      },
    ],
  },
  {
    id: "lead-assignment",
    number: 18,
    title: "Lead Assignment",
    blocks: [
      {
        kind: "ul",
        items: [
          "Lead Assignment (src/routes/app.lead-assignment.tsx) replaces the previous CS Reports section",
          "Admin and CS Admin assign one or many U.S. states to a CS user; a state can belong to only one CS user at a time",
          "New incoming leads whose resolved state matches an assignment are auto-routed to the owning CS user (BEFORE INSERT trigger on qualified_leads)",
          "Reassigning a state affects only future incoming leads; existing leads are not silently reassigned",
          "State visibility: CS users only see leads from their assigned states (RLS via public.state_assignments)",
          "Analytics tab: per-state breakdown across every lead status, plus CS-user totals (assigned states, total, processed, pending, by state, by status). Filters: Today / 7d / 30d / Custom",
          "Access: admin and cs_admin only — enforced server-side by requireAdmin() in src/lib/lead-assignment.functions.ts",
        ],
      },
    ],
  },
  {
    id: "activity",
    number: 19,
    title: "Activity",
    blocks: [
      {
        kind: "ul",
        items: [
          "Activity (src/routes/app.logs.tsx) is the audit log of actor / action / timestamp records",
          "Filterable by user and action type",
          "Admin only",
        ],
      },
    ],
  },
  {
    id: "health",
    number: 20,
    title: "Health",
    blocks: [
      {
        kind: "ul",
        items: [
          "Health (src/routes/app.health.tsx) reports basic system checks and warnings",
          "Includes clock-skew detection which warns users whose local clock drifts from server time",
          "Available to admin and sub_admin",
        ],
      },
    ],
  },
  {
    id: "crm-updates",
    number: 21,
    title: "CRM Updates",
    blocks: [
      {
        kind: "p",
        text: "CRM Updates (src/routes/app.crm-updates.tsx and src/components/crm-updates-notifier.tsx) delivers one-time in-app notifications to selected roles.",
      },
      {
        kind: "ul",
        items: [
          "Admin-only management: create, publish, enable, disable, delete (with confirmation)",
          "Fields: title, description, affected section (dropdown of CRM sections), priority, target roles",
          "Target Roles selector uses filled-dot toggle cards with accented highlight on selected roles",
          "Publish validation requires an affected section",
          "Notification History lists all published updates",
          "Realtime delivery: one Supabase channel per session (crm-updates-<uid>); no polling",
          "Offline delivery: on login, unread active notifications for the user's role are queued oldest-first",
          "Acknowledgement: pressing 'Got It' inserts a unique row into crm_update_notification_receipts",
          "A 'Refresh CRM' button is offered where relevant to reload data after an update",
          "Admin does not receive the popup unless 'admin' is explicitly selected in target_roles (client-side role filter mirrors RLS)",
        ],
      },
    ],
  },
  {
    id: "notifications",
    number: 22,
    title: "Notifications and Realtime",
    blocks: [
      {
        kind: "ul",
        items: [
          "CRM Update notifications are the primary Realtime channel; one subscription per logged-in session",
          "No client-side polling; unread state is queried once on mount",
          "Receipts (crm_update_notification_receipts) guarantee one-time acknowledgement per user",
          "Role targeting is enforced by RLS on notifications and mirrored in the client",
          "Additional Realtime channels are used for lightweight admin-checklist sync in Settings > Updates",
        ],
      },
    ],
  },
  {
    id: "settings",
    number: 23,
    title: "Settings",
    blocks: [
      {
        kind: "p",
        text: "Settings (src/routes/app.settings.tsx) is admin-only. Non-admin visitors see a 'Restricted' notice via the RoleGate component.",
      },
      {
        kind: "ul",
        items: [
          "General — notes about authentication behavior (username/email + password only, no OTP)",
          "Updates — a shared admin checklist stored in public.shared_state and synced through Realtime",
          "Users — create, activate/deactivate, reset password, and delete users",
          "Documentation — this reference document with a Download PDF action",
        ],
      },
    ],
  },
  {
    id: "user-mgmt",
    number: 24,
    title: "User Management",
    blocks: [
      {
        kind: "ul",
        items: [
          "Create User form captures email, password, full name, username, and role",
          "Show/Hide password toggle uses Eye/EyeOff icons and aria-labels",
          "Users are created through adminCreateUser (server function) with role assignment inserted into user_roles",
          "Activate/deactivate flips profiles.is_active; inactive users are blocked at login",
          "Delete removes the user from auth.users via a SECURITY DEFINER RPC (hard delete, not a soft flag)",
          "Password reset is handled through adminResetPassword",
        ],
      },
    ],
  },
  {
    id: "auth",
    number: 25,
    title: "Authentication and Security",
    blocks: [
      {
        kind: "ul",
        items: [
          "Supabase Auth with username/email + password; login codes and OTP are disabled",
          "email_for_username RPC resolves the username to an email at login",
          "Sessions are managed by @supabase/supabase-js; a root onAuthStateChange listener invalidates caches on sign-in",
          "Role checks are done server-side via has_role() and client-side via useAuth().primaryRole",
          "RLS is enabled on every user-facing table; policies use has_role for role gating",
          "Service role keys are used only in server-only modules (client.server.ts) and never shipped to the browser",
          "The frontend uses the publishable Supabase key which is safe to expose",
          "Protected routes live under the /app layout (src/routes/app.tsx), which redirects unauthenticated users to /login and blocks inactive profiles",
        ],
      },
    ],
  },
  {
    id: "database",
    number: 26,
    title: "Database Architecture",
    blocks: [
      {
        kind: "table",
        headers: ["Table / RPC", "Purpose", "Important Relationships"],
        rows: [
          [
            "profiles",
            "User profile data (name, username, email, is_active)",
            "1:1 with auth.users",
          ],
          ["user_roles", "Role assignments (never on profiles)", "user_id → auth.users; role enum"],
          [
            "raw_lead_cache",
            "Raw scraped/webhook leads",
            "assigned_to → auth.users; source of qualified_leads",
          ],
          [
            "qualified_leads",
            "Forwarded/qualified leads worked in CS Pipeline",
            "forwarded_by, assigned_to → auth.users",
          ],
          [
            "lead_drafts",
            "In-progress forwarding forms (JSONB)",
            "Unique (created_by, source_type, source_lead_id)",
          ],
          [
            "crm_update_notifications",
            "Admin-published live notifications",
            "target_roles is an array of AppRole",
          ],
          [
            "crm_update_notification_receipts",
            "One-time acknowledgements",
            "Unique (notification_id, user_id)",
          ],
          [
            "shared_state",
            "Small key/value JSONB store (admin checklist etc.)",
            "Realtime-broadcast",
          ],
          ["app_settings", "System configuration keys", "Admin-managed"],
          ["has_role(_user_id, _role)", "SECURITY DEFINER role check", "Used across RLS policies"],
          [
            "email_for_username(_username)",
            "Resolve username → email for login",
            "SECURITY DEFINER",
          ],
          [
            "get_raw_lead_duplicate_match_preview",
            "Duplicate comparison payload",
            "SECURITY DEFINER read",
          ],
          ["bulkAssignImportantLeads", "Bulk assignment of important leads", "Server function"],
        ],
      },
    ],
  },
  {
    id: "storage",
    number: 27,
    title: "Supabase Storage",
    blocks: [
      {
        kind: "ul",
        items: [
          "Bucket 'lead-attachments' holds conversation screenshots and other lead files; the client always reads files via time-limited signed URLs (1 hour TTL) generated on demand rather than sharing raw object paths",
          "Bucket 'crm-downloads' is a private bucket used to distribute the browser extension / bridge zips to authorized operators via signed URLs",
          "Uploads and reads are gated by storage RLS policies mirroring RLS on the parent lead (owner or admin/sub_admin)",
        ],
      },
    ],
  },
  {
    id: "edge",
    number: 28,
    title: "Edge Functions and Integrations",
    blocks: [
      {
        kind: "ul",
        items: [
          "Nextdoor lead ingestion — public API route src/routes/api.public.nextdoor-leads.ts with signature verification",
          "Raw-lead webhook handler (src/lib/nextdoor-leads-webhook.ts) supports the browser extension and standard callers",
          "AI Rephrase Assistant — server function used from the CS Pipeline drawer for message rephrasing",
          "Server functions in src/lib/*.functions.ts back all authenticated backend calls",
        ],
      },
    ],
  },
  {
    id: "quo",
    number: 29,
    title: "Quo Monitor",
    blocks: [
      {
        kind: "p",
        text: "Not implemented in the current build. This section is intentionally left empty until the integration ships.",
      },
    ],
  },
  {
    id: "performance",
    number: 30,
    title: "Performance Architecture",
    blocks: [
      {
        kind: "ul",
        items: [
          "Server-side numbered pagination on Raw Leads, Forwarded Leads, and CS Pipeline with page-size selectors",
          "Total counts use PostgREST 'planned' count for fast estimates on large tables",
          "TanStack Query with a 60s default staleTime reduces refetches",
          "Sorting on Raw Leads is intentionally page-local to avoid full-table sorts on large datasets",
          "Heavy dialogs (LeadForm, DraftsDialog, LeadDetailDialog) are lazy-loaded with Suspense fallbacks",
          "Partial indexes on raw_lead_cache speed up the common assignment/status filters",
          "No unnecessary Realtime counters — counts refresh on user action, not on every DB event",
        ],
      },
    ],
  },
  {
    id: "stack",
    number: 31,
    title: "Technical Stack",
    blocks: [
      {
        kind: "table",
        headers: ["Layer", "Technology"],
        rows: [
          ["Frontend", "React 19"],
          ["Framework", "TanStack Start 1.x"],
          ["Routing", "TanStack Router (file-based)"],
          ["UI", "shadcn/ui + Tailwind CSS v4"],
          ["State/Data", "TanStack Query 5"],
          ["Forms", "react-hook-form + zod"],
          ["Charts", "Recharts"],
          ["Maps", "Leaflet + react-leaflet"],
          ["Backend", "Supabase (Postgres + Auth + Realtime + Storage)"],
          ["Database", "PostgreSQL with Row Level Security"],
          ["Authentication", "Supabase Auth (password only)"],
          ["Realtime", "Supabase Realtime channels"],
          ["Storage", "Supabase Storage (private lead-attachments bucket)"],
          ["Edge/Server", "createServerFn + server route handlers"],
          ["Build/Deploy", "Vite 7 + Cloudflare Workers runtime"],
        ],
      },
      {
        kind: "p",
        text: "Exact versions are pinned in package.json. Refer to that file for precise dependency versions.",
      },
    ],
  },
  {
    id: "inconsistencies",
    number: 32,
    title: "Known Implementation Inconsistencies",
    blocks: [
      {
        kind: "p",
        text: "The following mismatches exist between different parts of the codebase at the time this documentation was generated. They do not block usage but are worth cleaning up.",
      },
      {
        kind: "ul",
        items: [
          "The app_role Postgres enum still contains 'scraping' and some sidebar / RoleGate arrays reference it, but the Create User form (adminCreateUser roleSchema) no longer offers 'scraping' — new users are provisioned as 'maturing' instead.",
          "The lead-attachments storage bucket has bucket.public = true at the storage level (migration 20260707130000), yet the client code only ever generates signed URLs and never exposes public URLs. Behavior is effectively private, but the bucket flag should be flipped back to private for defense-in-depth.",
          "Some legacy migrations reference a 'processor' role that no longer exists in the current AppRole union; these have no runtime effect because role checks match by string but the migrations remain in history.",
        ],
      },
    ],
  },
];
