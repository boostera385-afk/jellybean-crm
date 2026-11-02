-- The fb_admin role: manages facebook (FB) submitters and sees their work.
--
-- Added in its own migration because a new enum value cannot be used as a
-- literal in the same transaction that adds it; the policies and functions that
-- reference 'fb_admin' live in the next migration, which runs afterwards.
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'fb_admin';
