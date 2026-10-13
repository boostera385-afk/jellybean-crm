import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Timing-safe string comparison
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ─── MESSAGE EVENT CLASSIFICATION ─────────────────────────────────────────────
// ONLY these two event types create messages or touch unread state:
//   message:send     → customer/visitor sent a message
//   message:received → operator sent a message
//
// All other message:* events (message:notify:unread:send,
// message:acknowledge:*, etc.) are control/notification events
// and must NOT create crisp_messages rows or increment unread_count.
const GENUINE_MESSAGE_EVENTS = new Set(["message:send", "message:received"]);

function isGenuineMessageEvent(eventType: string): boolean {
  return GENUINE_MESSAGE_EVENTS.has(eventType);
}

/** Check if a message is a masked/redacted Crisp free-plan placeholder (e.g. 'xxxxx', 'xx xxxx xxxx') */
function isCrispMaskedMessage(content: string | null | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  const stripped = trimmed.replace(/[\s\p{P}\p{S}]/gu, "");
  return stripped.length >= 3 && /^x+$/i.test(stripped);
}

function pakistanDayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
// ──────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ error: "Server configuration missing" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rawBody = await req.text();
    const url = new URL(req.url);
    const providedKey = url.searchParams.get("key");

    if (!providedKey) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Missing webhook secret key (?key=)" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    let body: Record<string, unknown>;

    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const eventType = String(body.event || "unknown").toLowerCase();
    const data = body.data || body;
    const websiteId = body.website_id || data.website_id;

    if (!websiteId) {
      return new Response(JSON.stringify({ message: "No website_id in payload, event ignored" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. LOOKUP WORKSPACE — must be active and enabled
    const { data: wsRecord, error: wsErr } = await supabase
      .from("crisp_workspaces")
      .select(
        "id, enabled, credential_secret_id, auto_greet_enabled, auto_greet_message, auto_greet_delay_seconds",
      )
      .eq("crisp_website_id", websiteId)
      .maybeSingle();

    if (wsErr || !wsRecord?.enabled || !wsRecord.credential_secret_id) {
      return new Response(
        JSON.stringify({
          error: "Unauthorized: workspace is missing, disabled, or not configured.",
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: secretData, error: secretErr } = await supabase.rpc(
      "crisp_get_workspace_secret",
      {
        p_secret_id: wsRecord.credential_secret_id,
      },
    );

    const storedWebhookSecret =
      (secretData as Record<string, unknown>)?.webhook_secret ||
      (secretData as Record<string, unknown>)?.webhookSecret;

    if (
      secretErr ||
      !storedWebhookSecret ||
      !timingSafeEqual(providedKey, storedWebhookSecret as string)
    ) {
      return new Response(JSON.stringify({ error: "Unauthorized: webhook key mismatch." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update last_seen_at (best effort, do not fail on error)
    await supabase
      .from("crisp_workspaces")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", wsRecord.id);

    // Crisp documents this as `website:update_visitors_count`. The loose match
    // also accepts alternate/legacy names such as `website:visitors:count`.
    if (eventType.includes("visitors") && eventType.includes("count")) {
      try {
        await fetch(`${supabaseUrl}/functions/v1/crisp-auto-greet`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${supabaseServiceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ websiteId, immediate: true }),
        });
      } catch (err) {
        console.error("Failed to trigger auto-greet sweep:", err);
      }
      return new Response(JSON.stringify({ status: "success", event: "visitors-count" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sessionId = data.session_id || body.session_id;

    if (!sessionId) {
      return new Response(
        JSON.stringify({ status: "success", message: "Event processed (no session_id)" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ─── MESSAGE ACKNOWLEDGEMENTS (delivery / seen receipts) ─────────────────
    // Crisp emits message:acknowledge:delivered and message:acknowledge:read:*
    // events carrying the fingerprints of operator messages that were delivered
    // to / read by the visitor. Upgrade each matching outgoing message's
    // delivery_state so the inbox can show Sent -> Delivered -> Seen ticks.
    // State only ever moves forward, never backward.
    if (eventType.startsWith("message:acknowledge")) {
      const rawFingerprints = Array.isArray(data.fingerprints)
        ? data.fingerprints
        : data.fingerprint != null
          ? [data.fingerprint]
          : [];
      const fingerprintIds = rawFingerprints
        .map((f: unknown) => String(f))
        .filter((f: string) => f.length > 0);

      // read receipts => "seen"; everything else (delivered) => "delivered".
      const isSeen = eventType.includes(":read");
      const nextState = isSeen ? "seen" : "delivered";
      const upgradableFrom = isSeen ? ["sent", "delivered"] : ["sent"];

      if (fingerprintIds.length > 0) {
        const { error: ackErr } = await supabase
          .from("crisp_messages")
          .update({ delivery_state: nextState })
          .eq("crisp_website_id", websiteId)
          .eq("crisp_session_id", sessionId)
          .eq("direction", "outgoing")
          .in("crisp_message_id", fingerprintIds)
          .in("delivery_state", upgradableFrom);
        // 42703 = column does not exist (migration not yet applied) — ignore.
        if (ackErr && ackErr.code !== "42703") {
          console.error("Failed to update message delivery state:", ackErr.message);
        }
      }

      return new Response(
        JSON.stringify({ status: "success", acknowledge: nextState, count: fingerprintIds.length }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── EVENT CLASSIFICATION ───────────────────────────────────────────────
    const isMessageEvent = isGenuineMessageEvent(eventType);
    const rawFrom = String(data.from || "user").toLowerCase();
    const isOperator = rawFrom === "operator";
    // Customer messages are: genuine message:send events from non-operator sender
    const isCustomerMessage = eventType === "message:send" && !isOperator;

    // Fingerprint uniquely identifies this delivery event (safeguarded against collision)
    const uniqueQualifier = isMessageEvent
      ? `msg_${data.fingerprint || data.timestamp || Date.now()}`
      : `session_${eventType}_${data.timestamp || Date.now()}`;
    const eventFingerprint = `${websiteId}_${eventType}_${sessionId}_${uniqueQualifier}`;

    // 2. LOG WEBHOOK EVENT with processed: false initially
    const { data: eventRow, error: webhookLogErr } = await supabase
      .from("crisp_webhook_events")
      .insert({
        crisp_website_id: websiteId,
        event_fingerprint: eventFingerprint,
        event_type: eventType,
        payload: body,
        processed: false,
      })
      .select("id, processed")
      .maybeSingle();

    let webhookEventId: string | null = null;

    if (webhookLogErr && webhookLogErr.code === "23505") {
      // Duplicate fingerprint — check existing record state
      const { data: existingEvt, error: existingErr } = await supabase
        .from("crisp_webhook_events")
        .select("id, processed")
        .eq("event_fingerprint", eventFingerprint)
        .maybeSingle();

      if (existingErr) {
        console.error("Failed to look up duplicate webhook event:", existingErr.message);
        return new Response(JSON.stringify({ error: "Failed to look up duplicate event" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (existingEvt?.processed === true) {
        // Already fully processed — safe to acknowledge and return
        return new Response(
          JSON.stringify({
            status: "ignored",
            message: "Duplicate webhook event already processed",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // processed = false → retry allowed — reuse the existing event row ID
      // This is critical: we MUST reuse the existing ID so we update the
      // correct row, and we must never increment unread_count twice.
      webhookEventId = existingEvt?.id ?? null;
    } else if (!webhookLogErr && eventRow) {
      webhookEventId = eventRow.id;
    }

    // Handle content for any message type
    let messageContent = "";
    if (isMessageEvent) {
      const rawContent = data.content;
      if (typeof rawContent === "string" && rawContent.trim()) {
        messageContent = rawContent.trim();
      } else if (rawContent && typeof rawContent === "object") {
        if (typeof rawContent.text === "string" && rawContent.text.trim()) {
          messageContent = rawContent.text.trim();
        } else if (typeof rawContent.name === "string" && rawContent.name.trim()) {
          messageContent = rawContent.name.trim();
        }
      }
      if (!messageContent) {
        if (data.type === "file" || data.type === "attachment") {
          messageContent = "[File]";
        } else if (
          data.type === "animation" ||
          data.type === "picker" ||
          data.type === "image" ||
          data.type === "media"
        ) {
          messageContent = "[Image]";
        } else if (data.type === "audio") {
          messageContent = "[Audio]";
        } else {
          messageContent = "[Attachment]";
        }
      }
    }

    try {
      // 3. Upsert conversation (customer details + unread state)
      const { data: existingConv } = await supabase
        .from("crisp_conversations")
        .select(
          "id, customer_name, customer_email, customer_phone, customer_avatar, last_message, last_message_at, last_customer_unread_at, status, unread_count",
        )
        .eq("crisp_website_id", websiteId)
        .eq("crisp_session_id", sessionId)
        .maybeSingle();

      const customerUser = data.user || body.user || {};
      const incomingName =
        customerUser.nickname || customerUser.name || data.nickname || body.nickname || null;
      const incomingEmail = customerUser.email || data.email || body.email || null;
      const incomingPhone = customerUser.phone || data.phone || body.phone || null;
      const incomingAvatar = customerUser.avatar || data.avatar || body.avatar || null;
      const incomingState = data.state || body.state || null;

      const finalName = incomingName || existingConv?.customer_name || null;
      const finalEmail = incomingEmail || existingConv?.customer_email || null;
      const finalPhone = incomingPhone || existingConv?.customer_phone || null;
      const finalAvatar = incomingAvatar || existingConv?.customer_avatar || null;
      const finalState = incomingState || existingConv?.status || "unresolved";

      const eventTimestamp = data.timestamp || body.timestamp;
      const eventDate = eventTimestamp ? new Date(eventTimestamp) : new Date();
      const effectiveEventDate = Number.isNaN(eventDate.getTime()) ? new Date() : eventDate;
      const sentAt = effectiveEventDate.toISOString();

      // Keep visitor presence separate from conversations. Crisp can report a
      // visitor before they ever open the chat or send a message.
      const availability = String(data.availability || "").toLowerCase();
      const isVisitorActivity =
        isCustomerMessage ||
        eventType === "session:request:initiated" ||
        eventType.startsWith("session:set_") ||
        eventType.startsWith("session:sync:") ||
        availability === "online";

      const { data: existingVisitor } = await supabase
        .from("crisp_visitors")
        .select(
          "nickname, email, avatar, user_agent, initiated, active, is_online, last_online_at, last_page_title, last_page_url, country, region, city, latitude, longitude, timezone_minutes, capabilities, locales, last_seen_at, auto_greeted_at, auto_greet_due_at",
        )
        .eq("crisp_website_id", websiteId)
        .eq("crisp_session_id", sessionId)
        .maybeSingle();

      const lastPage =
        data.last_page ||
        data.page ||
        (Array.isArray(data.pages) && data.pages.length > 0
          ? data.pages[data.pages.length - 1]
          : {}) ||
        {};
      const geolocation = data.geolocation || {};
      const coordinates = geolocation.coordinates || {};
      const visitorOnline = availability
        ? availability === "online"
        : isVisitorActivity
          ? true
          : Boolean(existingVisitor?.is_online);
      const visitorActive =
        typeof data.active === "boolean"
          ? data.active
          : availability
            ? availability === "online"
            : Boolean(existingVisitor?.active);

      const { error: visitorUpsertError } = await supabase.from("crisp_visitors").upsert(
        {
          crisp_website_id: websiteId,
          crisp_session_id: sessionId,
          nickname: incomingName || existingVisitor?.nickname || null,
          email: incomingEmail || existingVisitor?.email || null,
          avatar: incomingAvatar || existingVisitor?.avatar || null,
          user_agent: data.useragent || existingVisitor?.user_agent || null,
          initiated: Boolean(data.initiated || existingVisitor?.initiated || isMessageEvent),
          active: visitorActive,
          is_online: visitorOnline,
          last_online_at: visitorOnline ? sentAt : existingVisitor?.last_online_at || null,
          last_page_title:
            lastPage.page_title || lastPage.title || existingVisitor?.last_page_title || null,
          last_page_url:
            lastPage.page_url || lastPage.url || existingVisitor?.last_page_url || null,
          country: geolocation.country || existingVisitor?.country || null,
          region: geolocation.region || existingVisitor?.region || null,
          city: geolocation.city || existingVisitor?.city || null,
          latitude: coordinates.latitude ?? existingVisitor?.latitude ?? null,
          longitude: coordinates.longitude ?? existingVisitor?.longitude ?? null,
          timezone_minutes: data.timezone ?? existingVisitor?.timezone_minutes ?? null,
          capabilities: Array.isArray(data.capabilities)
            ? data.capabilities
            : existingVisitor?.capabilities || [],
          locales: Array.isArray(data.locales) ? data.locales : existingVisitor?.locales || [],
          last_seen_at: isVisitorActivity ? sentAt : existingVisitor?.last_seen_at || sentAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "crisp_website_id,crisp_session_id" },
      );

      if (visitorUpsertError && visitorUpsertError.code !== "42P01") {
        console.error("Failed to update Crisp visitor:", visitorUpsertError.message);
      }

      if (isVisitorActivity) {
        const { error: visitError } = await supabase.from("crisp_visitor_daily_visits").upsert(
          {
            crisp_website_id: websiteId,
            crisp_session_id: sessionId,
            visit_date: pakistanDayKey(effectiveEventDate),
            last_seen_at: sentAt,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "crisp_website_id,crisp_session_id,visit_date" },
        );
        if (visitError && visitError.code !== "42P01") {
          console.error("Failed to update Crisp daily visitor:", visitError.message);
        }
      }

      // ── IDEMPOTENT UNREAD COUNT ────────────────────────────────────────────
      // Check if a crisp_messages row for this message already exists BEFORE
      // computing the new unread count. If the message already exists (retry),
      // do NOT increment unread_count again.
      const crispMsgId = isMessageEvent
        ? String(data.fingerprint || `${sessionId}_${sentAt}`)
        : null;

      let messageAlreadyExists = false;
      if (isMessageEvent && crispMsgId) {
        const { data: existingMsg } = await supabase
          .from("crisp_messages")
          .select("id")
          .eq("crisp_message_id", crispMsgId)
          .maybeSingle();
        messageAlreadyExists = !!existingMsg;
      }

      const currentUnread = Number(existingConv?.unread_count || 0);
      let updatedUnread = currentUnread;
      const isMaskedMsg = isCrispMaskedMessage(messageContent);

      if (isCustomerMessage && !messageAlreadyExists && !isMaskedMsg) {
        updatedUnread = currentUnread + 1;
      } else if (isOperator || isMaskedMsg) {
        // Operator reply or masked message clears/prevents awaiting-reply state
        updatedUnread = 0;
      }

      const lastMessage =
        isMessageEvent && messageContent ? messageContent : existingConv?.last_message || null;
      const lastMessageAt =
        isMessageEvent && messageContent ? sentAt : existingConv?.last_message_at || sentAt;

      // Set last_customer_unread_at ONLY on genuine NEW incoming customer messages
      // Operator messages or masked messages clear it
      const lastCustomerUnreadAt =
        isCustomerMessage && !messageAlreadyExists && !isMaskedMsg
          ? sentAt
          : updatedUnread > 0
            ? existingConv?.last_customer_unread_at || null
            : null;

      const { data: convData, error: convErr } = await supabase
        .from("crisp_conversations")
        .upsert(
          {
            crisp_website_id: websiteId,
            crisp_session_id: sessionId,
            customer_name: finalName,
            customer_email: finalEmail,
            customer_phone: finalPhone,
            customer_avatar: finalAvatar,
            status: finalState,
            last_message: lastMessage,
            last_message_at: lastMessageAt,
            last_customer_unread_at: lastCustomerUnreadAt,
            unread_count: updatedUnread,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "crisp_website_id,crisp_session_id" },
        )
        .select("id")
        .single();

      if (convErr) {
        throw new Error(`Error upserting crisp_conversations: ${convErr.message}`);
      }

      const conversationId = convData.id;

      // 4. Insert message into crisp_messages (idempotent via ON CONFLICT DO NOTHING)
      if (isMessageEvent && messageContent && crispMsgId && !messageAlreadyExists) {
        const senderType = isOperator ? "operator" : "customer";
        const direction = isOperator ? "outgoing" : "incoming";

        const { error: msgErr } = await supabase.from("crisp_messages").insert({
          conversation_id: conversationId,
          crisp_website_id: websiteId,
          crisp_session_id: sessionId,
          crisp_message_id: crispMsgId,
          sender_type: senderType,
          direction: direction,
          content: messageContent,
          message_type: data.type || "text",
          sent_at: sentAt,
          raw_payload: data,
        });

        // 23505 = unique_violation (message already inserted by a concurrent request) — safe to ignore
        if (msgErr && msgErr.code !== "23505") {
          throw new Error(`Error inserting crisp_messages: ${msgErr.message}`);
        }
      }

      // 5. Mark webhook event as processed: true
      if (webhookEventId) {
        const { error: markDoneErr } = await supabase
          .from("crisp_webhook_events")
          .update({ processed: true, error: null })
          .eq("id", webhookEventId);

        if (markDoneErr) {
          console.error("Failed to mark webhook event processed:", markDoneErr.message);
        }
      }

      return new Response(
        JSON.stringify({ status: "success", session_id: sessionId, website_id: websiteId }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (processErr: unknown) {
      console.error("Webhook processing error:", processErr);
      const processErrorMsg =
        processErr instanceof Error ? processErr.message : "Webhook processing failed";

      // Leave processed: false and record error in the correct `error` column
      if (webhookEventId) {
        const { error: errUpdateErr } = await supabase
          .from("crisp_webhook_events")
          .update({ processed: false, error: processErrorMsg })
          .eq("id", webhookEventId);

        if (errUpdateErr) {
          console.error("Failed to record webhook error:", errUpdateErr.message);
        }
      }

      return new Response(JSON.stringify({ error: processErrorMsg }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch (err: unknown) {
    console.error("Crisp webhook error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
