-- Optional delay before the Crisp auto-greeting is sent to a new live visitor.
--
-- auto_greet_delay_seconds (per workspace) is how long to wait after a visitor
-- is first seen live before greeting them. The webhook schedules a due time on
-- the visitor (auto_greet_due_at) on the first live sighting and only sends once
-- that time has passed, so a 0s delay still greets immediately.

ALTER TABLE public.crisp_workspaces
    ADD COLUMN IF NOT EXISTS auto_greet_delay_seconds INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'crisp_workspaces_auto_greet_delay_check'
          AND conrelid = 'public.crisp_workspaces'::regclass
    ) THEN
        ALTER TABLE public.crisp_workspaces
            ADD CONSTRAINT crisp_workspaces_auto_greet_delay_check
            CHECK (auto_greet_delay_seconds >= 0 AND auto_greet_delay_seconds <= 3600);
    END IF;
END $$;

ALTER TABLE public.crisp_visitors
    ADD COLUMN IF NOT EXISTS auto_greet_due_at TIMESTAMPTZ;
