-- Track anonymous Crisp visitors independently from chat conversations.
-- A visitor can be visible in Crisp before they send their first message.

ALTER TABLE public.crisp_workspaces
    ADD COLUMN IF NOT EXISTS visitor_synced_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS live_visitor_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS active_visitor_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS visitors_limited BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION public.claim_crisp_visitor_sync(
    p_website_id TEXT,
    p_stale_before TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rows INTEGER;
BEGIN
    UPDATE public.crisp_workspaces
    SET visitor_synced_at = NOW(), updated_at = NOW()
    WHERE crisp_website_id = p_website_id
      AND enabled = TRUE
      AND (visitor_synced_at IS NULL OR visitor_synced_at < p_stale_before);

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_crisp_visitor_sync(TEXT, TIMESTAMPTZ) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_crisp_visitor_sync(TEXT, TIMESTAMPTZ) TO service_role;

CREATE TABLE IF NOT EXISTS public.crisp_visitors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    crisp_website_id TEXT NOT NULL,
    crisp_session_id TEXT NOT NULL,
    nickname TEXT,
    email TEXT,
    avatar TEXT,
    user_agent TEXT,
    initiated BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    is_online BOOLEAN NOT NULL DEFAULT FALSE,
    last_page_title TEXT,
    last_page_url TEXT,
    country TEXT,
    region TEXT,
    city TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    timezone_minutes INTEGER,
    capabilities TEXT[] NOT NULL DEFAULT '{}',
    locales TEXT[] NOT NULL DEFAULT '{}',
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_online_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT crisp_visitors_website_session_key UNIQUE (crisp_website_id, crisp_session_id)
);

CREATE TABLE IF NOT EXISTS public.crisp_visitor_daily_visits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    crisp_website_id TEXT NOT NULL,
    crisp_session_id TEXT NOT NULL,
    visit_date DATE NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT crisp_visitor_daily_visits_key UNIQUE (
        crisp_website_id,
        crisp_session_id,
        visit_date
    )
);

CREATE INDEX IF NOT EXISTS idx_crisp_visitors_online
    ON public.crisp_visitors (crisp_website_id, is_online, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_crisp_visitors_last_seen
    ON public.crisp_visitors (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_crisp_visitor_daily_visits_date
    ON public.crisp_visitor_daily_visits (visit_date DESC, crisp_website_id, last_seen_at DESC);

ALTER TABLE public.crisp_visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crisp_visitor_daily_visits ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.crisp_visitors TO authenticated;
GRANT SELECT ON TABLE public.crisp_visitor_daily_visits TO authenticated;
GRANT ALL ON TABLE public.crisp_visitors TO service_role;
GRANT ALL ON TABLE public.crisp_visitor_daily_visits TO service_role;

DROP POLICY IF EXISTS "Crisp visitors select for cs roles" ON public.crisp_visitors;
CREATE POLICY "Crisp visitors select for cs roles"
ON public.crisp_visitors
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'cs_admin', 'cs')
    )
);

DROP POLICY IF EXISTS "Crisp daily visitors select for cs roles" ON public.crisp_visitor_daily_visits;
CREATE POLICY "Crisp daily visitors select for cs roles"
ON public.crisp_visitor_daily_visits
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'cs_admin', 'cs')
    )
);

-- Preserve useful history already collected by the existing webhook integration.
INSERT INTO public.crisp_visitors (
    crisp_website_id,
    crisp_session_id,
    nickname,
    email,
    avatar,
    initiated,
    first_seen_at,
    last_seen_at,
    created_at,
    updated_at
)
SELECT
    c.crisp_website_id,
    c.crisp_session_id,
    c.customer_name,
    c.customer_email,
    c.customer_avatar,
    c.last_message IS NOT NULL,
    COALESCE(c.created_at, NOW()),
    COALESCE(c.updated_at, c.created_at, NOW()),
    COALESCE(c.created_at, NOW()),
    NOW()
FROM public.crisp_conversations c
ON CONFLICT (crisp_website_id, crisp_session_id) DO UPDATE SET
    nickname = COALESCE(EXCLUDED.nickname, public.crisp_visitors.nickname),
    email = COALESCE(EXCLUDED.email, public.crisp_visitors.email),
    avatar = COALESCE(EXCLUDED.avatar, public.crisp_visitors.avatar),
    initiated = public.crisp_visitors.initiated OR EXCLUDED.initiated,
    last_seen_at = GREATEST(public.crisp_visitors.last_seen_at, EXCLUDED.last_seen_at),
    updated_at = NOW();

INSERT INTO public.crisp_visitor_daily_visits (
    crisp_website_id,
    crisp_session_id,
    visit_date,
    first_seen_at,
    last_seen_at
)
SELECT
    c.crisp_website_id,
    c.crisp_session_id,
    (COALESCE(c.created_at, NOW()) AT TIME ZONE 'Asia/Karachi')::DATE,
    COALESCE(c.created_at, NOW()),
    COALESCE(c.updated_at, c.created_at, NOW())
FROM public.crisp_conversations c
ON CONFLICT (crisp_website_id, crisp_session_id, visit_date) DO UPDATE SET
    first_seen_at = LEAST(public.crisp_visitor_daily_visits.first_seen_at, EXCLUDED.first_seen_at),
    last_seen_at = GREATEST(public.crisp_visitor_daily_visits.last_seen_at, EXCLUDED.last_seen_at),
    updated_at = NOW();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = 'crisp_visitors'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.crisp_visitors;
        END IF;
    END IF;
END $$;
