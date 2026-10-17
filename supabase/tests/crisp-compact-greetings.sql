BEGIN;
DO $$
DECLARE w text:='compact-test-'||gen_random_uuid(); blocked boolean;
BEGIN
  INSERT INTO public.crisp_workspaces(crisp_website_id,workspace_name) VALUES(w,'Compact greeting regression');
  IF NOT EXISTS(SELECT 1 FROM public.crisp_workspaces WHERE crisp_website_id=w
    AND auto_greet_message='Hi! How can we help you today?'
    AND auto_greet_revisit_message='Welcome back! How can we help?') THEN
    RAISE EXCEPTION 'Compact defaults missing'; END IF;
  blocked:=false;
  BEGIN
    UPDATE public.crisp_workspaces SET auto_greet_message=repeat('x',121) WHERE crisp_website_id=w;
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Oversized first greeting accepted'; END IF;
  blocked:=false;
  BEGIN
    UPDATE public.crisp_workspaces SET auto_greet_revisit_message=repeat('x',121) WHERE crisp_website_id=w;
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Oversized revisit greeting accepted'; END IF;
  blocked:=false;
  BEGIN
    UPDATE public.crisp_workspaces SET auto_greet_revisit_message='Hi {{ NAME }}' WHERE crisp_website_id=w;
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Unverified name placeholder accepted'; END IF;
END $$;
ROLLBACK;
