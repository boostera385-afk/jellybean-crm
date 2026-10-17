export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      accounts: {
        Row: {
          area: string | null
          created_at: string
          created_by: string | null
          id: string
          imported_at: string | null
          incogniton_profile_id: string | null
          last_opened_at: string | null
          latitude: number | null
          longitude: number | null
          name: string
          notes: string | null
          profile_group: string | null
          status: string
          updated_at: string
        }
        Insert: {
          area?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          imported_at?: string | null
          incogniton_profile_id?: string | null
          last_opened_at?: string | null
          latitude?: number | null
          longitude?: number | null
          name: string
          notes?: string | null
          profile_group?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          area?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          imported_at?: string | null
          incogniton_profile_id?: string | null
          last_opened_at?: string | null
          latitude?: number | null
          longitude?: number | null
          name?: string
          notes?: string | null
          profile_group?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      activity_logs: {
        Row: {
          action: string
          actor_id: string | null
          actor_name: string | null
          actor_role: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          metadata: Json | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_name?: string | null
          actor_role?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_name?: string | null
          actor_role?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json | null
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          admin_otp_required: boolean
          id: boolean
          updated_at: string
        }
        Insert: {
          admin_otp_required?: boolean
          id?: boolean
          updated_at?: string
        }
        Update: {
          admin_otp_required?: boolean
          id?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      crisp_api_usage: {
        Row: {
          bucket_at: string
          crisp_website_id: string
          requests: number
        }
        Insert: {
          bucket_at: string
          crisp_website_id: string
          requests?: number
        }
        Update: {
          bucket_at?: string
          crisp_website_id?: string
          requests?: number
        }
        Relationships: []
      }
      crisp_conversation_notes: {
        Row: {
          conversation_id: string
          created_at: string
          created_by: string
          id: string
          is_edited: boolean
          note: string
          updated_at: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          created_by: string
          id?: string
          is_edited?: boolean
          note: string
          updated_at?: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          created_by?: string
          id?: string
          is_edited?: boolean
          note?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crisp_conversation_notes_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "crisp_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      crisp_conversations: {
        Row: {
          created_at: string | null
          crisp_session_id: string
          crisp_website_id: string
          customer_avatar: string | null
          customer_email: string | null
          customer_name: string | null
          customer_phone: string | null
          id: string
          last_customer_unread_at: string | null
          last_message: string | null
          last_message_at: string | null
          last_read_at: string | null
          metadata: Json | null
          state_observed_at: string | null
          status: string | null
          unread_count: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          crisp_session_id: string
          crisp_website_id: string
          customer_avatar?: string | null
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          id?: string
          last_customer_unread_at?: string | null
          last_message?: string | null
          last_message_at?: string | null
          last_read_at?: string | null
          metadata?: Json | null
          state_observed_at?: string | null
          status?: string | null
          unread_count?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          crisp_session_id?: string
          crisp_website_id?: string
          customer_avatar?: string | null
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          id?: string
          last_customer_unread_at?: string | null
          last_message?: string | null
          last_message_at?: string | null
          last_read_at?: string | null
          metadata?: Json | null
          state_observed_at?: string | null
          status?: string | null
          unread_count?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      crisp_greeting_jobs: {
        Row: {
          attempts: number
          content: string
          created_at: string
          crisp_session_id: string
          crisp_website_id: string
          due_at: string
          expires_at: string
          external_fingerprint: string | null
          id: string
          is_revisit: boolean
          last_error: string | null
          lease_token: string | null
          lease_until: string | null
          request_started_at: string | null
          sent_at: string | null
          state: string
        }
        Insert: {
          attempts?: number
          content: string
          created_at?: string
          crisp_session_id: string
          crisp_website_id: string
          due_at: string
          expires_at?: string
          external_fingerprint?: string | null
          id?: string
          is_revisit?: boolean
          last_error?: string | null
          lease_token?: string | null
          lease_until?: string | null
          request_started_at?: string | null
          sent_at?: string | null
          state?: string
        }
        Update: {
          attempts?: number
          content?: string
          created_at?: string
          crisp_session_id?: string
          crisp_website_id?: string
          due_at?: string
          expires_at?: string
          external_fingerprint?: string | null
          id?: string
          is_revisit?: boolean
          last_error?: string | null
          lease_token?: string | null
          lease_until?: string | null
          request_started_at?: string | null
          sent_at?: string | null
          state?: string
        }
        Relationships: []
      }
      crisp_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string | null
          crisp_message_id: string | null
          crisp_session_id: string
          crisp_website_id: string
          delivery_state: string
          direction: string
          id: string
          message_type: string | null
          raw_payload: Json | null
          sender_type: string
          sent_at: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string | null
          crisp_message_id?: string | null
          crisp_session_id: string
          crisp_website_id: string
          delivery_state?: string
          direction: string
          id?: string
          message_type?: string | null
          raw_payload?: Json | null
          sender_type: string
          sent_at?: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string | null
          crisp_message_id?: string | null
          crisp_session_id?: string
          crisp_website_id?: string
          delivery_state?: string
          direction?: string
          id?: string
          message_type?: string | null
          raw_payload?: Json | null
          sender_type?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crisp_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "crisp_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      crisp_site_arrivals: {
        Row: {
          attempts: number
          crisp_session_id: string
          crisp_website_id: string
          expires_at: string
          next_attempt_at: string
          received_at: string
          request_id: string
          verified_at: string | null
        }
        Insert: {
          attempts?: number
          crisp_session_id: string
          crisp_website_id: string
          expires_at?: string
          next_attempt_at?: string
          received_at?: string
          request_id: string
          verified_at?: string | null
        }
        Update: {
          attempts?: number
          crisp_session_id?: string
          crisp_website_id?: string
          expires_at?: string
          next_attempt_at?: string
          received_at?: string
          request_id?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crisp_site_arrivals_crisp_website_id_fkey"
            columns: ["crisp_website_id"]
            isOneToOne: false
            referencedRelation: "crisp_site_bridges"
            referencedColumns: ["crisp_website_id"]
          },
        ]
      }
      crisp_site_bridges: {
        Row: {
          crisp_website_id: string
          enabled: boolean
          hour_at: string
          hour_count: number
          last_received_at: string | null
          minute_at: string
          minute_count: number
          origin: string
          secret_id: string
        }
        Insert: {
          crisp_website_id: string
          enabled?: boolean
          hour_at?: string
          hour_count?: number
          last_received_at?: string | null
          minute_at?: string
          minute_count?: number
          origin: string
          secret_id: string
        }
        Update: {
          crisp_website_id?: string
          enabled?: boolean
          hour_at?: string
          hour_count?: number
          last_received_at?: string | null
          minute_at?: string
          minute_count?: number
          origin?: string
          secret_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "crisp_site_bridges_crisp_website_id_fkey"
            columns: ["crisp_website_id"]
            isOneToOne: true
            referencedRelation: "crisp_workspaces"
            referencedColumns: ["crisp_website_id"]
          },
        ]
      }
      crisp_visitor_daily_visits: {
        Row: {
          created_at: string
          crisp_session_id: string
          crisp_website_id: string
          first_seen_at: string
          id: string
          last_seen_at: string
          updated_at: string
          visit_date: string
        }
        Insert: {
          created_at?: string
          crisp_session_id: string
          crisp_website_id: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          updated_at?: string
          visit_date: string
        }
        Update: {
          created_at?: string
          crisp_session_id?: string
          crisp_website_id?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          updated_at?: string
          visit_date?: string
        }
        Relationships: []
      }
      crisp_visitors: {
        Row: {
          active: boolean
          auto_greet_due_at: string | null
          auto_greeted_at: string | null
          avatar: string | null
          capabilities: string[]
          city: string | null
          country: string | null
          created_at: string
          crisp_session_id: string
          crisp_website_id: string
          email: string | null
          first_seen_at: string
          id: string
          initiated: boolean
          is_online: boolean
          last_online_at: string | null
          last_page_title: string | null
          last_page_url: string | null
          last_seen_at: string
          latitude: number | null
          locales: string[]
          longitude: number | null
          nickname: string | null
          presence_observed_at: string | null
          region: string | null
          timezone_minutes: number | null
          updated_at: string
          user_agent: string | null
          visit_started_at: string
        }
        Insert: {
          active?: boolean
          auto_greet_due_at?: string | null
          auto_greeted_at?: string | null
          avatar?: string | null
          capabilities?: string[]
          city?: string | null
          country?: string | null
          created_at?: string
          crisp_session_id: string
          crisp_website_id: string
          email?: string | null
          first_seen_at?: string
          id?: string
          initiated?: boolean
          is_online?: boolean
          last_online_at?: string | null
          last_page_title?: string | null
          last_page_url?: string | null
          last_seen_at?: string
          latitude?: number | null
          locales?: string[]
          longitude?: number | null
          nickname?: string | null
          presence_observed_at?: string | null
          region?: string | null
          timezone_minutes?: number | null
          updated_at?: string
          user_agent?: string | null
          visit_started_at?: string
        }
        Update: {
          active?: boolean
          auto_greet_due_at?: string | null
          auto_greeted_at?: string | null
          avatar?: string | null
          capabilities?: string[]
          city?: string | null
          country?: string | null
          created_at?: string
          crisp_session_id?: string
          crisp_website_id?: string
          email?: string | null
          first_seen_at?: string
          id?: string
          initiated?: boolean
          is_online?: boolean
          last_online_at?: string | null
          last_page_title?: string | null
          last_page_url?: string | null
          last_seen_at?: string
          latitude?: number | null
          locales?: string[]
          longitude?: number | null
          nickname?: string | null
          presence_observed_at?: string | null
          region?: string | null
          timezone_minutes?: number | null
          updated_at?: string
          user_agent?: string | null
          visit_started_at?: string
        }
        Relationships: []
      }
      crisp_webhook_events: {
        Row: {
          attempts: number
          created_at: string
          crisp_website_id: string | null
          error: string | null
          event_fingerprint: string
          event_type: string
          id: string
          next_attempt_at: string
          payload: Json
          processed: boolean | null
          processed_at: string | null
          received_at: string | null
        }
        Insert: {
          attempts?: number
          created_at?: string
          crisp_website_id?: string | null
          error?: string | null
          event_fingerprint: string
          event_type: string
          id?: string
          next_attempt_at?: string
          payload: Json
          processed?: boolean | null
          processed_at?: string | null
          received_at?: string | null
        }
        Update: {
          attempts?: number
          created_at?: string
          crisp_website_id?: string | null
          error?: string | null
          event_fingerprint?: string
          event_type?: string
          id?: string
          next_attempt_at?: string
          payload?: Json
          processed?: boolean | null
          processed_at?: string | null
          received_at?: string | null
        }
        Relationships: []
      }
      crisp_workspaces: {
        Row: {
          active_visitor_count: number
          auto_greet_delay_seconds: number
          auto_greet_enabled: boolean
          auto_greet_message: string | null
          auto_greet_revisit_after_seconds: number
          auto_greet_revisit_enabled: boolean
          auto_greet_revisit_message: string | null
          created_at: string
          credential_secret_id: string | null
          crisp_cooldown_until: string | null
          crisp_interactive_reserve: number
          crisp_request_limit: number
          crisp_website_id: string
          enabled: boolean
          greeting_worker_enabled: boolean
          id: string
          installed_at: string | null
          last_full_presence_at: string | null
          last_presence_event_at: string | null
          last_seen_at: string | null
          last_synced_at: string | null
          live_visitor_count: number
          metadata: Json
          pipeline_started_at: string
          presence_failure_count: number
          presence_feed: string
          presence_paused_reason: string | null
          presence_paused_until: string | null
          site_presence_claimed_at: string | null
          site_presence_pending: boolean
          site_presence_requested_at: string | null
          updated_at: string
          visitor_budget_used: number
          visitor_count_checked_at: string | null
          visitor_effective_interval_seconds: number
          visitor_identity_checked_at: string | null
          visitor_last_duration_ms: number | null
          visitor_last_mode: string | null
          visitor_request_cost: number
          visitor_sync_error: string | null
          visitor_sync_interval_seconds: number
          visitor_sync_lease: string | null
          visitor_sync_lease_until: string | null
          visitor_sync_succeeded_at: string | null
          visitor_synced_at: string | null
          visitors_limited: boolean
          workspace_name: string | null
        }
        Insert: {
          active_visitor_count?: number
          auto_greet_delay_seconds?: number
          auto_greet_enabled?: boolean
          auto_greet_message?: string | null
          auto_greet_revisit_after_seconds?: number
          auto_greet_revisit_enabled?: boolean
          auto_greet_revisit_message?: string | null
          created_at?: string
          credential_secret_id?: string | null
          crisp_cooldown_until?: string | null
          crisp_interactive_reserve?: number
          crisp_request_limit?: number
          crisp_website_id: string
          enabled?: boolean
          greeting_worker_enabled?: boolean
          id?: string
          installed_at?: string | null
          last_full_presence_at?: string | null
          last_presence_event_at?: string | null
          last_seen_at?: string | null
          last_synced_at?: string | null
          live_visitor_count?: number
          metadata?: Json
          pipeline_started_at?: string
          presence_failure_count?: number
          presence_feed?: string
          presence_paused_reason?: string | null
          presence_paused_until?: string | null
          site_presence_claimed_at?: string | null
          site_presence_pending?: boolean
          site_presence_requested_at?: string | null
          updated_at?: string
          visitor_budget_used?: number
          visitor_count_checked_at?: string | null
          visitor_effective_interval_seconds?: number
          visitor_identity_checked_at?: string | null
          visitor_last_duration_ms?: number | null
          visitor_last_mode?: string | null
          visitor_request_cost?: number
          visitor_sync_error?: string | null
          visitor_sync_interval_seconds?: number
          visitor_sync_lease?: string | null
          visitor_sync_lease_until?: string | null
          visitor_sync_succeeded_at?: string | null
          visitor_synced_at?: string | null
          visitors_limited?: boolean
          workspace_name?: string | null
        }
        Update: {
          active_visitor_count?: number
          auto_greet_delay_seconds?: number
          auto_greet_enabled?: boolean
          auto_greet_message?: string | null
          auto_greet_revisit_after_seconds?: number
          auto_greet_revisit_enabled?: boolean
          auto_greet_revisit_message?: string | null
          created_at?: string
          credential_secret_id?: string | null
          crisp_cooldown_until?: string | null
          crisp_interactive_reserve?: number
          crisp_request_limit?: number
          crisp_website_id?: string
          enabled?: boolean
          greeting_worker_enabled?: boolean
          id?: string
          installed_at?: string | null
          last_full_presence_at?: string | null
          last_presence_event_at?: string | null
          last_seen_at?: string | null
          last_synced_at?: string | null
          live_visitor_count?: number
          metadata?: Json
          pipeline_started_at?: string
          presence_failure_count?: number
          presence_feed?: string
          presence_paused_reason?: string | null
          presence_paused_until?: string | null
          site_presence_claimed_at?: string | null
          site_presence_pending?: boolean
          site_presence_requested_at?: string | null
          updated_at?: string
          visitor_budget_used?: number
          visitor_count_checked_at?: string | null
          visitor_effective_interval_seconds?: number
          visitor_identity_checked_at?: string | null
          visitor_last_duration_ms?: number | null
          visitor_last_mode?: string | null
          visitor_request_cost?: number
          visitor_sync_error?: string | null
          visitor_sync_interval_seconds?: number
          visitor_sync_lease?: string | null
          visitor_sync_lease_until?: string | null
          visitor_sync_succeeded_at?: string | null
          visitor_synced_at?: string | null
          visitors_limited?: boolean
          workspace_name?: string | null
        }
        Relationships: []
      }
      crm_update_notification_receipts: {
        Row: {
          acknowledged_at: string
          id: string
          notification_id: string
          user_id: string
        }
        Insert: {
          acknowledged_at?: string
          id?: string
          notification_id: string
          user_id: string
        }
        Update: {
          acknowledged_at?: string
          id?: string
          notification_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_update_notification_receipts_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "crm_update_notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_update_notifications: {
        Row: {
          affected_section: string | null
          created_at: string
          created_by: string | null
          description: string
          id: string
          is_active: boolean
          priority: string
          published_at: string
          target_roles: string[]
          title: string
        }
        Insert: {
          affected_section?: string | null
          created_at?: string
          created_by?: string | null
          description: string
          id?: string
          is_active?: boolean
          priority?: string
          published_at?: string
          target_roles?: string[]
          title: string
        }
        Update: {
          affected_section?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          id?: string
          is_active?: boolean
          priority?: string
          published_at?: string
          target_roles?: string[]
          title?: string
        }
        Relationships: []
      }
      incogniton_profiles: {
        Row: {
          account_area: string | null
          created_at: string
          created_by: string | null
          group_name: string | null
          id: string
          incogniton_profile_id: string
          is_active: boolean
          last_launched_at: string | null
          latitude: number | null
          launch_history: Json
          launched_by_email: string | null
          launched_by_name: string | null
          linked_lead_id: string | null
          longitude: number | null
          notes: string | null
          platform: string | null
          profile_name: string
          profile_priority: string
        }
        Insert: {
          account_area?: string | null
          created_at?: string
          created_by?: string | null
          group_name?: string | null
          id?: string
          incogniton_profile_id: string
          is_active?: boolean
          last_launched_at?: string | null
          latitude?: number | null
          launch_history?: Json
          launched_by_email?: string | null
          launched_by_name?: string | null
          linked_lead_id?: string | null
          longitude?: number | null
          notes?: string | null
          platform?: string | null
          profile_name: string
          profile_priority?: string
        }
        Update: {
          account_area?: string | null
          created_at?: string
          created_by?: string | null
          group_name?: string | null
          id?: string
          incogniton_profile_id?: string
          is_active?: boolean
          last_launched_at?: string | null
          latitude?: number | null
          launch_history?: Json
          launched_by_email?: string | null
          launched_by_name?: string | null
          linked_lead_id?: string | null
          longitude?: number | null
          notes?: string | null
          platform?: string | null
          profile_name?: string
          profile_priority?: string
        }
        Relationships: [
          {
            foreignKeyName: "incogniton_profiles_linked_lead_id_fkey"
            columns: ["linked_lead_id"]
            isOneToOne: false
            referencedRelation: "processed_leads_export"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incogniton_profiles_linked_lead_id_fkey"
            columns: ["linked_lead_id"]
            isOneToOne: false
            referencedRelation: "qualified_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_drafts: {
        Row: {
          created_at: string
          created_by: string
          form_data: Json
          id: string
          source_lead_id: string | null
          source_type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          form_data?: Json
          id?: string
          source_lead_id?: string | null
          source_type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          form_data?: Json
          id?: string
          source_lead_id?: string | null
          source_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      lead_reminders: {
        Row: {
          created_at: string
          id: string
          is_read: boolean
          lead_id: string
          message: string
          read_at: string | null
          recipient_user_id: string
          sender_user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_read?: boolean
          lead_id: string
          message: string
          read_at?: string | null
          recipient_user_id: string
          sender_user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_read?: boolean
          lead_id?: string
          message?: string
          read_at?: string | null
          recipient_user_id?: string
          sender_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_reminders_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "processed_leads_export"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_reminders_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "qualified_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      map_snapshots: {
        Row: {
          captured_at: string
          created_at: string
          id: string
          image_url: string | null
          snapshot_date: string
          summary: Json
        }
        Insert: {
          captured_at?: string
          created_at?: string
          id?: string
          image_url?: string | null
          snapshot_date: string
          summary?: Json
        }
        Update: {
          captured_at?: string
          created_at?: string
          id?: string
          image_url?: string | null
          snapshot_date?: string
          summary?: Json
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string
          id: string
          is_active: boolean
          login_otp: string | null
          login_otp_updated_at: string | null
          otp_required: boolean
          otp_verified_at: string | null
          updated_at: string
          user_id: string
          username: string | null
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string
          id?: string
          is_active?: boolean
          login_otp?: string | null
          login_otp_updated_at?: string | null
          otp_required?: boolean
          otp_verified_at?: string | null
          updated_at?: string
          user_id: string
          username?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          is_active?: boolean
          login_otp?: string | null
          login_otp_updated_at?: string | null
          otp_required?: boolean
          otp_verified_at?: string | null
          updated_at?: string
          user_id?: string
          username?: string | null
        }
        Relationships: []
      }
      qualified_leads: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          assigned_to: string | null
          called_at: string | null
          canonical_lead_link: string | null
          canonical_post_id: string | null
          contact_method: string
          context: string | null
          created_at: string
          created_by: string | null
          cs_notes: Json
          cs_outcome: string | null
          cs_status: Database["public"]["Enums"]["cs_status"]
          customer_name: string
          customer_number: string
          customer_number_2: string | null
          extra_numbers: string[]
          followup_at: string | null
          id: string
          images: Json
          is_important: boolean
          is_important_by_cs: boolean
          is_landline: boolean
          main_area: string | null
          marketing_notes: string | null
          number_name: string | null
          original_lead_link: string | null
          out_of_base: boolean
          pass_it_to: string | null
          pinned_important: boolean
          post_text: string | null
          raw_lead_cache_id: string | null
          raw_lead_id: string | null
          reference: string | null
          requirement_1: string | null
          requirement_2: string | null
          service: string | null
          state_code: string | null
          sub_area: string | null
          submitted_by_role: string | null
          updated_at: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          assigned_to?: string | null
          called_at?: string | null
          canonical_lead_link?: string | null
          canonical_post_id?: string | null
          contact_method?: string
          context?: string | null
          created_at?: string
          created_by?: string | null
          cs_notes?: Json
          cs_outcome?: string | null
          cs_status?: Database["public"]["Enums"]["cs_status"]
          customer_name: string
          customer_number: string
          customer_number_2?: string | null
          extra_numbers?: string[]
          followup_at?: string | null
          id?: string
          images?: Json
          is_important?: boolean
          is_important_by_cs?: boolean
          is_landline?: boolean
          main_area?: string | null
          marketing_notes?: string | null
          number_name?: string | null
          original_lead_link?: string | null
          out_of_base?: boolean
          pass_it_to?: string | null
          pinned_important?: boolean
          post_text?: string | null
          raw_lead_cache_id?: string | null
          raw_lead_id?: string | null
          reference?: string | null
          requirement_1?: string | null
          requirement_2?: string | null
          service?: string | null
          state_code?: string | null
          sub_area?: string | null
          submitted_by_role?: string | null
          updated_at?: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          assigned_to?: string | null
          called_at?: string | null
          canonical_lead_link?: string | null
          canonical_post_id?: string | null
          contact_method?: string
          context?: string | null
          created_at?: string
          created_by?: string | null
          cs_notes?: Json
          cs_outcome?: string | null
          cs_status?: Database["public"]["Enums"]["cs_status"]
          customer_name?: string
          customer_number?: string
          customer_number_2?: string | null
          extra_numbers?: string[]
          followup_at?: string | null
          id?: string
          images?: Json
          is_important?: boolean
          is_important_by_cs?: boolean
          is_landline?: boolean
          main_area?: string | null
          marketing_notes?: string | null
          number_name?: string | null
          original_lead_link?: string | null
          out_of_base?: boolean
          pass_it_to?: string | null
          pinned_important?: boolean
          post_text?: string | null
          raw_lead_cache_id?: string | null
          raw_lead_id?: string | null
          reference?: string | null
          requirement_1?: string | null
          requirement_2?: string | null
          service?: string | null
          state_code?: string | null
          sub_area?: string | null
          submitted_by_role?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "qualified_leads_raw_lead_cache_id_fkey"
            columns: ["raw_lead_cache_id"]
            isOneToOne: false
            referencedRelation: "raw_lead_cache"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qualified_leads_raw_lead_id_fkey"
            columns: ["raw_lead_id"]
            isOneToOne: false
            referencedRelation: "raw_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_lead_cache: {
        Row: {
          assigned_myself_at: string | null
          assigned_to: string | null
          canonical_lead_link: string | null
          canonical_post_id: string | null
          captured_at: string | null
          categorized_at: string | null
          categorized_by: string | null
          category: string | null
          created_at: string
          data: Json
          duplicate_detected: boolean | null
          duplicate_key: string | null
          duplicate_match_type: string | null
          duplicate_of_qualified_lead_id: string | null
          duplicate_of_raw_lead_id: string | null
          duplicate_reason: string | null
          duplicate_snapshot: Json | null
          id: string
          lead: string | null
          lead_link: string | null
          phone: string | null
          row_key: string
          sheet_row: number | null
          updated_at: string
        }
        Insert: {
          assigned_myself_at?: string | null
          assigned_to?: string | null
          canonical_lead_link?: string | null
          canonical_post_id?: string | null
          captured_at?: string | null
          categorized_at?: string | null
          categorized_by?: string | null
          category?: string | null
          created_at?: string
          data: Json
          duplicate_detected?: boolean | null
          duplicate_key?: string | null
          duplicate_match_type?: string | null
          duplicate_of_qualified_lead_id?: string | null
          duplicate_of_raw_lead_id?: string | null
          duplicate_reason?: string | null
          duplicate_snapshot?: Json | null
          id?: string
          lead?: string | null
          lead_link?: string | null
          phone?: string | null
          row_key: string
          sheet_row?: number | null
          updated_at?: string
        }
        Update: {
          assigned_myself_at?: string | null
          assigned_to?: string | null
          canonical_lead_link?: string | null
          canonical_post_id?: string | null
          captured_at?: string | null
          categorized_at?: string | null
          categorized_by?: string | null
          category?: string | null
          created_at?: string
          data?: Json
          duplicate_detected?: boolean | null
          duplicate_key?: string | null
          duplicate_match_type?: string | null
          duplicate_of_qualified_lead_id?: string | null
          duplicate_of_raw_lead_id?: string | null
          duplicate_reason?: string | null
          duplicate_snapshot?: Json | null
          id?: string
          lead?: string | null
          lead_link?: string | null
          phone?: string | null
          row_key?: string
          sheet_row?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      raw_lead_cache_counts: {
        Row: {
          assigned_to: string
          category_key: string
          total: number
        }
        Insert: {
          assigned_to?: string
          category_key: string
          total?: number
        }
        Update: {
          assigned_to?: string
          category_key?: string
          total?: number
        }
        Relationships: []
      }
      raw_leads: {
        Row: {
          account_area: string | null
          account_name: string | null
          cancel_reason:
            | Database["public"]["Enums"]["raw_lead_cancel_reason"]
            | null
          captured_at: string
          created_at: string
          external_id: string | null
          id: string
          lead_link: string | null
          post_text: string | null
          posted_at: string | null
          poster_name: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["raw_lead_status"]
          sub_area: string | null
          updated_at: string
        }
        Insert: {
          account_area?: string | null
          account_name?: string | null
          cancel_reason?:
            | Database["public"]["Enums"]["raw_lead_cancel_reason"]
            | null
          captured_at?: string
          created_at?: string
          external_id?: string | null
          id?: string
          lead_link?: string | null
          post_text?: string | null
          posted_at?: string | null
          poster_name?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["raw_lead_status"]
          sub_area?: string | null
          updated_at?: string
        }
        Update: {
          account_area?: string | null
          account_name?: string | null
          cancel_reason?:
            | Database["public"]["Enums"]["raw_lead_cancel_reason"]
            | null
          captured_at?: string
          created_at?: string
          external_id?: string | null
          id?: string
          lead_link?: string | null
          post_text?: string | null
          posted_at?: string | null
          poster_name?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["raw_lead_status"]
          sub_area?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      service_area_bases: {
        Row: {
          active_from: string | null
          active_to: string | null
          city: string | null
          created_at: string
          created_by: string | null
          enforcement_mode: string
          id: string
          role_group: string
          service_scope: string
          service_value: string
          state_code: string
        }
        Insert: {
          active_from?: string | null
          active_to?: string | null
          city?: string | null
          created_at?: string
          created_by?: string | null
          enforcement_mode?: string
          id?: string
          role_group: string
          service_scope: string
          service_value: string
          state_code: string
        }
        Update: {
          active_from?: string | null
          active_to?: string | null
          city?: string | null
          created_at?: string
          created_by?: string | null
          enforcement_mode?: string
          id?: string
          role_group?: string
          service_scope?: string
          service_value?: string
          state_code?: string
        }
        Relationships: []
      }
      service_assignments: {
        Row: {
          assigned_by: string | null
          assigned_cs_user_id: string
          created_at: string
          service_category: string | null
          service_key: string
          service_name: string
          updated_at: string
        }
        Insert: {
          assigned_by?: string | null
          assigned_cs_user_id: string
          created_at?: string
          service_category?: string | null
          service_key: string
          service_name: string
          updated_at?: string
        }
        Update: {
          assigned_by?: string | null
          assigned_cs_user_id?: string
          created_at?: string
          service_category?: string | null
          service_key?: string
          service_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      shared_state: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      state_assignments: {
        Row: {
          assigned_by: string | null
          assigned_cs_user_id: string
          created_at: string
          state_code: string
          state_name: string
          updated_at: string
        }
        Insert: {
          assigned_by?: string | null
          assigned_cs_user_id: string
          created_at?: string
          state_code: string
          state_name: string
          updated_at?: string
        }
        Update: {
          assigned_by?: string | null
          assigned_cs_user_id?: string
          created_at?: string
          state_code?: string
          state_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_access_codes: {
        Row: {
          code: string
          updated_at: string
          user_id: string
          verified_session_id: string | null
        }
        Insert: {
          code: string
          updated_at?: string
          user_id: string
          verified_session_id?: string | null
        }
        Update: {
          code?: string
          updated_at?: string
          user_id?: string
          verified_session_id?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      mv_qualified_leads_status_counts: {
        Row: {
          assigned_to: string | null
          created_by: string | null
          cs_status: Database["public"]["Enums"]["cs_status"] | null
          total: number | null
        }
        Relationships: []
      }
      mv_raw_lead_cache_counts: {
        Row: {
          assigned_to: string | null
          category: string | null
          is_assigned_myself: boolean | null
          total: number | null
        }
        Relationships: []
      }
      processed_leads_export: {
        Row: {
          "Assigned Date": string | null
          "Current Status": Database["public"]["Enums"]["cs_status"] | null
          "Customer Name": string | null
          "Handled By": string | null
          id: string | null
          "Main Area": string | null
          "Marketing Notes": string | null
          "Nextdoor Link": string | null
          "Phone Number": string | null
          "Service Required": string | null
          "Sub Area": string | null
        }
        Relationships: []
      }
    }
    Functions: {
      acknowledge_lead_reminders: {
        Args: { _lead_id: string }
        Returns: number
      }
      adjust_raw_lead_cache_count: {
        Args: { _assigned_to: string; _category_key: string; _delta: number }
        Returns: undefined
      }
      admin_ensure_access_code: { Args: { _user_id: string }; Returns: string }
      admin_list_access_codes: {
        Args: never
        Returns: {
          code: string
          updated_at: string
          user_id: string
          verified: boolean
        }[]
      }
      admin_regenerate_access_code: {
        Args: { _user_id: string }
        Returns: string
      }
      assign_raw_leads_to_me: { Args: { p_limit: number }; Returns: number }
      batch_update_raw_lead_decisions: {
        Args: { decisions: Json }
        Returns: number
      }
      browser_profile_performance: {
        Args: { _from: string; _to: string }
        Returns: {
          account_area: string
          cx_interested: number
          delivered: number
          forwarded: number
          incogniton_profile_id: string
          launch_count: number
          profile_id: string
          profile_name: string
          profile_priority: string
          scraped_posts: number
          top_service: string
        }[]
      }
      check_qualified_lead_phone_duplicates: {
        Args: { _phone_digits: string; _since: string }
        Returns: {
          assigned_at: string
          customer_name: string
          customer_number: string
          customer_number_2: string
          id: string
        }[]
      }
      claim_crisp_visitor_sync: {
        Args: { p_stale_before: string; p_website_id: string }
        Returns: boolean
      }
      count_pending_reminder_leads: { Args: never; Returns: number }
      crisp_accept_event: {
        Args: { p_body: Json; p_fingerprint: string }
        Returns: string
      }
      crisp_apply_event: { Args: { p_body: Json }; Returns: undefined }
      crisp_begin_greeting: {
        Args: { p_id: string; p_token: string }
        Returns: boolean
      }
      crisp_claim_greetings: {
        Args: { p_limit?: number; p_website_id: string }
        Returns: {
          attempts: number
          content: string
          created_at: string
          crisp_session_id: string
          crisp_website_id: string
          due_at: string
          expires_at: string
          external_fingerprint: string | null
          id: string
          is_revisit: boolean
          last_error: string | null
          lease_token: string | null
          lease_until: string | null
          request_started_at: string | null
          sent_at: string | null
          state: string
        }[]
        SetofOptions: {
          from: "*"
          to: "crisp_greeting_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      crisp_claim_presence: { Args: { p_website_id: string }; Returns: string }
      crisp_complete_greeting: {
        Args: {
          p_error?: string
          p_id: string
          p_outcome: string
          p_response?: Json
          p_token: string
        }
        Returns: undefined
      }
      crisp_create_workspace_secret: {
        Args: {
          p_token_id: string
          p_token_key: string
          p_webhook_secret: string
          p_website_id: string
        }
        Returns: string
      }
      crisp_delete_workspace_secret: {
        Args: { p_secret_id: string }
        Returns: boolean
      }
      crisp_finish_presence: {
        Args: {
          p_active: number
          p_complete: boolean
          p_count: number
          p_error?: string
          p_limited: boolean
          p_rows: Json
          p_started_at: string
          p_token: string
          p_website_id: string
        }
        Returns: boolean
      }
      crisp_finish_presence_v2: {
        Args: {
          p_active: number
          p_complete: boolean
          p_count: number
          p_duration_ms: number
          p_error: string
          p_limited: boolean
          p_mode: string
          p_requests: number
          p_rows: Json
          p_started_at: string
          p_token: string
          p_website_id: string
        }
        Returns: boolean
      }
      crisp_get_site_bridge: { Args: { p_website_id: string }; Returns: Json }
      crisp_finish_presence_v3: {
        Args: {
          p_active: number
          p_cached: boolean
          p_complete: boolean
          p_count: number
          p_duration_ms: number
          p_error: string
          p_limited: boolean
          p_mode: string
          p_requests: number
          p_rows: Json
          p_started_at: string
          p_token: string
          p_website_id: string
        }
        Returns: boolean
      }
      crisp_get_workspace_secret: {
        Args: { p_secret_id: string }
        Returns: Json
      }
      crisp_import_messages: { Args: { p_rows: Json }; Returns: number }
      crisp_mark_read_local: {
        Args: { p_conversation_id: string; p_observed_at: string }
        Returns: undefined
      }
      crisp_process_events: {
        Args: { p_limit?: number; p_website_id?: string }
        Returns: number
      }
      crisp_pending_site_sessions: { Args: { p_website_id: string }; Returns: string[] }
      crisp_provision_site_bridge: {
        Args: { p_key: string; p_origin: string; p_website_id: string }
        Returns: undefined
      }
      crisp_read_plugin_signing_secret: { Args: never; Returns: string }
      crisp_record_outgoing: {
        Args: {
          p_content: string
          p_payload: Json
          p_session_id: string
          p_website_id: string
        }
        Returns: string
      }
      crisp_register_site_arrival: {
        Args: {
          p_request_id: string
          p_session_id: string
          p_website_id: string
        }
        Returns: string
      }
      crisp_reserve_request: {
        Args: { p_interactive?: boolean; p_website_id: string }
        Returns: boolean
      }
      crisp_set_cooldown: {
        Args: { p_seconds: number; p_website_id: string }
        Returns: undefined
      }
      crisp_update_workspace_secret: {
        Args: {
          p_secret_id: string
          p_token_id: string
          p_token_key: string
          p_webhook_secret: string
        }
        Returns: boolean
      }
      crisp_worker_authorized: { Args: { p_token: string }; Returns: boolean }
      cs_leads_status_counts: { Args: never; Returns: Json }
      cs_next_compose_sender_tick: { Args: never; Returns: number }
      cs_user_assignment_totals: {
        Args: { _from?: string; _to?: string }
        Returns: {
          assigned_states: string[]
          by_state: Json
          by_status: Json
          cs_user_email: string
          cs_user_id: string
          cs_user_name: string
          pending_leads: number
          processed_leads: number
          total_leads: number
        }[]
      }
      current_user_has_role: {
        Args: { _role: Database["public"]["Enums"]["app_role"] }
        Returns: boolean
      }
      current_user_has_role_text: { Args: { _role: string }; Returns: boolean }
      email_for_username: { Args: { _username: string }; Returns: string }
      generate_access_code: { Args: never; Returns: string }
      generate_login_otp: { Args: never; Returns: string }
      get_admin_dashboard_stats: { Args: { _today: string }; Returns: Json }
      get_analytics_daily_stats: {
        Args: { _end_date: string; _start_date: string }
        Returns: {
          day_key: string
          forwarded_count: number
          sent_to_cs_count: number
          total_captured: number
          wrong_count: number
        }[]
      }
      get_crisp_conversations_page: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_search?: string
          p_website_ids: string[]
        }
        Returns: {
          created_at: string
          crisp_session_id: string
          crisp_website_id: string
          customer_avatar: string
          customer_email: string
          customer_name: string
          customer_phone: string
          id: string
          last_customer_unread_at: string
          last_message: string
          last_message_at: string
          metadata: Json
          status: string
          unread_count: number
          updated_at: string
        }[]
      }
      get_crisp_today_visitors_summary: {
        Args: { p_today_start: string }
        Returns: {
          crisp_website_id: string
          today_visitor_count: number
        }[]
      }
      get_crisp_workspace_summaries: {
        Args: never
        Returns: {
          crisp_website_id: string
          has_unread: boolean
          latest_unread_at: string
          total_chat_count: number
          unreplied_chat_count: number
        }[]
      }
      get_raw_lead_duplicate_match_preview: {
        Args: { _current_raw_lead_id: string }
        Returns: Json
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_crisp_masked_content: { Args: { p_content: string }; Returns: boolean }
      is_my_access_verified: { Args: never; Returns: boolean }
      list_pending_reminder_leads: {
        Args: never
        Returns: {
          assigned_to: string
          cs_status: string
          customer_name: string
          customer_number: string
          last_message: string
          last_reminder_at: string
          lead_id: string
          main_area: string
          reminder_count: number
          sub_area: string
        }[]
      }
      list_service_assignments: {
        Args: never
        Returns: {
          assigned_cs_user_id: string
          cs_user_email: string
          cs_user_name: string
          service_category: string
          service_key: string
          service_name: string
          total_leads: number
          updated_at: string
        }[]
      }
      list_state_assignments: {
        Args: never
        Returns: {
          assigned_cs_user_id: string
          cs_user_email: string
          cs_user_name: string
          state_code: string
          state_name: string
          total_leads: number
          updated_at: string
        }[]
      }
      normalize_lead_service: { Args: { _input: string }; Returns: string }
      normalize_us_state: { Args: { _input: string }; Returns: string }
      qualified_leads_cursor_page: {
        Args: {
          _assigned_to?: string
          _cs_status?: Database["public"]["Enums"]["cs_status"]
          _cursor_id?: string
          _cursor_updated_at?: string
          _limit?: number
        }
        Returns: {
          assigned_at: string
          assigned_by: string | null
          assigned_to: string | null
          called_at: string | null
          canonical_lead_link: string | null
          canonical_post_id: string | null
          contact_method: string
          context: string | null
          created_at: string
          created_by: string | null
          cs_notes: Json
          cs_outcome: string | null
          cs_status: Database["public"]["Enums"]["cs_status"]
          customer_name: string
          customer_number: string
          customer_number_2: string | null
          extra_numbers: string[]
          followup_at: string | null
          id: string
          images: Json
          is_important: boolean
          is_important_by_cs: boolean
          is_landline: boolean
          main_area: string | null
          marketing_notes: string | null
          number_name: string | null
          original_lead_link: string | null
          out_of_base: boolean
          pass_it_to: string | null
          pinned_important: boolean
          post_text: string | null
          raw_lead_cache_id: string | null
          raw_lead_id: string | null
          reference: string | null
          requirement_1: string | null
          requirement_2: string | null
          service: string | null
          state_code: string | null
          sub_area: string | null
          submitted_by_role: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "qualified_leads"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      qualified_leads_status_counts_fast: {
        Args: { _is_admin?: boolean; _user_id: string }
        Returns: {
          cs_status: Database["public"]["Enums"]["cs_status"]
          total: number
        }[]
      }
      raw_lead_cache_category_counts: {
        Args: { _is_admin?: boolean; _user_id: string }
        Returns: {
          assigned_myself: number
          duplicate: number
          forwarded: number
          new: number
          not_found: number
          wrong: number
        }[]
      }
      raw_lead_cache_category_counts_fast: {
        Args: { _is_admin?: boolean; _user_id: string }
        Returns: {
          assigned_myself: number
          duplicate: number
          forwarded: number
          new: number
          not_found: number
          wrong: number
        }[]
      }
      raw_lead_cache_category_counts_json: {
        Args: { _is_admin?: boolean; _user_id?: string }
        Returns: Json
      }
      raw_lead_cache_cursor_page: {
        Args: {
          _assigned_to?: string
          _category?: string
          _cursor_captured_at?: string
          _cursor_id?: string
          _limit?: number
          _only_unassigned_myself?: boolean
        }
        Returns: {
          assigned_myself_at: string | null
          assigned_to: string | null
          canonical_lead_link: string | null
          canonical_post_id: string | null
          captured_at: string | null
          categorized_at: string | null
          categorized_by: string | null
          category: string | null
          created_at: string
          data: Json
          duplicate_detected: boolean | null
          duplicate_key: string | null
          duplicate_match_type: string | null
          duplicate_of_qualified_lead_id: string | null
          duplicate_of_raw_lead_id: string | null
          duplicate_reason: string | null
          duplicate_snapshot: Json | null
          id: string
          lead: string | null
          lead_link: string | null
          phone: string | null
          row_key: string
          sheet_row: number | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "raw_lead_cache"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      raw_lead_cache_new_cursor_page: {
        Args: {
          p_after_captured_at?: string
          p_after_id?: string
          p_assigned_to?: string
          p_limit?: number
        }
        Returns: {
          assigned_myself_at: string | null
          assigned_to: string | null
          canonical_lead_link: string | null
          canonical_post_id: string | null
          captured_at: string | null
          categorized_at: string | null
          categorized_by: string | null
          category: string | null
          created_at: string
          data: Json
          duplicate_detected: boolean | null
          duplicate_key: string | null
          duplicate_match_type: string | null
          duplicate_of_qualified_lead_id: string | null
          duplicate_of_raw_lead_id: string | null
          duplicate_reason: string | null
          duplicate_snapshot: Json | null
          id: string
          lead: string | null
          lead_link: string | null
          phone: string | null
          row_key: string
          sheet_row: number | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "raw_lead_cache"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      raw_lead_count_key: {
        Args: { _assigned_myself_at: string; _category: string }
        Returns: string
      }
      refresh_lead_counter_materialized_views: {
        Args: never
        Returns: undefined
      }
      refresh_mv_qualified_leads_status_counts: {
        Args: never
        Returns: undefined
      }
      refresh_mv_raw_lead_cache_counts: { Args: never; Returns: undefined }
      report_leads_by_account:
        | {
            Args: never
            Returns: {
              account: string
              no_count: number
              pending_count: number
              total_count: number
              yes_count: number
            }[]
          }
        | {
            Args: { _from?: string; _to?: string }
            Returns: {
              account: string
              no_count: number
              pending_count: number
              total_count: number
              yes_count: number
            }[]
          }
      report_leads_forwarded_by_maturing: {
        Args: { _from?: string; _to?: string }
        Returns: {
          forwarded_count: number
          maturing_email: string
          maturing_id: string
          maturing_name: string
        }[]
      }
      report_not_found_by_user: {
        Args: { _from?: string; _to?: string }
        Returns: {
          not_found_count: number
          user_email: string
          user_id: string
          user_name: string
        }[]
      }
      send_lead_reminder: {
        Args: { _lead_id: string; _message: string }
        Returns: Json
      }
      state_assignment_analytics: {
        Args: { _from?: string; _to?: string }
        Returns: {
          assigned_cs_user_id: string
          by_status: Json
          cs_user_name: string
          state_code: string
          state_name: string
          total_leads: number
        }[]
      }
      verify_my_access_code: { Args: { _code: string }; Returns: boolean }
    }
    Enums: {
      app_role:
        | "admin"
        | "scraping"
        | "cs"
        | "maturing"
        | "acc_handler"
        | "facebook"
        | "seo"
        | "sub_admin"
        | "cs_admin"
      cs_status:
        | "new"
        | "called"
        | "messaged"
        | "follow_up"
        | "interested"
        | "converted"
        | "closed_won"
        | "closed_lost"
        | "not_interested"
        | "already_done"
        | "no_response"
        | "undeliver"
        | "wrong_number"
        | "already_got_someone"
        | "service_provider_himself"
        | "need_follow_up"
        | "wrong_lead"
        | "wrong_service"
        | "wrong_person"
        | "small_service"
        | "already_received_before"
        | "out_of_base"
        | "cx_interested"
        | "cx_not_interested"
        | "cx_didnt_replied"
      raw_lead_cancel_reason:
        | "not_a_lead"
        | "general_post"
        | "spam"
        | "duplicate"
        | "irrelevant"
        | "number_not_found"
      raw_lead_status: "new" | "qualified" | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "admin",
        "scraping",
        "cs",
        "maturing",
        "acc_handler",
        "facebook",
        "seo",
        "sub_admin",
        "cs_admin",
      ],
      cs_status: [
        "new",
        "called",
        "messaged",
        "follow_up",
        "interested",
        "converted",
        "closed_won",
        "closed_lost",
        "not_interested",
        "already_done",
        "no_response",
        "undeliver",
        "wrong_number",
        "already_got_someone",
        "service_provider_himself",
        "need_follow_up",
        "wrong_lead",
        "wrong_service",
        "wrong_person",
        "small_service",
        "already_received_before",
        "out_of_base",
        "cx_interested",
        "cx_not_interested",
        "cx_didnt_replied",
      ],
      raw_lead_cancel_reason: [
        "not_a_lead",
        "general_post",
        "spam",
        "duplicate",
        "irrelevant",
        "number_not_found",
      ],
      raw_lead_status: ["new", "qualified", "cancelled"],
    },
  },
} as const
