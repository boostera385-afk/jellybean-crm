-- Add a per-lead delivery method ("Texted" or "Called") to qualified leads.
--
-- Delivery method used to be prompted on every CS status change and only kept
-- in activity-log metadata. It is now a first-class property of the lead that
-- defaults to "texted", can be toggled directly from the lead card, and is
-- surfaced in the forwarded-leads view so marketers can see what happened on
-- each lead.
--
-- This is a plain attribute column; it does not touch the cs_status enum, so
-- existing lead-status identifiers are preserved.

ALTER TABLE public.qualified_leads
    ADD COLUMN IF NOT EXISTS contact_method TEXT NOT NULL DEFAULT 'texted';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'qualified_leads_contact_method_check'
          AND conrelid = 'public.qualified_leads'::regclass
    ) THEN
        ALTER TABLE public.qualified_leads
            ADD CONSTRAINT qualified_leads_contact_method_check
            CHECK (contact_method IN ('texted', 'called'));
    END IF;
END $$;
