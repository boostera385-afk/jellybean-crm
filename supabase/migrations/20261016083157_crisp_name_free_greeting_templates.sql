-- Crisp gives us a session ID and an auto-generated nickname (e.g.
-- "visitor493603" or an email prefix), never a real name. Greeting a visitor as
-- "Hi Hamzaamjad!" reads like a bug and is not trustworthy. Templates must not
-- depend on {{name}}; {{name}} support stays in the renderer for operators who
-- deliberately opt into it, but every live workspace and both column defaults
-- are now name-free and trade-specific.

ALTER TABLE public.crisp_workspaces
  ALTER COLUMN auto_greet_revisit_message SET DEFAULT
  'Welcome back! 👋 Great to see you again — if you still have any questions or need help with your project, I''m right here and happy to help.';

UPDATE public.crisp_workspaces SET auto_greet_message = CASE workspace_name
  WHEN 'Govee Installation'           THEN 'Hi there! 👋 Thanks for visiting. Where do you need your Govee lights installed? Share your city or a few details and we''ll take it from there.'
  WHEN 'Govee Installer'              THEN 'Hi there! 👋 Thanks for visiting. Where do you need your Govee lights installed? Share your city or a few details and we''ll take it from there.'
  WHEN 'Govee Lights'                 THEN 'Hi there! 👋 Thanks for visiting. Where do you need your Govee lights installed? Share your city or a few details and we''ll take it from there.'
  WHEN 'Light It Up Av and Turf'      THEN 'Hi there! 👋 Thanks for visiting. Where do you need your Govee lights installed? Share your city or a few details and we''ll take it from there.'
  WHEN 'Christmas Lights Specialist'  THEN 'Hi there! 👋 Thanks for stopping by. Where do you need your Christmas lights installed? Tell us a little about the job and we''ll get you a quick quote.'
  WHEN 'Sisu Christmas Lights'        THEN 'Hi there! 👋 Thanks for stopping by. Where do you need your Christmas lights installed? Tell us a little about the job and we''ll get you a quick quote.'
  WHEN 'Fast Fix Sliding door Repair' THEN 'Hi there! 👋 Having trouble with a sliding door? Tell us the issue and your area, and we''ll get it sorted quickly.'
  WHEN 'Olympus Sliding Doors'        THEN 'Hi there! 👋 Having trouble with a sliding door? Tell us the issue and your area, and we''ll get it sorted quickly.'
  WHEN 'Sliding Door Squad'           THEN 'Hi there! 👋 Having trouble with a sliding door? Tell us the issue and your area, and we''ll get it sorted quickly.'
  WHEN 'Arrow Head Sprinkler'         THEN 'Hi there! 👋 Need help with your sprinkler system? Tell us what''s going on and we''ll get it fixed fast.'
  WHEN 'Drywall Repair Services LLC'  THEN 'Hi there! 👋 Need drywall repair? Tell us a bit about the job and we''ll get you a fast, free quote.'
  WHEN 'Fast Patch Drywall Repair LLC' THEN 'Hi there! 👋 Need drywall repair? Tell us a bit about the job and we''ll get you a fast, free quote.'
  WHEN 'Wall Tech Drywall Repair'     THEN 'Hi there! 👋 Need drywall repair? Tell us a bit about the job and we''ll get you a fast, free quote.'
END
WHERE workspace_name IN (
  'Govee Installation','Govee Installer','Govee Lights','Light It Up Av and Turf',
  'Christmas Lights Specialist','Sisu Christmas Lights','Fast Fix Sliding door Repair',
  'Olympus Sliding Doors','Sliding Door Squad','Arrow Head Sprinkler',
  'Drywall Repair Services LLC','Fast Patch Drywall Repair LLC','Wall Tech Drywall Repair'
)
AND auto_greet_message IS DISTINCT FROM CASE workspace_name
  WHEN 'Govee Installation'           THEN 'Hi there! 👋 Thanks for visiting. Where do you need your Govee lights installed? Share your city or a few details and we''ll take it from there.'
  WHEN 'Govee Installer'              THEN 'Hi there! 👋 Thanks for visiting. Where do you need your Govee lights installed? Share your city or a few details and we''ll take it from there.'
  WHEN 'Govee Lights'                 THEN 'Hi there! 👋 Thanks for visiting. Where do you need your Govee lights installed? Share your city or a few details and we''ll take it from there.'
  WHEN 'Light It Up Av and Turf'      THEN 'Hi there! 👋 Thanks for visiting. Where do you need your Govee lights installed? Share your city or a few details and we''ll take it from there.'
  WHEN 'Christmas Lights Specialist'  THEN 'Hi there! 👋 Thanks for stopping by. Where do you need your Christmas lights installed? Tell us a little about the job and we''ll get you a quick quote.'
  WHEN 'Sisu Christmas Lights'        THEN 'Hi there! 👋 Thanks for stopping by. Where do you need your Christmas lights installed? Tell us a little about the job and we''ll get you a quick quote.'
  WHEN 'Fast Fix Sliding door Repair' THEN 'Hi there! 👋 Having trouble with a sliding door? Tell us the issue and your area, and we''ll get it sorted quickly.'
  WHEN 'Olympus Sliding Doors'        THEN 'Hi there! 👋 Having trouble with a sliding door? Tell us the issue and your area, and we''ll get it sorted quickly.'
  WHEN 'Sliding Door Squad'           THEN 'Hi there! 👋 Having trouble with a sliding door? Tell us the issue and your area, and we''ll get it sorted quickly.'
  WHEN 'Arrow Head Sprinkler'         THEN 'Hi there! 👋 Need help with your sprinkler system? Tell us what''s going on and we''ll get it fixed fast.'
  WHEN 'Drywall Repair Services LLC'  THEN 'Hi there! 👋 Need drywall repair? Tell us a bit about the job and we''ll get you a fast, free quote.'
  WHEN 'Fast Patch Drywall Repair LLC' THEN 'Hi there! 👋 Need drywall repair? Tell us a bit about the job and we''ll get you a fast, free quote.'
  WHEN 'Wall Tech Drywall Repair'     THEN 'Hi there! 👋 Need drywall repair? Tell us a bit about the job and we''ll get you a fast, free quote.'
END;

-- Revisit default text for workspaces that still carry the shipped {{name}} copy.
UPDATE public.crisp_workspaces
SET auto_greet_revisit_message = 'Welcome back! 👋 Great to see you again — if you still have any questions or need help with your project, I''m right here and happy to help.'
WHERE auto_greet_revisit_message LIKE '%{{%name}}%';
