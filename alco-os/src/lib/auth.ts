import type { SupabaseClient } from "@supabase/supabase-js";

export interface CurrentUser {
  userId: string;
  organizationId: string;
  displayName: string;
}

/**
 * ログイン中ユーザーのプロフィール（組織ID含む）を取得する。
 * 未ログイン・プロフィール未作成なら null。
 */
export async function getCurrentUser(supabase: SupabaseClient): Promise<CurrentUser | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, organization_id, display_name")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return null;

  return {
    userId: profile.id,
    organizationId: profile.organization_id,
    displayName: profile.display_name,
  };
}
