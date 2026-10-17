-- Run after the composer migration. All temporary fixture writes roll back.
BEGIN;
DO $test$
DECLARE
  j uuid;
  nonce text := gen_random_uuid()::text;
  a uuid;
  l uuid;
  v uuid;
BEGIN
  IF has_table_privilege('anon', 'public.cs_compose_eval_jobs', 'SELECT')
    OR has_table_privilege('authenticated', 'public.cs_compose_runs', 'INSERT')
    OR has_function_privilege('authenticated', 'public.cs_claim_compose_eval(uuid,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.cs_reserve_compose_run(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Composer metadata/RPCs are exposed to browser roles';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('cs_compose_runs', 'cs_compose_eval_jobs')
      AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION 'Composer RLS is not enabled';
  END IF;

  INSERT INTO public.cs_compose_eval_jobs(token_hash, cases)
  VALUES (encode(sha256(convert_to(nonce, 'UTF8')), 'hex'), '[{"input":{}}]'::jsonb)
  RETURNING id INTO j;
  IF public.cs_claim_compose_eval(j, 'wrong') IS NOT NULL THEN RAISE EXCEPTION 'Bad ticket accepted'; END IF;
  IF public.cs_claim_compose_eval(j, nonce) IS NULL THEN RAISE EXCEPTION 'Valid ticket rejected'; END IF;
  IF public.cs_claim_compose_eval(j, nonce) IS NOT NULL THEN RAISE EXCEPTION 'Replay accepted'; END IF;

  INSERT INTO public.cs_compose_eval_jobs(token_hash, cases, expires_at)
  VALUES (encode(sha256(convert_to(nonce, 'UTF8')), 'hex'), '[{"input":{}}]'::jsonb, now() - interval '1 minute')
  RETURNING id INTO j;
  IF public.cs_claim_compose_eval(j, nonce) IS NOT NULL THEN RAISE EXCEPTION 'Expired ticket accepted'; END IF;

  -- Optional integration fixture: rate limit on an existing actor and lead.
  -- The advisory lock and temporary rows are released by ROLLBACK below.
  SELECT user_id INTO a FROM public.user_roles WHERE role::text = 'admin' LIMIT 1;
  SELECT id INTO l FROM public.qualified_leads LIMIT 1;
  IF a IS NOT NULL AND l IS NOT NULL THEN
    FOR i IN 1..30 LOOP
      v := public.cs_reserve_compose_run(a, l, 'qa-test', 'qa-transaction');
      IF v IS NULL THEN EXIT; END IF;
    END LOOP;
    IF public.cs_reserve_compose_run(a, l, 'qa-test', 'qa-transaction') IS NOT NULL THEN
      RAISE EXCEPTION 'Rate limit not enforced';
    END IF;
  END IF;
  RAISE NOTICE 'Composer privilege, RLS, ticket expiry/replay and rate checks passed';
END $test$;
ROLLBACK;
