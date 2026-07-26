import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { SupabaseDb } from "@/lib/db/supabase-db";
import type { DbPort } from "@/lib/db/port";

/**
 * 外部からの受信処理（webhook / 受信箱API）用の DB コンテキスト。
 *
 * これらの入口にはログインユーザーが存在しないため service_role キーを使う。
 * service_role は RLS を通らないので、呼び出し側で「どの組織の行か」を
 * 必ず明示すること（organization_id を必ず埋める）。
 *
 * service_role キーはサーバー側でのみ読む（クライアントへ渡さない）。
 */
export interface ServiceDbContext {
  db: DbPort;
  organizationId: string;
  /** Storage など DbPort で表せない操作用。業務データの読み書きは db を使うこと */
  supabase: SupabaseClient;
}

export async function getServiceDbContext(): Promise<ServiceDbContext> {
  if (!env.supabaseServiceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY 未設定");
  }
  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);
  const { data: org, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", "alco")
    .single();
  if (error || !org) throw new Error("組織が見つかりません");

  return { db: new SupabaseDb(supabase), organizationId: org.id as string, supabase };
}
