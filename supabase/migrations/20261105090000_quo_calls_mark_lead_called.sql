-- Completed Quo calls must take a lead out of "not called yet".
--
-- Two gaps kept every called lead on "not called yet":
--   1. The webhook dropped call.completed deliveries whose numbers were not in
--      the message-style context keys (fixed in quo-webhook-event.ts).
--   2. A call placed after the customer's first reply was never recorded, because
--      the reach-out tally freezes on the first reply. A customer who texts back
--      and is then called stayed "not called" forever.
--
-- quo_last_call_at records the latest completed outbound Quo call regardless of
-- replies. "Called" now means a manual call (called_at), a counted Quo call, or
-- any completed Quo call. called_at stays human-owned: it is tied to the card's
-- Texted/Called toggle, so the webhook never writes it.

ALTER TABLE public.qualified_leads
  ADD COLUMN IF NOT EXISTS quo_last_call_at timestamptz;

UPDATE public.qualified_leads
   SET quo_last_call_at = coalesce(quo_reach_out_updated_at, now())
 WHERE quo_outbound_calls > 0 AND quo_last_call_at IS NULL;

CREATE OR REPLACE FUNCTION public.accept_quo_webhook_event(
  p_webhook_id text,
  p_event_type text,
  p_phone text,
  p_direction text DEFAULT NULL,
  p_category text DEFAULT 'message'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  normalized text;
  v_reason text;
  inserted integer;
  matched integer := 0;
  v_category text := COALESCE(NULLIF(p_category, ''), 'message');
  v_direction text;
BEGIN
  IF p_webhook_id IS NULL OR length(p_webhook_id) NOT BETWEEN 1 AND 200
    OR p_event_type IS NULL OR length(p_event_type) > 80 THEN
    RAISE EXCEPTION 'Invalid webhook event';
  END IF;
  IF v_category NOT IN ('message', 'call') THEN RAISE EXCEPTION 'Invalid event category'; END IF;
  v_direction := CASE
    WHEN p_direction IN ('inbound', 'outbound') THEN p_direction
    WHEN p_event_type = 'message.received' THEN 'inbound'
    WHEN p_event_type IN ('message.delivered', 'message.undelivered') THEN 'outbound'
    ELSE NULL END;

  INSERT INTO private.quo_webhook_deliveries(webhook_id, event_type)
    VALUES (p_webhook_id, p_event_type) ON CONFLICT (webhook_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN jsonb_build_object('duplicate', true, 'matched', 0); END IF;

  normalized := public.lead_ai_phone(p_phone);
  IF normalized IS NULL THEN
    RETURN jsonb_build_object('duplicate', false, 'matched', 0, 'reason', 'unparseable_phone');
  END IF;

  IF v_direction = 'inbound' THEN
    UPDATE public.qualified_leads q
       SET quo_first_reply_at = now(), quo_reach_out_updated_at = now()
     WHERE q.cs_status <> 'need_follow_up' AND q.quo_first_reply_at IS NULL
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR public.lead_ai_extra_phones(q.extra_numbers) @> ARRAY[normalized]);
  ELSIF v_direction = 'outbound' AND v_category = 'call' THEN
    -- Any completed call we place marks the lead as called, even after the
    -- customer has replied. The pre-reply tally still only moves before the
    -- first reply, so the "tries until they responded" count is unchanged.
    UPDATE public.qualified_leads q
       SET quo_last_call_at = now(),
           quo_outbound_calls = q.quo_outbound_calls
             + CASE WHEN q.quo_first_reply_at IS NULL THEN 1 ELSE 0 END,
           quo_reach_out_updated_at = now()
     WHERE q.cs_status <> 'need_follow_up'
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR public.lead_ai_extra_phones(q.extra_numbers) @> ARRAY[normalized]);
  ELSIF v_direction = 'outbound' AND p_event_type = 'message.delivered' THEN
    UPDATE public.qualified_leads q
       SET quo_outbound_messages = q.quo_outbound_messages + 1, quo_reach_out_updated_at = now()
     WHERE q.cs_status <> 'need_follow_up' AND q.quo_first_reply_at IS NULL
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR public.lead_ai_extra_phones(q.extra_numbers) @> ARRAY[normalized]);
  END IF;

  IF v_category <> 'message' THEN
    RETURN jsonb_build_object('duplicate', false, 'matched', 0, 'reason', 'call_counted');
  END IF;
  v_reason := CASE p_event_type
    WHEN 'message.received' THEN 'customer_replied'
    WHEN 'message.undelivered' THEN 'delivery_failed'
    ELSE 'delivery_confirmed' END;

  WITH touched AS (
    INSERT INTO private.lead_ai_recheck_queue AS rq (lead_id, reason)
    SELECT q.id, v_reason
    FROM public.qualified_leads q
    WHERE q.cs_status <> 'need_follow_up'
      AND q.ai_status_automation_started_at IS NOT NULL
      AND q.created_at >= public.quo_ai_scope_start()
      AND (public.lead_ai_phone(q.customer_number) = normalized
        OR public.lead_ai_phone(q.customer_number_2) = normalized
        OR EXISTS (
          SELECT 1 FROM unnest(q.extra_numbers) n WHERE public.lead_ai_phone(n) = normalized
        ))
    ON CONFLICT (lead_id) DO UPDATE
      SET reason = excluded.reason, requested_at = now()
    RETURNING rq.lead_id
  )
  SELECT count(*)::integer INTO matched FROM touched;
  RETURN jsonb_build_object('duplicate', false, 'matched', matched, 'reason', v_reason);
END
$$;

REVOKE ALL ON FUNCTION public.accept_quo_webhook_event(text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_quo_webhook_event(text, text, text, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.report_cs_reachout_counts(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT COALESCE(jsonb_object_agg(status, counts), '{}'::jsonb)
  FROM (
    SELECT q.cs_status::text AS status,
      jsonb_build_object(
        'called', count(*) FILTER (
          WHERE q.called_at IS NOT NULL OR q.quo_last_call_at IS NOT NULL
             OR q.quo_outbound_calls > 0),
        'not_called', count(*) FILTER (
          WHERE q.called_at IS NULL AND q.quo_last_call_at IS NULL
            AND q.quo_outbound_calls = 0)
      ) AS counts
    FROM public.qualified_leads AS q
    WHERE (p_from IS NULL OR q.assigned_at >= p_from)
      AND (p_to IS NULL OR q.assigned_at < p_to)
    GROUP BY q.cs_status
  ) AS counts;
$$;

CREATE OR REPLACE FUNCTION public.cs_leads_status_counts_filtered(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_owner uuid DEFAULT NULL,
  p_unassigned boolean DEFAULT false,
  p_not_called boolean DEFAULT false,
  p_important boolean DEFAULT false,
  p_search text DEFAULT NULL,
  p_phone text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  requester_id uuid := (SELECT auth.uid());
  search_like text := CASE WHEN p_search IS NULL OR btrim(p_search) = '' THEN NULL ELSE '%'||p_search||'%' END;
  phone_like text;
  result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = requester_id AND role::text IN ('admin','sub_admin','cs','cs_admin')
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  phone_like := coalesce(p_phone,search_like);

  WITH filtered AS MATERIALIZED (
    SELECT q.cs_status,q.ai_review_required,q.cs_status_updated_by_ai,q.cs_status_human_updated_at
    FROM public.qualified_leads q
    WHERE (p_date_from IS NULL OR q.assigned_at >= p_date_from)
      AND (p_date_to IS NULL OR q.assigned_at < p_date_to)
      AND CASE
        WHEN p_unassigned THEN q.assigned_to IS NULL
        WHEN p_owner IS NOT NULL THEN q.assigned_to = p_owner
        ELSE true END
      AND (NOT p_not_called OR (q.called_at IS NULL AND q.quo_last_call_at IS NULL AND q.quo_outbound_calls = 0))
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
  ), counts AS (
    SELECT cs_status,count(*)::bigint AS status_count FROM filtered GROUP BY cs_status
  )
  SELECT jsonb_build_object(
    'all', (SELECT count(*)::bigint FROM filtered),
    'needsReview', (SELECT count(*)::bigint FROM filtered
      WHERE ai_review_required
        AND NOT (cs_status_updated_by_ai = false AND cs_status_human_updated_at IS NOT NULL)),
    'statuses', coalesce(jsonb_object_agg(cs_status::text,status_count),'{}'::jsonb)
  ) INTO result FROM counts;
  RETURN coalesce(result,jsonb_build_object('all',0,'needsReview',0,'statuses','{}'::jsonb));
END
$$;

NOTIFY pgrst, 'reload schema';
