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
      admin_settings: {
        Row: {
          access_tokens: string[]
          admin_ids: number[]
          id: number
          updated_at: string
        }
        Insert: {
          access_tokens?: string[]
          admin_ids?: number[]
          id?: number
          updated_at?: string
        }
        Update: {
          access_tokens?: string[]
          admin_ids?: number[]
          id?: number
          updated_at?: string
        }
        Relationships: []
      }
      admin_state: {
        Row: {
          chat_id: number
          pending_keyword: string | null
          pending_replies: Json
          selected_keyword: string | null
          state: string | null
          updated_at: string
        }
        Insert: {
          chat_id: number
          pending_keyword?: string | null
          pending_replies?: Json
          selected_keyword?: string | null
          state?: string | null
          updated_at?: string
        }
        Update: {
          chat_id?: number
          pending_keyword?: string | null
          pending_replies?: Json
          selected_keyword?: string | null
          state?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      bot_config: {
        Row: {
          delete_after_seconds: number
          id: number
          updated_at: string
        }
        Insert: {
          delete_after_seconds?: number
          id?: number
          updated_at?: string
        }
        Update: {
          delete_after_seconds?: number
          id?: number
          updated_at?: string
        }
        Relationships: []
      }
      pending_deletions: {
        Row: {
          chat_id: number
          created_at: string
          delete_at: string
          id: number
          message_id: number
        }
        Insert: {
          chat_id: number
          created_at?: string
          delete_at: string
          id?: number
          message_id: number
        }
        Update: {
          chat_id?: number
          created_at?: string
          delete_at?: string
          id?: number
          message_id?: number
        }
        Relationships: []
      }
      replies: {
        Row: {
          content: Json
          created_at: string
          delete_after_seconds: number | null
          keyword: string
          position: number
          row_index: number
          updated_at: string
        }
        Insert: {
          content: Json
          created_at?: string
          delete_after_seconds?: number | null
          keyword: string
          position?: number
          row_index?: number
          updated_at?: string
        }
        Update: {
          content?: Json
          created_at?: string
          delete_after_seconds?: number | null
          keyword?: string
          position?: number
          row_index?: number
          updated_at?: string
        }
        Relationships: []
      }
      scheduled_messages: {
        Row: {
          created_at: string
          daily_time: string | null
          enabled: boolean
          group_chat_id: number
          group_title: string | null
          id: number
          keyword: string
          last_sent_at: string | null
          repeat_daily: boolean
          scheduled_at: string | null
        }
        Insert: {
          created_at?: string
          daily_time?: string | null
          enabled?: boolean
          group_chat_id: number
          group_title?: string | null
          id?: number
          keyword: string
          last_sent_at?: string | null
          repeat_daily?: boolean
          scheduled_at?: string | null
        }
        Update: {
          created_at?: string
          daily_time?: string | null
          enabled?: boolean
          group_chat_id?: number
          group_title?: string | null
          id?: number
          keyword?: string
          last_sent_at?: string | null
          repeat_daily?: boolean
          scheduled_at?: string | null
        }
        Relationships: []
      }
      tg_groups: {
        Row: {
          chat_id: number
          is_member: boolean
          title: string | null
          updated_at: string
        }
        Insert: {
          chat_id: number
          is_member?: boolean
          title?: string | null
          updated_at?: string
        }
        Update: {
          chat_id?: number
          is_member?: boolean
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      usage_logs: {
        Row: {
          chat_id: number
          chat_title: string | null
          chat_type: string | null
          created_at: string
          id: number
          keyword: string
          user_id: number | null
          username: string | null
        }
        Insert: {
          chat_id: number
          chat_title?: string | null
          chat_type?: string | null
          created_at?: string
          id?: number
          keyword: string
          user_id?: number | null
          username?: string | null
        }
        Update: {
          chat_id?: number
          chat_title?: string | null
          chat_type?: string | null
          created_at?: string
          id?: number
          keyword?: string
          user_id?: number | null
          username?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_daily_activity: {
        Args: { days?: number }
        Returns: {
          day: string
          hits: number
        }[]
      }
      get_group_activity: {
        Args: { days?: number; top_n?: number }
        Returns: {
          chat_id: number
          chat_title: string
          hits: number
          last_used: string
        }[]
      }
      get_keyword_stats: {
        Args: { days?: number; top_n?: number }
        Returns: {
          hits: number
          keyword: string
          last_used: string
        }[]
      }
      get_overall_stats: { Args: never; Returns: Json }
    }
    Enums: {
      [_ in never]: never
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
