-- Reach-out tally: how many times we messaged or called a customer before they
-- first replied. The number the user asked for on each lead card ("1 message",
-- "1 message and 1 call", or "not called yet") and the message-only vs
-- message-and-call split on the Delivered and CX-didn't-reply reports.
--
-- This is driven entirely by the Quo webhook, so it counts reach-outs from now
-- on: leads that were already contacted before this shipped start at zero, which
-- is why the counters are plain integers that only ever move forward until the
-- customer replies. An inbound event (a text back, or a call from the customer)
-- freezes the tally by stamping quo_first_reply_at; outbound events after that
-- are ignored, because the question is "how many tries until they responded".
--
-- Nothing here writes qualified_leads.cs_status: still comparison-only.

ALTER TABLE public.qualified_leads
  ADD COLUMN quo_outbound_messages integer NOT NULL DEFAULT 0
    CHECK (quo_outbound_messages >= 0),
  ADD COLUMN quo_outbound_calls integer NOT NULL DEFAULT 0
    CHECK (quo_outbound_calls >= 0),
  -- First inbound event seen after reach-out began; null until the customer
  -- responds. Once set, the counters above stop moving.
  ADD COLUMN quo_first_reply_at timestamptz,
  ADD COLUMN quo_reach_out_updated_at timestamptz;

-- ── Accept one verified webhook delivery (now also counts reach-outs) ────────
-- Replaces 20261022150000's version. New optional arguments keep the old
-- three-argument call working: p_direction falls back to the event name, and
-- p_category defaults to 'message', so message-only callers are unchanged.
DROP FUNCTION IF EXISTS public.accept_quo_webhook_event(text, text, text);
CREATE FUNCTION public.accept_quo_webhook_event(
  p_webhook_id text, p_event_type text, p_phone text,
  p_direction text DEFAULT NULL, p_category text DEFAULT 'message'
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  normalized text; v_reason text; inserted integer; matched integer := 0;
  v_category text := COALESCE(NULLIF(p_category, ''), 'message');
  v_direction text;
BEGIN
  IF p_webhook_id IS NULL OR length(p_webhook_id) NOT BETWEEN 1 AND 200
    OR p_event_type IS NULL OR length(p_event_type) > 80 THEN
    RAISE EXCEPTION 'Invalid webhook event';
  END IF;
  IF v_category NOT IN ('message', 'call') THEN RAISE EXCEPTION 'Invalid event category'; END IF;
  -- Direction is authoritative when given; otherwise inferred from the message
  -- event name (a call never reaches here without a direction).
  v_direction := CASE
    WHEN p_direction IN ('inbound', 'outbound') THEN p_direction
    WHEN p_event_type = 'message.received' THEN 'inbound'
    WHEN p_event_type IN ('message.delivered', 'message.undelivered') THEN 'outbound'
    ELSE NULL END;

  -- Idempotency before anything else: a retry must not re-queue or re-count.
  INSERT INTO private.quo_webhook_deliveries(webhook_id, event_type)
    VALUES (p_webhook_id, p_event_type) ON CONFLICT (webhook_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN jsonb_build_object('duplicate', true, 'matched', 0); END IF;

  normalized := public.lead_ai_phone(p_phone);
  IF normalized IS NULL THEN
    RETURN jsonb_build_object('duplicate', false, 'matched', 0, 'reason', 'unparseable_phone');
  END IF;

  -- ── Reach-out tally ───────────────────────────────────────────────────────
  -- Every lead the number matches, the same set the recheck below parks, so the
  -- two never disagree about which lead a number belongs to. Manual follow-up
  -- leads are left out exactly as they are from the recheck.
  IF v_direction = 'inbound' THEN
    UPDATE public.qualified_leads q
       SET quo_first_reply_at = now(), quo_reach_out_updated_at = now()
     WHERE q.cs_status <> 'need_follow_up' AND q.quo_first_reply_at IS NULL
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR public.lead_ai_extra_phones(q.extra_numbers) @> ARRAY[normalized]);
  ELSIF v_direction = 'outbound' AND v_category = 'call' THEN
    UPDATE public.qualified_leads q
       SET quo_outbound_calls = q.quo_outbound_calls + 1, quo_reach_out_updated_at = now()
     WHERE q.cs_status <> 'need_follow_up' AND q.quo_first_reply_at IS NULL
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR public.lead_ai_extra_phones(q.extra_numbers) @> ARRAY[normalized]);
  ELSIF v_direction = 'outbound' AND p_event_type = 'message.delivered' THEN
    -- Only a delivered message is a reach-out that reached the customer; an
    -- undelivered one is a failed attempt, tracked by the AI undeliver status.
    UPDATE public.qualified_leads q
       SET quo_outbound_messages = q.quo_outbound_messages + 1, quo_reach_out_updated_at = now()
     WHERE q.cs_status <> 'need_follow_up' AND q.quo_first_reply_at IS NULL
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR public.lead_ai_extra_phones(q.extra_numbers) @> ARRAY[normalized]);
  END IF;

  -- ── AI recheck queue (messages only; calls are never analyzed) ─────────────
  IF v_category <> 'message' THEN
    RETURN jsonb_build_object('duplicate', false, 'matched', 0, 'reason', 'call_counted');
  END IF;
  v_reason := CASE p_event_type
    WHEN 'message.received' THEN 'customer_replied'
    WHEN 'message.undelivered' THEN 'delivery_failed'
    ELSE 'delivery_confirmed' END;
  WITH touched AS (
    INSERT INTO private.lead_ai_recheck_queue AS rq (lead_id, reason)
    SELECT q.id, v_reason FROM public.qualified_leads q
     WHERE q.cs_status <> 'need_follow_up'
       AND q.created_at >= public.quo_ai_scope_start()
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR EXISTS (SELECT 1 FROM unnest(q.extra_numbers) n
                    WHERE public.lead_ai_phone(n) = normalized))
    ON CONFLICT (lead_id) DO UPDATE
      SET reason = excluded.reason, requested_at = now()
    RETURNING rq.lead_id
  ) SELECT count(*)::integer INTO matched FROM touched;
  RETURN jsonb_build_object('duplicate', false, 'matched', matched, 'reason', v_reason);
END $$;

REVOKE ALL ON FUNCTION public.accept_quo_webhook_event(text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_quo_webhook_event(text, text, text, text, text)
  TO service_role;

-- ── Reports: called vs not-called split, per CS status ──────────────────────
-- For the Delivered and CX-didn't-reply cards: how many leads we reached with a
-- call (manual called_at, or a counted Quo call) versus message-only / not
-- called yet. SECURITY INVOKER keeps the same RLS visibility as the other
-- report_* counters.
CREATE FUNCTION public.report_cs_reachout_counts(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT COALESCE(jsonb_object_agg(status, counts), '{}'::jsonb)
  FROM (
    SELECT q.cs_status::text AS status,
      jsonb_build_object(
        'called', count(*) FILTER (
          WHERE q.called_at IS NOT NULL OR q.quo_outbound_calls > 0),
        'not_called', count(*) FILTER (
          WHERE q.called_at IS NULL AND q.quo_outbound_calls = 0)
      ) AS counts
    FROM public.qualified_leads AS q
    WHERE (p_from IS NULL OR q.assigned_at >= p_from)
      AND (p_to IS NULL OR q.assigned_at < p_to)
    GROUP BY q.cs_status
  ) AS counts;
$$;
REVOKE ALL ON FUNCTION public.report_cs_reachout_counts(timestamptz, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_cs_reachout_counts(timestamptz, timestamptz)
  TO authenticated, service_role;

-- ── "Not called yet" now means no call at all, manual OR Quo ─────────────────
-- Identical to 20261026090000's version apart from the p_not_called predicate,
-- so the CS-pipeline "Not called" filter and its status chip counts agree with
-- the report split: a lead with a counted Quo call is no longer "not called".
CREATE OR REPLACE FUNCTION public.cs_leads_status_counts_filtered(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_owner uuid DEFAULT NULL,
  p_unassigned boolean DEFAULT false,
  p_not_called boolean DEFAULT false,
  p_important boolean DEFAULT false,
  p_search text DEFAULT NULL,
  p_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  requester_id uuid := (SELECT auth.uid());
  search_like text := CASE WHEN p_search IS NULL OR btrim(p_search) = '' THEN NULL
                           ELSE '%' || p_search || '%' END;
  phone_like text;
  result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = requester_id
      AND role::text IN ('admin', 'sub_admin', 'cs', 'cs_admin')
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  phone_like := COALESCE(p_phone, search_like);

  SELECT jsonb_build_object(
    'all', COALESCE(sum(status_count), 0),
    'statuses', COALESCE(
      jsonb_object_agg(cs_status::text, status_count),
      '{}'::jsonb
    )
  )
  INTO result
  FROM (
    SELECT q.cs_status, count(*)::bigint AS status_count
    FROM public.qualified_leads AS q
    WHERE (p_date_from IS NULL OR q.assigned_at >= p_date_from)
      AND (p_date_to IS NULL OR q.assigned_at < p_date_to)
      AND (
            CASE
              WHEN p_unassigned THEN q.assigned_to IS NULL
              WHEN p_owner IS NOT NULL THEN q.assigned_to = p_owner
              ELSE true
            END
          )
      AND (NOT p_not_called OR (q.called_at IS NULL AND q.quo_outbound_calls = 0))
      AND (NOT p_important OR q.is_important IS TRUE)
      AND (
            search_like IS NULL
            OR q.customer_name ILIKE search_like
            OR q.customer_number ILIKE phone_like
            OR q.customer_number_2 ILIKE phone_like
            OR q.number_name ILIKE search_like
            OR q.main_area ILIKE search_like
            OR q.sub_area ILIKE search_like
            OR q.pass_it_to ILIKE search_like
            OR q.requirement_1 ILIKE search_like
            OR q.requirement_2 ILIKE search_like
          )
    GROUP BY q.cs_status
  ) AS counts;

  RETURN COALESCE(
    result,
    jsonb_build_object('all', 0, 'statuses', '{}'::jsonb)
  );
END
$function$;

NOTIFY pgrst, 'reload schema';
