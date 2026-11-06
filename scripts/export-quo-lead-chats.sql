-- Export: one row per backfilled lead -- the status it was marked with, who
-- marked it, the AI's reading, and the saved Quo conversation in order.
-- Run with the service role (private schema). Page with OFFSET/LIMIT.
SELECT jsonb_build_object(
  'lead_id', q.id,
  'created_at', q.created_at,
  'assigned_at', q.assigned_at,
  'service', q.service,
  'inbox', q.number_name,
  'status', q.cs_status,
  'status_set_by', q.cs_status_updated_by_name,
  'status_history', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'from', h.from_status, 'to', h.to_status, 'source', h.source,
      'by', h.changed_by_name, 'at', h.changed_at) ORDER BY h.changed_at, h.id), '[]')
    FROM public.lead_status_history h WHERE h.lead_id = q.id),
  'ai_state', a.state,
  'ai_status', a.ai_status,
  'ai_confidence', a.confidence,
  'ai_reason', a.reason_code,
  'backfill', b.state,
  'backfill_reason', b.reason,
  'messages', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'at', m.message_created_at,
      'dir', CASE m.direction WHEN 'incoming' THEN 'customer' ELSE 'us' END,
      'text', m.body,
      'delivery', m.status,
      'media', m.has_media) ORDER BY m.message_created_at, m.id), '[]')
    FROM private.quo_messages m WHERE q.id = ANY (m.lead_ids))
) AS row
FROM private.quo_message_backfill b
JOIN public.qualified_leads q ON q.id = b.lead_id
LEFT JOIN public.lead_ai_status a ON a.lead_id = q.id
ORDER BY q.created_at DESC, q.id
OFFSET 0 LIMIT 250;
