import Link from "next/link";
import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { canApprove } from "@/lib/auth";
import { Card, CardTitle, PageHeader, SetupNotice, Badge } from "@/components/ui";
import { maskObservationPoint } from "@/domain/satoyama/geo-masking";
import { buildIndividualTrace, ISSUE_LABELS, type Row } from "@/domain/gibier/individual-trace";

export const dynamic = "force-dynamic";

/**
 * 個体トレース 詳細（読み取り専用）。
 *
 * 1頭の一生を時系列で1画面に出す:
 *   LINEの捕獲報告 → 個体台帳 → 部位在庫 → 受注 → 買取
 *
 * **書き込みは一切しない。** 既存テーブルの構造も変えない。
 * 捕獲地点は docs/10 で sensitive 相当のため、必ず maskObservationPoint() を通す。
 */

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-stone-400">{label}</p>
      <p className="text-sm font-medium">{value ?? "—"}</p>
    </div>
  );
}

export default async function IndividualTracePage({
  params,
}: {
  params: Promise<{ labelId: string }>;
}) {
  const { labelId: rawLabelId } = await params;
  const labelId = decodeURIComponent(rawLabelId);

  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="個体トレース" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: individual } = await supabase
    .from("individuals")
    .select("*")
    .eq("label_id", labelId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!individual) notFound();

  const [{ data: inventory }, { data: reports }, canSeeExact] = await Promise.all([
    supabase
      .from("inventory")
      .select(
        "id, ident_code, individual_id, individual_code, part_name, weight, weight_kg, status, grade, unit_price, tier, parent_inventory_id, processed_at",
      )
      .or(`individual_id.eq.${labelId},individual_code.eq.${labelId}`)
      .is("deleted_at", null)
      .order("ident_code"),
    supabase
      .from("capture_reports")
      .select("id, status, created_at, species, capture_method, raw_text")
      .eq("individual_id", individual.id)
      .limit(1),
    canApprove(supabase),
  ]);

  const inventoryRows = (inventory ?? []) as Row[];
  const inventoryIds = inventoryRows.map((r) => String(r.id));

  // 受注（order_items.inventory_id 経由）
  let orderItems: Row[] = [];
  let orders: Row[] = [];
  if (inventoryIds.length) {
    const { data: items } = await supabase
      .from("order_items")
      .select("id, order_id, inventory_id, part_name, weight_kg, subtotal")
      .in("inventory_id", inventoryIds);
    orderItems = (items ?? []) as Row[];
    const orderIds = [...new Set(orderItems.map((i) => String(i.order_id)))];
    if (orderIds.length) {
      const { data: o } = await supabase
        .from("orders")
        .select("id, order_code, customer_name, order_date, status, total_amount")
        .in("id", orderIds);
      orders = (o ?? []) as Row[];
    }
  }

  const trace = buildIndividualTrace({
    individual: individual as Row,
    inventory: inventoryRows,
    captureReport: ((reports ?? []) as Row[])[0] ?? null,
    orderItems,
    orders,
  });

  // 捕獲地点は業務権限（owner/manager）のみ原座標。それ以外はマスク
  const point = maskObservationPoint(
    { lat: trace.lat, lng: trace.lng, sensitivity: "sensitive" },
    canSeeExact ? "restricted" : "members",
  );

  return (
    <>
      <PageHeader
        title={`${trace.labelId}`}
        description={`${trace.species ?? ""} ${trace.captureDate ?? ""}　表示のみ（データは変更しません）`}
      />
      <div className="space-y-4">
        <Link href="/gibier/individuals" className="text-sm text-green-700 underline">
          ← 個体トレース一覧
        </Link>

        {trace.issues.length ? (
          <Card className="border-amber-300 bg-amber-50">
            <CardTitle>要確認</CardTitle>
            <ul className="space-y-1 text-sm text-amber-900">
              {trace.issues.map((issue, i) => (
                <li key={i}>
                  <Badge color="amber">{ISSUE_LABELS[issue.kind]}</Badge>{" "}
                  {issue.detail}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-800">
              この画面では直しません。内容を確認して、対応を決めてください。
            </p>
          </Card>
        ) : null}

        {/* ① 捕獲 */}
        <Card>
          <CardTitle>① 捕獲</CardTitle>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field label="個体番号" value={<code>{trace.labelId}</code>} />
            <Field label="通し番号" value={trace.serialNumber ?? "—"} />
            <Field label="獣種" value={trace.species} />
            <Field label="捕獲日" value={trace.captureDate} />
            <Field label="捕獲者" value={trace.hunterName} />
            <Field label="体重" value={trace.weightTotal ? `${trace.weightTotal}kg` : "—"} />
            <Field
              label="捕獲地点"
              value={
                point.hidden
                  ? "非公開"
                  : point.lat !== null
                    ? `${point.lat.toFixed(4)}, ${point.lng?.toFixed(4)}（${point.precisionLabel}）`
                    : "記録なし"
              }
            />
            <Field label="放射能検査" value={trace.radiationResult} />
          </div>
          {trace.captureReport ? (
            <p className="mt-2 text-sm">
              <Badge color="green">LINEの捕獲報告あり</Badge>{" "}
              <Link href="/gibier/reports" className="text-green-700 underline">
                捕獲報告を見る
              </Link>
              <span className="ml-2 text-xs text-stone-400">
                {trace.captureReport.createdAt?.slice(0, 10)} ・ {trace.captureReport.status}
              </span>
            </p>
          ) : (
            <p className="mt-2 text-xs text-stone-400">
              LINEからの捕獲報告は紐づいていません（現場アプリからの登録）。
            </p>
          )}
        </Card>

        {/* ② 受入・処理 */}
        <Card>
          <CardTitle>② 受入・処理</CardTitle>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field
              label="受入状態"
              value={trace.intakeStatus ? <Badge color="gray">{trace.intakeStatus}</Badge> : "—"}
            />
            <Field
              label="食用可否"
              value={
                trace.quality === "食用不可" ? (
                  <Badge color="red">食用不可</Badge>
                ) : (
                  (trace.quality ?? "—")
                )
              }
            />
            <Field label="肉ランク" value={trace.meatRank} />
            <Field
              label="歩留まり（台帳）"
              value={trace.yieldRate !== null ? `${trace.yieldRate}` : "—"}
            />
          </div>
        </Card>

        {/* ③ 部位在庫 */}
        <Card>
          <CardTitle>③ 部位在庫（{trace.parts.length}件）</CardTitle>
          {trace.parts.length ? (
            <>
              <div className="mb-2 flex flex-wrap gap-4 text-sm">
                <span>
                  部位重量の合計 <strong>{trace.partsWeightKg}kg</strong>
                </span>
                {trace.calculatedYieldPercent !== null ? (
                  <span>
                    実データの歩留まり <strong>{trace.calculatedYieldPercent}%</strong>
                    <span className="ml-1 text-xs text-stone-400">（体重比）</span>
                  </span>
                ) : null}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-400">
                      <th className="py-1 pr-2">識別コード</th>
                      <th className="py-1 pr-2">部位</th>
                      <th className="py-1 pr-2">重量</th>
                      <th className="py-1 pr-2">状態</th>
                      <th className="py-1 pr-2">販売</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trace.parts.map((p, i) => (
                      <tr key={i} className="border-t border-stone-100">
                        <td className="py-1 pr-2">
                          <code className="text-xs">{p.identCode ?? "—"}</code>
                          {(p.tier ?? 1) > 1 ? (
                            <span className="ml-1 text-xs text-stone-400">小分け</span>
                          ) : null}
                        </td>
                        <td className="py-1 pr-2">{p.partName ?? "—"}</td>
                        <td className="py-1 pr-2">{p.weightKg ? `${p.weightKg}kg` : "—"}</td>
                        <td className="py-1 pr-2">
                          {p.status ? <Badge color="gray">{p.status}</Badge> : "—"}
                        </td>
                        <td className="py-1 pr-2">
                          {p.soldOrderCodes.length ? (
                            <span className="text-green-700">{p.soldOrderCodes.join(", ")}</span>
                          ) : (
                            <span className="text-xs text-stone-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-sm text-stone-400">
              部位在庫が登録されていません（未解体、または登録漏れ）。
            </p>
          )}
        </Card>

        {/* ④ 受注・販売 */}
        <Card>
          <CardTitle>④ 受注・販売</CardTitle>
          {orders.length ? (
            <ul className="divide-y divide-stone-100 text-sm">
              {orders.map((o) => (
                <li key={String(o.id)} className="flex flex-wrap items-center gap-2 py-2">
                  <code className="font-semibold">{String(o.order_code ?? "")}</code>
                  <span>{String(o.customer_name ?? "")}</span>
                  <span className="text-xs text-stone-400">{String(o.order_date ?? "")}</span>
                  <Badge color="gray">{String(o.status ?? "")}</Badge>
                  {o.total_amount ? (
                    <span className="text-xs">¥{Number(o.total_amount).toLocaleString()}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-400">
              この個体の部位が使われた注文はまだありません。
            </p>
          )}
        </Card>

        {/* ⑤ 買取（捕獲者への支払い） */}
        <Card>
          <CardTitle>⑤ 買取（捕獲者への支払い）</CardTitle>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field
              label="買取金額（台帳）"
              value={
                trace.buybackAmount !== null
                  ? `¥${trace.buybackAmount.toLocaleString()}`
                  : "—"
              }
            />
            <Field label="支払先" value={(individual as Row).purchase_payee as string} />
          </div>
          <p className="mt-2 text-xs text-stone-400">
            「いつ・実際に支払ったか」の記録はまだシステムにありません（支払台帳は次の段階で追加予定）。
          </p>
        </Card>

        <p className="text-xs text-stone-400">
          この画面は表示専用です。個体台帳の編集は既存のジビエ基幹アプリから行ってください。
        </p>
      </div>
    </>
  );
}
