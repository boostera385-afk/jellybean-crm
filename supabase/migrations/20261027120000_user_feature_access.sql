-- =========================================================
-- Per-user feature access
-- ---------------------------------------------------------
-- Lets an admin grant optional, role-independent features to
-- individual users (e.g. the Analytics page) from
-- Settings -> Feature Access. A row exists only while a feature
-- is granted; revoking a feature deletes the row.
-- =========================================================

CREATE TABLE IF NOT EXISTS public.user_feature_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, feature)
);

ALTER TABLE public.user_feature_access ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS user_feature_access_user_id_idx
  ON public.user_feature_access(user_id);

-- A user can read their own grants so the app can decide whether to show
-- the granted feature's navigation entry and route for that user.
CREATE POLICY "user_feature_access: user reads own"
  ON public.user_feature_access FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Admins can read every grant (to render the Feature Access matrix).
CREATE POLICY "user_feature_access: admin reads all"
  ON public.user_feature_access FOR SELECT TO authenticated
  USING (public.current_user_has_role_text('admin'));

-- Only admins can grant or revoke feature access.
CREATE POLICY "user_feature_access: admin manages"
  ON public.user_feature_access FOR ALL TO authenticated
  USING (public.current_user_has_role_text('admin'))
  WITH CHECK (public.current_user_has_role_text('admin'));
