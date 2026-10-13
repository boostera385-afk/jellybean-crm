-- Per-workspace auto-greeting for new live Crisp visitors.
--
-- When enabled on a workspace, the Crisp webhook proactively sends the
-- configured template the first time a visitor is live (once per visitor,
-- and only if they have not already started a conversation). auto_greeted_at
-- on crisp_visitors is the idempotency guard that keeps it to a single send.

ALTER TABLE public.crisp_workspaces
    ADD COLUMN IF NOT EXISTS auto_greet_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.crisp_workspaces
    ADD COLUMN IF NOT EXISTS auto_greet_message TEXT;

ALTER TABLE public.crisp_visitors
    ADD COLUMN IF NOT EXISTS auto_greeted_at TIMESTAMPTZ;
