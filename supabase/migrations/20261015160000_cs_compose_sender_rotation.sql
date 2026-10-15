-- Rotating sender name for composed CS messages.
--
-- Every composed message used to say "Alex": the default Schedule Visit
-- template hardcodes "this is Alex", and the other templates carry no name at
-- all so extractSenderName() fell through to a literal "Alex" default.
--
-- The roster itself lives in src/lib/compose-senders.ts. This provides only the
-- shared counter, because the switch has to happen roughly every 10 leads
-- ACROSS requests and server instances - an in-process counter would reset on
-- redeploy and diverge between instances, and hashing the lead id would give a
-- different name per lead rather than a run of ten.
--
-- A sequence is used rather than a row so concurrent composes cannot collide:
-- nextval is atomic and takes no row lock. The raw tick is returned and the
-- grouping (tick / 10 % roster length) is applied in TypeScript, so names can
-- be added or removed without another migration.
CREATE SEQUENCE IF NOT EXISTS public.cs_compose_sender_seq AS bigint START 1 INCREMENT 1;

CREATE OR REPLACE FUNCTION public.cs_next_compose_sender_tick()
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT nextval('public.cs_compose_sender_seq');
$$;

REVOKE ALL ON FUNCTION public.cs_next_compose_sender_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cs_next_compose_sender_tick() TO service_role;
REVOKE ALL ON SEQUENCE public.cs_compose_sender_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.cs_compose_sender_seq TO service_role;
