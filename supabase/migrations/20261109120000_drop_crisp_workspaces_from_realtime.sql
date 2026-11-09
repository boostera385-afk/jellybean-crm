-- crisp_workspaces is rewritten every few seconds by background bookkeeping
-- (visitor-sync leases, request budgets, last_seen_at / presence timestamps),
-- ~45k row updates a day across ~13 rows. Every one of those was broadcast to
-- every subscribed browser tab and billed as a Realtime message, while the
-- clients discarded almost all of them. No client subscribes to this table any
-- more (unread totals follow crisp_conversations; live visitors follow
-- crisp_visitors; settings edits are picked up by the 30s heartbeat), so stop
-- publishing it. Greetings and sync run server-side and are unaffected.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'crisp_workspaces'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.crisp_workspaces;
  END IF;
END $$;
