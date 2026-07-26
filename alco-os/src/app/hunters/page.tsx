import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser, canApprove } from "@/lib/auth";
import { Card, PageHeader, SetupNotice, EmptyState } from "@/components/ui";
import { csvTemplate, describeBankAccount } from "@/domain/hunters/hunter-profile-service";
import { CsvImportForm, HunterCard, type HunterRow } from "./hunter-forms";

export const dynamic = "force-dynamic";

/**
 * 捕獲者の追加情報（B案 / 2026-07-26 確定）。
 *
 * LINEでは口座を扱わない。ここは職員が電話・対面で聞き取った内容を入れる画面。
 * 口座は既存 hunters の欄に保存し、一覧では下4桁だけ表示する。
 * フル表示・保存・CSV取り込みは承認権限（owner / manager）が必要。
 */
export default async function HuntersPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="捕獲者の情報" description="追加情報と口座の登録" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) {
    return (
      <>
        <PageHeader title="捕獲者の情報" />
        <Card>
          <p className="text-base">ログインが必要です。</p>
        </Card>
      </>
    );
  }
  const approver = await canApprove(supabase);

  const [{ data: hunters }, { data: profiles }] = await Promise.all([
    supabase
      .from("hunters")
      .select("id, name, city, bank_name, account_number")
      .is("deleted_at", null)
      .order("name")
      .limit(500),
    supabase
      .from("hunter_profiles")
      .select(
        "hunter_id, birth_date, postal_code, address, phone, activity_area, has_worker_card, worker_card_number",
      )
      .limit(500),
  ]);

  const profileByHunter = new Map(
    (profiles ?? []).map((p) => [
      String(p.hunter_id),
      {
        birthDate: (p.birth_date as string | null) ?? null,
        postalCode: (p.postal_code as string | null) ?? null,
        address: (p.address as string | null) ?? null,
        phone: (p.phone as string | null) ?? null,
        activityArea: (p.activity_area as string | null) ?? null,
        hasWorkerCard: (p.has_worker_card as boolean | null) ?? null,
        workerCardNumber: (p.worker_card_number as string | null) ?? null,
      },
    ]),
  );

  const rows: HunterRow[] = (hunters ?? []).map((h) => ({
    id: String(h.id),
    name: String(h.name),
    city: (h.city as string | null) ?? null,
    bankSummary: describeBankAccount(h as Record<string, unknown>),
    profile: profileByHunter.get(String(h.id)) ?? null,
  }));

  const withProfile = rows.filter((r) => r.profile !== null).length;
  const withBank = rows.filter((r) => r.bankSummary !== "未登録").length;

  return (
    <>
      <PageHeader
        title="捕獲者の情報"
        description="追加情報（生年月日・住所・電話・活動エリア・従事者証）と口座の登録。"
      />

      <div className="space-y-6">
        <Card className="bg-amber-50">
          <p className="text-base font-bold text-amber-900">口座の取り扱い</p>
          <p className="mt-1 text-base text-amber-900">
            口座番号はLINEでは受け取りません。電話または搬入時の対面で聞き取り、この画面から
            入力してください。一覧では下4桁だけ表示します。すべて表示する操作は記録に残ります。
          </p>
        </Card>

        <Card className="bg-stone-50">
          <p className="text-base text-stone-700">
            捕獲者：{rows.length}人 ／ 追加情報の登録ずみ：{withProfile}人 ／ 口座の登録ずみ：
            {withBank}人
          </p>
        </Card>

        {approver ? (
          <section>
            <h2 className="mb-2 text-lg font-bold text-stone-800">CSVで一括取り込み</h2>
            <Card>
              <CsvImportForm template={csvTemplate()} />
            </Card>
          </section>
        ) : null}

        <section>
          <h2 className="mb-2 text-lg font-bold text-stone-800">捕獲者一覧</h2>
          {rows.length === 0 ? (
            <EmptyState message="捕獲者台帳が読み込めませんでした。" />
          ) : (
            <div className="space-y-3">
              {rows.map((hunter) => (
                <HunterCard key={hunter.id} hunter={hunter} canApprove={approver} />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
