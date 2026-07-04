import type { SupabaseClient } from "@supabase/supabase-js";

export interface CurrentUser {
  userId: string;
  organizationId: string;
  displayName: string;
}

/**
 * ログイン中ユーザーのプロフィール（組織ID含む）を取得する。
 * プロフィール未作成なら provision_profile RPC（0009）で自動作成する
 * （Supabase Dashboard でユーザーを作るだけで使い始められる。
 *   最初のユーザーは owner、以降は staff ロールが付く）。
 * 未ログインなら null。
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

  if (profile) {
    return {
      userId: profile.id,
      organizationId: profile.organization_id,
      displayName: profile.display_name,
    };
  }

  // 初回ログイン: プロフィールを自動プロビジョニング
  const { data: provisioned, error } = await supabase.rpc("provision_profile");
  if (error || !provisioned) return null;
  return {
    userId: provisioned.id,
    organizationId: provisioned.organization_id,
    displayName: provisioned.display_name,
  };
}

/** 承認権限（owner / manager）を持つか。RLSでも強制されるが、UI/アクション側の事前チェック用 */
export async function canApprove(supabase: SupabaseClient): Promise<boolean> {
  const { data } = await supabase.rpc("can_approve");
  return data === true;
}
