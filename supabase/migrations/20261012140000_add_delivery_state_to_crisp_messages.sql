-- Track per-message delivery state for Crisp operator messages.
--
-- Crisp emits message acknowledgement events (message:acknowledge:delivered and
-- message:acknowledge:read:*) carrying the fingerprints of messages that were
-- delivered to / read by the visitor. The webhook upgrades this column so the
-- inbox can show Sent -> Delivered -> Seen ticks under outgoing messages.
--
-- Incoming (customer) messages keep the default 'sent'; the UI only renders
-- ticks for outgoing operator messages.

ALTER TABLE public.crisp_messages
    ADD COLUMN IF NOT EXISTS delivery_state TEXT NOT NULL DEFAULT 'sent';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'crisp_messages_delivery_state_check'
          AND conrelid = 'public.crisp_messages'::regclass
    ) THEN
        ALTER TABLE public.crisp_messages
            ADD CONSTRAINT crisp_messages_delivery_state_check
            CHECK (delivery_state IN ('sent', 'delivered', 'seen'));
    END IF;
END $$;

-- Acknowledgement events look messages up by (website, session, fingerprint).
CREATE INDEX IF NOT EXISTS idx_crisp_messages_ack_lookup
    ON public.crisp_messages (crisp_website_id, crisp_session_id, crisp_message_id);
