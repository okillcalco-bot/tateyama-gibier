import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { Card, CardTitle, PageHeader, SetupNotice, Badge } from "@/components/ui";
import { calculateGaps, suggestTasks, SEASON_LABELS, SEASONS } from "@/domain/satoyama/knowledge-gap";

export const dynamic = "force-dynamic";

/**
 * 調査ギャップ・知識進捗（里山OS S07・9章）。
 *
 * - 有限の調査（分類群×季節の必要件数）は 0〜100% で表示する
 * - 「生態系理解度」には100%を置かない（未知として表示する）
 * - 希少種を含む分類群のタスクは restricted 表示にし、一般募集にしない
 */

type Row = Record<string, unknown>;

export default async function KnowledgeGapPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="調査ギャップ" />
        <SetupNotice />
      </>
    );
  }
  const supabase = await createSupabaseServerClient();
  await getCurrentUser(supabase);

  const [{ data: observations }, { data: taxa }] = await Promise.all([
    supabase
      .from("biodiversity_observations")
      .select("id, taxon_group, observed_at, review_status, evidence_type")
      .limit(2000),
    supabase.from("taxa").select("taxon_group, sensitivity").is("deleted_at", null).limit(500),
  ]);

  const rows = (observations ?? []) as Row[];
  const summary = calculateGaps(rows);
  const sensitiveGroups = [
    ...new Set(
      ((taxa ?? []) as Row[])
        .filter((t) => t.sensitivity === "sensitive")
        .map((t) => (t.taxon_group as string) || "未分類"),
    ),
  ];
  const tasks = suggestTasks(summary, { sensitiveGroups, limit: 12 });
  const groups = [...new Set(summary.cells.map((c) => c.taxonGroup))];

  const cellColor = (coverage: number) =>
    coverage >= 100
      ? "bg-green-600 text-white"
      : coverage >= 50
        ? "bg-green-200"
        : coverage > 0
          ? "bg-amber-100"
          : "bg-stone-100 text-stone-400";

  return (
    <>
      <PageHeader
        title="調査ギャップ・進捗"
        description="いま何が分かっていて、何がまだ分かっていないか。埋めるべき調査を有限のタスクにします。"
      />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Card>
            <CardTitle>季節カバー率</CardTitle>
            <p className="text-2xl font-bold">{summary.seasonCoverage}%</p>
            <p className="text-xs text-stone-400">必要件数を満たしたマスの割合</p>
          </Card>
          <Card>
            <CardTitle>レビュー完了率</CardTitle>
            <p className="text-2xl font-bold">{summary.reviewCompletion}%</p>
          </Card>
          <Card>
            <CardTitle>証拠カバー率</CardTitle>
            <p className="text-2xl font-bold">{summary.evidenceCoverage}%</p>
            <p className="text-xs text-stone-400">写真・音声・標本などの直接証拠</p>
          </Card>
          <Card>
            <CardTitle>生態系理解度</CardTitle>
            <p className="text-2xl font-bold">—</p>
            <p className="text-xs text-stone-400">
              100%を置きません。分かっていないことを数えるための指標です
            </p>
          </Card>
        </div>

        <Card>
          <CardTitle>分類群 × 季節（記録{summary.totalObserved}件）</CardTitle>
          {groups.length ? (
            <div className="overflow-x-auto">
              <table className="text-sm">
                <thead>
                  <tr>
                    <th className="px-2 py-1 text-left text-xs font-medium">分類群</th>
                    {SEASONS.map((s) => (
                      <th key={s} className="min-w-24 px-2 py-1 text-xs font-medium">
                        {SEASON_LABELS[s]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <tr key={group} className="border-t border-stone-100">
                      <td className="whitespace-nowrap px-2 py-1 font-medium">{group}</td>
                      {SEASONS.map((season) => {
                        const cell = summary.cells.find(
                          (c) => c.taxonGroup === group && c.season === season,
                        );
                        if (!cell) return <td key={season} />;
                        return (
                          <td key={season} className="px-1 py-1 text-center">
                            <span
                              className={`inline-block min-w-20 rounded px-2 py-1 text-xs font-semibold ${cellColor(cell.coverage)}`}
                              title={`${cell.observed}/${cell.required}件・承認${cell.approved}件`}
                            >
                              {cell.observed}/{cell.required}
                              {cell.coverage >= 100 ? " ✓" : ""}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-stone-400">
              まだ記録がありません。
              <Link href="/nature/quick" className="ml-1 text-green-700 underline">
                かんたん投稿から始める
              </Link>
            </p>
          )}
        </Card>

        <Card>
          <CardTitle>次にやる調査（不足の大きい順）</CardTitle>
          {tasks.length ? (
            <ul className="divide-y divide-stone-100 text-sm">
              {tasks.map((task, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 py-2">
                  <Badge color={task.priority >= 70 ? "amber" : "gray"}>優先{task.priority}</Badge>
                  <span className={task.restricted ? "text-stone-400" : ""}>
                    {task.restricted ? "🔒 " : ""}
                    {task.title}
                  </span>
                  <span className="text-xs text-stone-400">{task.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-stone-400">
              現在の必要件数は満たしています。必要件数の設定を見直すか、次の季節に備えてください。
            </p>
          )}
          <p className="mt-2 text-xs text-stone-400">
            🔒 は希少種を含む分類群です。一般募集はせず、認定した調査者にだけ依頼してください。
            これはルールベースの提案です（AIによるタスク生成は承認後に公開する設計 — docs/10）。
          </p>
        </Card>
      </div>
    </>
  );
}
