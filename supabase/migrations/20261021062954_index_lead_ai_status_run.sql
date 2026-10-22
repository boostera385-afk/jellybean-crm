-- Cover the audit-run foreign key for delete/update checks.
CREATE INDEX lead_ai_status_run_id ON public.lead_ai_status(run_id);
