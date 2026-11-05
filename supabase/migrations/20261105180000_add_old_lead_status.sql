-- "Old Leads": a lead that sat in "New to contact" for months without being
-- worked. A distinct enum identifier (existing identifiers are never renamed),
-- added on its own because a new enum value cannot be used in the transaction
-- that adds it. The leads are moved in the next migration.
ALTER TYPE public.cs_status ADD VALUE IF NOT EXISTS 'old_lead' AFTER 'new';
