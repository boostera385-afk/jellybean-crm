-- Applied through MCP as version 20261017040730.
-- Draft audit/rate-limit metadata only: never store customer text or credentials.
CREATE TABLE public.cs_compose_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES public.qualified_leads(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started', 'success', 'failed')),
  model text NOT NULL,
  prompt_version text NOT NULL,
  duration_ms integer CHECK (duration_ms >= 0),
  question_keys text[] NOT NULL DEFAULT '{}',
  warnings text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX cs_compose_runs_actor_time_idx ON public.cs_compose_runs (actor_id, created_at DESC);
CREATE INDEX cs_compose_runs_lead_idx ON public.cs_compose_runs (lead_id);
ALTER TABLE public.cs_compose_runs ENABLE ROW LEVEL SECURITY;
-- Intentionally no client policies. Only the server role can read/write audits.
REVOKE ALL ON public.cs_compose_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cs_compose_runs TO service_role;

CREATE FUNCTION public.cs_reserve_compose_run(
  p_actor_id uuid, p_lead_id uuid, p_model text, p_version text
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_lead_id IS NULL THEN
    RAISE EXCEPTION 'actor and lead are required';
  END IF;
  -- Atomic across concurrent Edge isolates; browser roles cannot execute this.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_id::text, 0));
  IF (SELECT count(*) FROM public.cs_compose_runs
      WHERE actor_id = p_actor_id AND created_at > now() - interval '1 minute') >= 30 THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.cs_compose_runs(actor_id, lead_id, model, prompt_version)
  VALUES (p_actor_id, p_lead_id, p_model, p_version) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.cs_reserve_compose_run(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cs_reserve_compose_run(uuid, uuid, text, text) TO service_role;

-- Scoped QA jobs let a database administrator run regression fixtures INSIDE
-- the sealed-key runtime. There is no key export, user impersonation, anonymous
-- arbitrary-prompt endpoint, or write to live customer drafts. Each ticket is
-- random, hashed, expires quickly, and can be claimed exactly once.
CREATE TABLE public.cs_compose_eval_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL CHECK (length(token_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  cases jsonb NOT NULL CHECK (jsonb_typeof(cases) = 'array' AND jsonb_array_length(cases) BETWEEN 1 AND 12),
  results jsonb,
  completed_at timestamptz
);
ALTER TABLE public.cs_compose_eval_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cs_compose_eval_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cs_compose_eval_jobs TO service_role;
CREATE FUNCTION public.cs_claim_compose_eval(p_job_id uuid, p_token text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  UPDATE public.cs_compose_eval_jobs SET status = 'running'
  WHERE id = p_job_id AND status = 'pending' AND expires_at > now()
    AND token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex')
  RETURNING cases;
$$;
REVOKE ALL ON FUNCTION public.cs_claim_compose_eval(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cs_claim_compose_eval(uuid, text) TO service_role;

-- Remove the v1 address-first override without losing the previous saved text.
-- V2 uses the versioned policy in code; the editor is for optional STYLE only.
UPDATE public.shared_state
SET value = jsonb_build_object(
  'text', '',
  'policyVersion', '2026-10-17.answer-aware-v2',
  'previous', value
), updated_at = now()
WHERE key = 'cs_rephrase_prompt'
  AND value->>'policyVersion' IS DISTINCT FROM '2026-10-17.answer-aware-v2';
