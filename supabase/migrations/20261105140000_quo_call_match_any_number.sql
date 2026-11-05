-- Quo calls: match the lead on any number in the call.
--
-- The live call.completed payload has no numbers on the call itself; they sit
-- in context entries whose roles and key names are not fixed (our own line can
-- be listed next to the customer). The webhook now passes every number it
-- found (p_phones) and a call marks each lead matching any of them. Messages
-- are unchanged and still match on the single customer number. For calls the
-- result also reports how many leads were updated ('leads'), which the webhook
-- logs so a missed call is visible.

DROP FUNCTION IF EXISTS public.accept_quo_webhook_event(text, text, text, text, text);
CREATE FUNCTION public.accept_quo_webhook_event(
  p_webhook_id text,
  p_event_type text,
  p_phone text,
  p_direction text DEFAULT NULL,
  p_category text DEFAULT 'message',
  p_phones text[] DEFAULT NULL
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
  v_numbers text[];
  v_leads integer := 0;
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
  -- A call names its parties in places that differ between Quo payloads, so
  -- the webhook sends every number it found and a lead matching any of them
  -- is the one called. Our own Quo lines belong to no lead.
  v_numbers := ARRAY(
    SELECT DISTINCT n FROM (
      SELECT public.lead_ai_phone(x) AS n
      FROM unnest(ARRAY[p_phone] || CASE WHEN v_category = 'call'
                                      THEN coalesce(p_phones, '{}'::text[])
                                      ELSE '{}'::text[] END) AS x
    ) s WHERE n IS NOT NULL
  );
  IF normalized IS NULL AND v_category = 'call' THEN normalized := v_numbers[1]; END IF;
  IF normalized IS NULL THEN
    RETURN jsonb_build_object('duplicate', false, 'matched', 0, 'reason', 'unparseable_phone');
  END IF;

  IF v_direction = 'inbound' AND v_category = 'call' THEN
    UPDATE public.qualified_leads q
       SET quo_first_reply_at = now(), quo_reach_out_updated_at = now()
     WHERE q.cs_status <> 'need_follow_up' AND q.quo_first_reply_at IS NULL
       AND (public.lead_ai_phone(q.customer_number) = ANY(v_numbers)
         OR public.lead_ai_phone(q.customer_number_2) = ANY(v_numbers)
         OR public.lead_ai_extra_phones(q.extra_numbers) && v_numbers);
    GET DIAGNOSTICS v_leads = ROW_COUNT;
  ELSIF v_direction = 'inbound' THEN
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
       AND (public.lead_ai_phone(q.customer_number) = ANY(v_numbers)
         OR public.lead_ai_phone(q.customer_number_2) = ANY(v_numbers)
         OR public.lead_ai_extra_phones(q.extra_numbers) && v_numbers);
    GET DIAGNOSTICS v_leads = ROW_COUNT;
  ELSIF v_direction = 'outbound' AND p_event_type = 'message.delivered' THEN
    UPDATE public.qualified_leads q
       SET quo_outbound_messages = q.quo_outbound_messages + 1, quo_reach_out_updated_at = now()
     WHERE q.cs_status <> 'need_follow_up' AND q.quo_first_reply_at IS NULL
       AND (public.lead_ai_phone(q.customer_number) = normalized
         OR public.lead_ai_phone(q.customer_number_2) = normalized
         OR public.lead_ai_extra_phones(q.extra_numbers) @> ARRAY[normalized]);
  END IF;

  IF v_category <> 'message' THEN
    RETURN jsonb_build_object('duplicate', false, 'matched', 0, 'reason', 'call_counted',
                              'leads', v_leads);
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


REVOKE ALL ON FUNCTION public.accept_quo_webhook_event(text, text, text, text, text, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_quo_webhook_event(text, text, text, text, text, text[])
  TO service_role;

NOTIFY pgrst, 'reload schema';
