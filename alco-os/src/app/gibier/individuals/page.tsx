import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, CardTitle, PageHeader, SetupNotice, EmptyState, Badge } from "@/components/ui";
import { assessLinkHealth, inventoryLabelId, type Row } from "@/domain/gibier/individual-trace";

export const dynamic = "force-dynamic";

/**
 * 個体トレース 一覧（読み取り専用）。
 *
 * 「1頭の一生」を label_id で追えるようにする入口。
 * **館山ジビエのDBの軸は変えない。** 既存テーブルを読むだけで、
 * 列の追加もデータの修復も行わない（docs/ALCO_OS_GAP_ANALYSIS.md）。
 */

const PAGE_SIZE = 60;

export default async function IndividualsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; issues?: string }>;
}) {
  const params = await searchParams;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="個体トレース" />
        <SetupNotice />
      </>
    );
  }

  const keyword = (params.q ?? "").trim();
  const onlyIssues = params.issues === "1";
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from("individuals")
    .select(
      "id, label_id, serial_number, species, capture_date, hunter_name, weight_total, meat_rank, intake_status, quality",
    )
    .is("deleted_at", null)
    .order("serial_number", { ascending: false })
    .limit(PAGE_SIZE);
  if (keyword) {
    query = query.or(
      `label_id.ilike.%${keyword}%,hunter_name.ilike.%${keyword}%,species.ilike.%${keyword}%`,
    );
  }

  // 接続状況の判定には全件が要る（軽い列だけ引く）
  const [{ data: listed }, { data: allIndividuals }, { data: allInventory }] = await Promise.all([
    query,
    supabase.from("individuals").select("label_id").is("deleted_at", null).limit(5000),
    supabase
      .from("inventory")
      .select("id, individual_id, individual_code, ident_code, part_name")
      .is("deleted_at", null)
      .limit(5000),
  ]);

  const health = assessLinkHealth(
    (allIndividuals ?? []) as Row[],
    (allInventory ?? []) as Row[],
  );

  // 部位在庫を持っている個体（一覧に「解体済み」の目印を出すため）
  const withInventory = new Set(
    ((allInventory ?? []) as Row[])
      .map((inv) => inventoryLabelId(inv))
      .filter((v): v is string => v !== null),
  );

  const rows = ((listed ?? []) as Row[]).filter((r) =>
    onlyIssues ? !withInventory.has(String(r.label_id ?? "")) : true,
  );

  return (
    <>
      <PageHeader
        title="個体トレース"
        description="捕獲から販売までを個体番号（TGC-08-…）でたどります。表示のみで、データは変更しません。"
      />
      <div className="space-y-4">
        {/* 接続状況（測るだけ・直さない） */}
        <Card>
          <CardTitle>データのつながり具合</CardTitle>
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              個体台帳 <strong>{health.individualCount}</strong> 頭
            </span>
            <span>
              部位在庫 <strong>{health.inventoryCount}</strong> 件
            </span>
            <span>
              うち個体とつながっている{" "}
              <strong
                className={health.linkedPercent >= 95 ? "text-green-700" : "text-amber-700"}
              >
                {health.linkedInventoryCount}件（{health.linkedPercent}%）
              </strong>
            </span>
          </div>
          {health.orphanInventory.length ? (
            <details className="mt-2 rounded-lg bg-amber-50 p-2">
              <summary className="cursor-pointer text-sm font-semibold text-amber-900">
                ⚠️ 個体台帳に見つからない在庫が {health.orphanInventory.length} 件あります（要確認）
              </summary>
              <p className="mt-1 text-xs text-amber-900">
                古いデータか、個体番号の打ち間違いの可能性があります。
                <strong>この画面では直しません。</strong>中身を見て、どうするか決めてください。
              </p>
              <ul className="mt-2 max-h-64 overflow-y-auto text-xs">
                {health.orphanInventory.slice(0, 100).map((o, i) => (
                  <li key={i} className="border-b border-amber-100 py-1">
                    <code>{o.identCode ?? "(識別コードなし)"}</code>
                    <span className="ml-2 text-amber-800">
                      個体番号: {o.labelId ?? "（不明）"} / 部位: {o.partName ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
              {health.orphanInventory.length > 100 ? (
                <p className="mt-1 text-xs text-amber-700">
                  （先頭100件のみ表示・全{health.orphanInventory.length}件）
                </p>
              ) : null}
            </details>
          ) : (
            <p className="mt-2 text-xs text-green-700">
              ✓ すべての在庫が個体台帳とつながっています。
            </p>
          )}
        </Card>

        {/* 検索 */}
        <Card>
          <form method="get" className="flex flex-wrap gap-2">
            <input
              name="q"
              defaultValue={keyword}
              placeholder="個体番号・捕獲者名・獣種で検索（例: T239）"
              className="min-h-11 flex-1 rounded-lg border border-stone-300 px-3 text-base"
            />
            <button
              type="submit"
              className="min-h-11 rounded-lg bg-green-700 px-4 text-sm font-semibold text-white"
            >
              検索
            </button>
            {keyword || onlyIssues ? (
              <Link
                href="/gibier/individuals"
                className="flex min-h-11 items-center rounded-lg border border-stone-300 px-4 text-sm text-stone-600"
              >
                クリア
              </Link>
            ) : null}
          </form>
          <div className="mt-2 flex gap-2 text-xs">
            <Link
              href={`/gibier/individuals${keyword ? `?q=${encodeURIComponent(keyword)}` : ""}`}
              className={`rounded-full px-3 py-1 ${!onlyIssues ? "bg-green-700 text-white" : "border border-stone-300 text-stone-600"}`}
            >
              すべて
            </Link>
            <Link
              href={`/gibier/individuals?issues=1${keyword ? `&q=${encodeURIComponent(keyword)}` : ""}`}
              className={`rounded-full px-3 py-1 ${onlyIssues ? "bg-green-700 text-white" : "border border-stone-300 text-stone-600"}`}
            >
              部位在庫が無いものだけ
            </Link>
          </div>
        </Card>

        {rows.length ? (
          <Card>
            <ul className="divide-y divide-stone-100">
              {rows.map((r) => {
                const label = String(r.label_id ?? "");
                const hasInventory = withInventory.has(label);
                return (
                  <li key={String(r.id)} className="py-2">
                    <Link
                      href={`/gibier/individuals/${encodeURIComponent(label)}`}
                      className="flex flex-wrap items-center gap-2 text-sm"
                    >
                      <code className="font-semibold text-green-700">{label || "（番号なし）"}</code>
                      {r.serial_number ? (
                        <span className="text-xs text-stone-400">No.{String(r.serial_number)}</span>
                      ) : null}
                      <span>{String(r.species ?? "")}</span>
                      {r.capture_date ? (
                        <span className="text-xs text-stone-400">{String(r.capture_date)}</span>
                      ) : null}
                      {r.hunter_name ? (
                        <span className="text-xs text-stone-500">{String(r.hunter_name)}</span>
                      ) : null}
                      {r.quality === "食用不可" ? <Badge color="red">食用不可</Badge> : null}
                      {r.intake_status ? (
                        <Badge color="gray">{String(r.intake_status)}</Badge>
                      ) : null}
                      {hasInventory ? (
                        <Badge color="green">解体済み</Badge>
                      ) : (
                        <span className="text-xs text-stone-400">部位在庫なし</span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-stone-400">
              最新{PAGE_SIZE}頭を表示しています。古い個体は検索してください。
            </p>
          </Card>
        ) : (
          <EmptyState message="該当する個体がありません。検索条件を変えてください。" />
        )}
      </div>
    </>
  );
}
