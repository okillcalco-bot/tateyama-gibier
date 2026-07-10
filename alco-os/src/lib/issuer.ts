import type { SupabaseClient } from "@supabase/supabase-js";
import type { Issuer } from "@/domain/billing/billing-service";

/**
 * 帳票の発行者情報。既存ジビエ基幹と共用の org_settings（キー・バリュー）から読む。
 * キー: org_name / org_postal / org_address / org_phone / invoice_number / org_bank_info
 */
export async function loadIssuer(supabase: SupabaseClient): Promise<Issuer> {
  const { data } = await supabase.from("org_settings").select("key, value");
  const map = new Map((data ?? []).map((row) => [row.key as string, (row.value as string) ?? ""]));
  return {
    name: map.get("org_name") || "館山ジビエセンター",
    postal: map.get("org_postal") || "",
    address: map.get("org_address") || "",
    phone: map.get("org_phone") || "",
    registrationNumber: map.get("invoice_number") || "",
    bankInfo: map.get("org_bank_info") || "",
  };
}
