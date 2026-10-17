-- Version matches the recorded Supabase MCP migration.
-- Short visitor-side previews, for first visits and eligible genuine returns.
-- Do not change feature switches, cooldowns, visit markers or paused workspaces.
ALTER TABLE public.crisp_workspaces
  ALTER COLUMN auto_greet_message SET DEFAULT 'Hi! How can we help you today?',
  ALTER COLUMN auto_greet_revisit_message SET DEFAULT 'Welcome back! How can we help?';

UPDATE public.crisp_workspaces SET auto_greet_message=CASE
  WHEN workspace_name IN ('Govee Installation','Govee Installer','Govee Lights','Light It Up Av and Turf')
    THEN 'Hi! Need help installing Govee lights?'
  WHEN workspace_name IN ('Christmas Lights Specialist','Sisu Christmas Lights')
    THEN 'Hi! Need help with Christmas lights?'
  WHEN workspace_name IN ('Fast Fix Sliding door Repair','Olympus Sliding Doors','Sliding Door Squad')
    THEN 'Hi! Need help with a sliding door?'
  WHEN workspace_name='Arrow Head Sprinkler' THEN 'Hi! Need help with your sprinklers?'
  WHEN workspace_name IN ('Drywall Repair Services LLC','Fast Patch Drywall Repair LLC','Wall Tech Drywall Repair')
    THEN 'Hi! Need help with drywall repair?'
  ELSE 'Hi! How can we help you today?' END,
  auto_greet_revisit_message='Welcome back! How can we help?',updated_at=now();

ALTER TABLE public.crisp_workspaces
  ADD CONSTRAINT crisp_first_greeting_compact CHECK (char_length(auto_greet_message)<=120
    AND auto_greet_message !~* '\{\{\s*name\s*\}\}'),
  ADD CONSTRAINT crisp_revisit_greeting_compact CHECK (char_length(auto_greet_revisit_message)<=120
    AND auto_greet_revisit_message !~* '\{\{\s*name\s*\}\}');

-- Only jobs not yet claimed can safely adopt the new copy. Historical messages
-- and started/uncertain requests are deliberately left untouched.
UPDATE public.crisp_greeting_jobs j SET content=CASE WHEN j.is_revisit THEN w.auto_greet_revisit_message ELSE w.auto_greet_message END
FROM public.crisp_workspaces w WHERE j.crisp_website_id=w.crisp_website_id AND j.state='pending';
