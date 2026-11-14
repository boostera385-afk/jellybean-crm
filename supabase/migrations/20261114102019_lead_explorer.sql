-- Additive Explorer API only. Existing RLS, grants, enums and role behavior are unchanged.
-- All data queries execute as the signed-in caller. Never use a definer count/cache.
CREATE FUNCTION public.lead_explorer_query(
  p_action text,
  p_group text DEFAULT 'area',
  p_path jsonb DEFAULT '[]'::jsonb,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_catalog jsonb DEFAULT '{}'::jsonb,
  p_cursor jsonb DEFAULT NULL,
  p_lead_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  caller_role text;
  depth integer;
  condition text := ' WHERE true';
  node_expression text;
  category_expression text := $sql$CASE WHEN q.service IS NULL OR btrim(q.service) = '' THEN 'missing'
    WHEN $4 ? lower(regexp_replace(btrim(q.service), '\s+', ' ', 'g'))
      THEN 'v:' || ($4 ->> lower(regexp_replace(btrim(q.service), '\s+', ' ', 'g')))
    ELSE 'unmapped' END$sql$;
  fields text := 'q.id,q.customer_name,q.customer_number,q.service,q.state_code,q.main_area,q.sub_area,q.cs_status,q.created_at,q.followup_at,q.is_important';
  column_name text;
  fallback text[];
  pattern text;
  phone_pattern text;
  result jsonb;
  i integer;
BEGIN
  -- Match primaryRole precedence without changing any existing auth helper/policy.
  SELECT role::text INTO caller_role FROM public.user_roles
  WHERE user_id = (SELECT auth.uid())
  ORDER BY array_position(ARRAY['admin','sub_admin','cs_admin','fb_admin','scraping','maturing','cs','acc_handler','facebook','seo'],role::text)
  LIMIT 1;
  IF caller_role IS NULL OR caller_role NOT IN ('admin','cs_admin','cs') THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('nodes','summary','results','detail') OR p_action IS NULL
    OR p_group NOT IN ('area','service') OR p_group IS NULL
    OR jsonb_typeof(p_path) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_filters) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_catalog) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid explorer request' USING ERRCODE = '22023';
  END IF;
  depth := jsonb_array_length(p_path);
  IF depth > (CASE WHEN p_group = 'area' THEN 3 ELSE 2 END)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_path) v WHERE jsonb_typeof(v) <> 'string'
      OR NOT (v #>> '{}' IN ('missing','unmapped') OR left(v #>> '{}',2) = 'v:'))
    OR length(coalesce(p_filters->>'query','')) > 160 THEN
    RAISE EXCEPTION 'Invalid explorer branch or search' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'detail' THEN
    IF p_lead_id IS NULL THEN RAISE EXCEPTION 'Lead ID required'; END IF;
    EXECUTE 'SELECT to_jsonb(r) FROM (SELECT ' || fields ||
      ',q.customer_number_2,q.context,q.post_text,q.cs_notes FROM public.qualified_leads q WHERE q.id = $1) r'
      INTO result USING p_lead_id;
    RETURN result;
  END IF;
  -- Only fixed SQL fragments are composed. All user input remains bound parameters.
  IF depth > 0 THEN
    FOR i IN 0..depth-1 LOOP
      IF p_group = 'area' THEN
        column_name := (ARRAY['state_code','main_area','sub_area'])[i+1];
        condition := condition || CASE WHEN p_path->>i = 'missing'
          THEN format(' AND (q.%I IS NULL OR btrim(q.%I) = '''')',column_name,column_name)
          ELSE format(' AND q.%I = substring($2->>%s FROM 3)',column_name,i) END;
      ELSIF i = 0 THEN
        condition := condition || ' AND (' || category_expression || ') = $2->>0';
      ELSE
        condition := condition || CASE WHEN p_path->>i = 'missing'
          THEN ' AND (q.service IS NULL OR btrim(q.service) = '''')'
          ELSE ' AND q.service = substring($2->>1 FROM 3)' END;
      END IF;
    END LOOP;
  END IF;
  IF nullif(p_filters->>'date_from','') IS NOT NULL THEN
    condition := condition || ' AND q.created_at >= ($3->>''date_from'')::timestamptz';
  END IF;
  IF nullif(p_filters->>'date_to','') IS NOT NULL THEN
    condition := condition || ' AND q.created_at < ($3->>''date_to'')::timestamptz';
  END IF;
  IF nullif(p_filters->>'status','') IS NOT NULL THEN
    condition := condition || ' AND q.cs_status = ($3->>''status'')::public.cs_status';
  END IF;
  IF p_filters->>'owner' = 'mine' THEN
    condition := condition || ' AND q.assigned_to = (SELECT auth.uid())';
  ELSIF p_filters->>'owner' = 'unassigned' THEN
    condition := condition || ' AND q.assigned_to IS NULL';
  ELSIF coalesce(p_filters->>'owner','all') <> 'all' THEN
    RAISE EXCEPTION 'Invalid owner filter';
  END IF;
  IF coalesce((p_filters->>'important')::boolean,false) THEN
    condition := condition || ' AND q.is_important IS TRUE';
  END IF;
  IF coalesce((p_filters->>'due')::boolean,false) THEN
    condition := condition || ' AND q.followup_at <= now()';
  END IF;
  IF nullif(btrim(p_filters->>'query'),'') IS NOT NULL THEN
    pattern := '%' || replace(replace(replace(btrim(p_filters->>'query'), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
    phone_pattern := CASE WHEN btrim(p_filters->>'query') ~ '^[+()[:space:]0-9.-]+$'
      THEN nullif(regexp_replace(p_filters->>'query','\D','','g'),'') ELSE NULL END;
    IF phone_pattern IS NOT NULL THEN phone_pattern := '%' || phone_pattern || '%'; END IF;
    condition := condition || $sql$ AND (
      q.customer_name ILIKE $6 OR q.customer_number ILIKE $6 OR q.customer_number_2 ILIKE $6
      OR q.service ILIKE $6 OR q.main_area ILIKE $6 OR q.sub_area ILIKE $6 OR q.state_code ILIKE $6
      OR ($7 IS NOT NULL AND (regexp_replace(q.customer_number,'\D','','g') LIKE $7
        OR regexp_replace(q.customer_number_2,'\D','','g') LIKE $7
        OR EXISTS (SELECT 1 FROM unnest(q.extra_numbers) phone WHERE regexp_replace(phone,'\D','','g') LIKE $7)))
    )$sql$;
  END IF;
  IF p_action = 'summary' THEN
    EXECUTE 'SELECT jsonb_build_object(''total'',count(*),''new_count'',count(*) FILTER (WHERE q.cs_status = ''new''),''followup_due'',count(*) FILTER (WHERE q.followup_at <= now())) FROM public.qualified_leads q' || condition
      INTO result USING p_group,p_path,p_filters,p_catalog,p_cursor,pattern,phone_pattern;
  ELSIF p_action = 'nodes' THEN
    IF depth >= (CASE WHEN p_group = 'area' THEN 3 ELSE 2 END) THEN RETURN '[]'::jsonb; END IF;
    IF p_group = 'area' THEN
      column_name := (ARRAY['state_code','main_area','sub_area'])[depth+1];
      node_expression := format('CASE WHEN q.%I IS NULL OR btrim(q.%I) = '''' THEN ''missing'' ELSE ''v:'' || q.%I END',column_name,column_name,column_name);
      fallback := ARRAY['missing'];
    ELSIF depth = 0 THEN
      node_expression := category_expression;
      fallback := ARRAY['missing','unmapped'];
    ELSE
      node_expression := 'CASE WHEN q.service IS NULL OR btrim(q.service) = '''' THEN ''missing'' ELSE ''v:'' || q.service END';
      fallback := ARRAY['missing'];
    END IF;
    EXECUTE 'WITH counts AS (SELECT ' || node_expression ||
      ' AS key,count(*) AS total,count(*) FILTER (WHERE q.cs_status = ''new'') AS new_count FROM public.qualified_leads q' || condition ||
      ' GROUP BY 1), nodes AS (SELECT key,total,new_count FROM counts UNION ALL SELECT f.key,0::bigint,0::bigint FROM unnest($8::text[]) f(key) WHERE NOT EXISTS (SELECT 1 FROM counts c WHERE c.key=f.key))
      SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY (n.key IN (''missing'',''unmapped'')), n.total DESC,n.key),''[]''::jsonb) FROM nodes n'
      INTO result USING p_group,p_path,p_filters,p_catalog,p_cursor,pattern,phone_pattern,fallback;
  ELSE
    IF p_cursor IS NOT NULL AND p_cursor <> 'null'::jsonb THEN
      condition := condition || ' AND (q.created_at,q.id) < (($5->>''created_at'')::timestamptz,($5->>''id'')::uuid)';
    END IF;
    EXECUTE 'WITH page AS MATERIALIZED (SELECT ' || fields || ' FROM public.qualified_leads q' || condition ||
      ' ORDER BY q.created_at DESC,q.id DESC LIMIT 51), visible AS (SELECT * FROM page ORDER BY created_at DESC,id DESC LIMIT 50)
      SELECT jsonb_build_object(''rows'',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY created_at DESC,id DESC) FROM visible v),''[]''::jsonb),
        ''next_cursor'',CASE WHEN (SELECT count(*) FROM page)>50 THEN (SELECT jsonb_build_object(''created_at'',created_at,''id'',id) FROM visible ORDER BY created_at,id LIMIT 1) ELSE NULL END)'
      INTO result USING p_group,p_path,p_filters,p_catalog,p_cursor,pattern,phone_pattern;
  END IF;
  RETURN result;
END
$function$;

REVOKE ALL ON FUNCTION public.lead_explorer_query(text,text,jsonb,jsonb,jsonb,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_explorer_query(text,text,jsonb,jsonb,jsonb,jsonb,uuid) TO authenticated;
