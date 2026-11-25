import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createMarshmallowLookupHandler } from "../_shared/marshmallow-lookup.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const db = url && key
  ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

Deno.serve(createMarshmallowLookupHandler({
  env: (name) => Deno.env.get(name),
  lookup: async (requests) => {
    if (!db) return { data: null, error: new Error("Backend configuration unavailable") };
    const { data, error } = await db.rpc("marshmallow_department_lookup", { p_requests: requests });
    return { data, error };
  },
}));
