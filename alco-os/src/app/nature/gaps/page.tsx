import Link from "next/link";
import { isSupabaseConfigured, env } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { Card, CardTitle, PageHeader, SetupNotice, Badge } from "@/components/ui";
import { calculateGaps, suggestTasks, SEASON_LABELS, SEASONS } from "@/domain/satoyama/knowledge-gap";
import { questProgress } from "@/domain/satoyama/quest-service";
import { summarizeSupport, SUPPORT_METHODS } from "@/domain/satoyama/funding-service";
import {
  communityLevel,
  evaluateObserverAchievements,
  ACHIEVEMENT_BY_KEY,
  ACHIEVEMENTS,
} from "@/domain/satoyama/achievements";
import {
  NewQuestForm,
  PublishQuestButton,
  ProgressButton,
  PledgeActions,
  PayoutForm,
  CopyLinkButton,
} from "./quest-forms";

export const dynamic = "force-dynamic";

/**
 * クエストボード（里山OS S07 + ゲーミフィケーション）。
 *
 * 循環: 応援 → 資金 → 調査（地域の仕事）→ 成果 → 応援
 * 表示方針（設計書10章）: 個人ランキングは出さず、地域レベルと共同達成を前面に。
 */

type Row = Record<string, unknown>;

export default async function QuestBoardPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="クエストボード" />
        <SetupNotice />
      </>
    );
  }
  const supabase = await createSupabaseServerClient();
  await getCurrentUser(supabase);

  const [
    { data: observations },
    { data: taxa },
    { data: quests },
    { data: pledges },
    { data: payouts },
    { data: sites },
  ] = await Promise.all([
    supabase
      .from("biodiversity_observations")
      .select("id, site_id, taxon_group, observed_at, review_status, evidence_type")
      .limit(2000),
    supabase.from("taxa").select("taxon_group, sensitivity").is("deleted_at", null).limit(500),
    supabase
      .from("survey_tasks")
      .select("*")
      .is("deleted_at", null)
      .order("status")
      .order("priority", { ascending: false })
      .limit(100),
    supabase
      .from("support_pledges")
      .select("*, supporters(display_name, is_public)")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("quest_payouts").select("*").order("paid_on", { ascending: false }).limit(200),
    supabase.from("sites").select("id, name").is("deleted_at", null).order("name"),
  ]);

  const observationRows = (observations ?? []) as Row[];
  const questRows = (quests ?? []) as Row[];
  const pledgeRows = (pledges ?? []) as Row[];
  const payoutRows = (payouts ?? []) as Row[];

  const summary = calculateGaps(observationRows);
  const sensitiveGroups = [
    ...new Set(
      ((taxa ?? []) as Row[])
        .filter((t) => t.sensitivity === "sensitive")
        .map((t) => (t.taxon_group as string) || "未分類"),
    ),
  ];
  const suggested = suggestTasks(summary, { sensitiveGroups, limit: 8 });
  const support = summarizeSupport(pledgeRows, payoutRows);
  const level = communityLevel({
    approvedObservations: observationRows.filter((o) => o.review_status === "approved").length,
    filledCells: summary.cells.filter((c) => c.missing === 0).length,
    completedQuests: questRows.filter((q) => q.status === "done").length,
  });
  const earnedKeys = evaluateObserverAchievements(observationRows);
  const groups = [...new Set(summary.cells.map((c) => c.taxonGroup))];
  const baseUrl = env.siteUrl || "https://alco-os.vercel.app";

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
        title="クエストボード"
        description="足りない調査をクエストにして、応援を力に変える。応援は地域の調査の仕事になります。"
      />
      <div className="space-y-4">
        {/* 地域レベル（共同達成を前面に） */}
        <Card className="border-green-300 bg-green-50">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-green-800">里山レベル {level.level}</p>
              <p className="text-xl font-bold text-green-900">{level.title}</p>
            </div>
            <div className="text-right text-xs text-green-800">
              <p>承認済み記録 {observationRows.filter((o) => o.review_status === "approved").length}件</p>
              <p>達成クエスト {questRows.filter((q) => q.status === "done").length}件</p>
            </div>
          </div>
          <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-white">
            <div
              className="h-3 rounded-full bg-green-600 transition-all"
              style={{ width: `${level.progressPercent}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-green-800">
            次のレベルまで {level.progressPercent}% ・みんなの記録と応援で上がります（個人の順位はつけません）
          </p>
        </Card>

        {/* 応援の循環 */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Card>
            <CardTitle>応援してくれた人</CardTitle>
            <p className="text-2xl font-bold">{support.supporterCount}人</p>
          </Card>
          <Card>
            <CardTitle>集まった応援</CardTitle>
            <p className="text-2xl font-bold">¥{support.totalFunded.toLocaleString()}</p>
          </Card>
          <Card>
            <CardTitle>地域に回った額</CardTitle>
            <p className="text-2xl font-bold">¥{support.totalPaidOut.toLocaleString()}</p>
            <p className="text-xs text-stone-400">調査員への謝金・交通費</p>
          </Card>
          <Card>
            <CardTitle>循環率</CardTitle>
            <p className="text-2xl font-bold">{support.circulationRate}%</p>
            <p className="text-xs text-stone-400">応援が仕事に変わった割合</p>
          </Card>
        </div>

        <NewQuestForm
          sites={((sites ?? []) as Row[]).map((s) => ({
            id: s.id as string,
            name: s.name as string,
          }))}
          presets={suggested.map((t) => ({
            title: t.title,
            taxonGroup: t.taxonGroup,
            season: t.season,
            missing: Number(t.title.match(/あと(\d+)件/)?.[1] ?? 3),
          }))}
        />

        {/* クエスト一覧 */}
        <Card>
          <CardTitle>進行中のクエスト</CardTitle>
          {questRows.length ? (
            <ul className="space-y-3">
              {questRows.map((quest) => {
                const p = questProgress(quest);
                const questPledges = pledgeRows.filter(
                  (pl) => pl.task_id === quest.id && pl.status === "confirmed",
                );
                const url = quest.public_slug ? `${baseUrl}/support/${quest.public_slug}` : "";
                return (
                  <li key={quest.id as string} className="rounded-xl border border-stone-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold">
                          {p.completed ? "🏅 " : "🎯 "}
                          {quest.title as string}
                        </p>
                        <p className="text-xs text-stone-400">
                          {(quest.taxon_group as string) ?? "分類群未指定"}
                          {quest.season ? ` ・${SEASON_LABELS[quest.season as keyof typeof SEASON_LABELS] ?? quest.season}` : ""}
                          {quest.reward_title ? ` ・称号「${quest.reward_title as string}」` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <PublishQuestButton
                          questId={quest.id as string}
                          published={Boolean(quest.published_at)}
                          restricted={Boolean(quest.restricted)}
                        />
                        {url ? <CopyLinkButton url={url} /> : null}
                      </div>
                    </div>

                    {/* 調査の進捗 */}
                    <div className="mt-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-stone-600">
                          調査 {p.progressCount}/{p.targetCount}件
                        </span>
                        <span className="text-stone-400">{p.percent}%</span>
                      </div>
                      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-stone-100">
                        <div
                          className={`h-2 rounded-full ${p.completed ? "bg-green-600" : "bg-green-400"}`}
                          style={{ width: `${p.percent}%` }}
                        />
                      </div>
                    </div>

                    {/* 応援の集まり */}
                    {p.fundingGoalYen > 0 ? (
                      <div className="mt-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-stone-600">
                            応援 ¥{p.fundedYen.toLocaleString()} / ¥{p.fundingGoalYen.toLocaleString()}
                            <span className="ml-1 text-stone-400">（{questPledges.length}人）</span>
                          </span>
                          <span className="text-stone-400">{p.fundedPercent}%</span>
                        </div>
                        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-stone-100">
                          <div
                            className="h-2 rounded-full bg-amber-400"
                            style={{ width: `${p.fundedPercent}%` }}
                          />
                        </div>
                      </div>
                    ) : null}

                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <ProgressButton
                        questId={quest.id as string}
                        progressCount={p.progressCount}
                      />
                      <span className="text-stone-400">
                        支払済 ¥{p.paidOutYen.toLocaleString()} / 残り ¥{p.availableYen.toLocaleString()}
                      </span>
                    </div>
                    <PayoutForm questId={quest.id as string} availableYen={p.availableYen} />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-stone-400">
              クエストはまだありません。下のギャップ表を見て、足りない調査からつくってみてください。
            </p>
          )}
        </Card>

        {/* 応援の受付状況 */}
        <Card>
          <CardTitle>応援の受付（入金確認）</CardTitle>
          {pledgeRows.length ? (
            <ul className="divide-y divide-stone-100 text-sm">
              {pledgeRows.slice(0, 20).map((pledge) => {
                const supporter = pledge.supporters as Row | null;
                const quest = questRows.find((q) => q.id === pledge.task_id);
                return (
                  <li key={pledge.id as string} className="flex flex-wrap items-center gap-2 py-2">
                    <Badge
                      color={
                        pledge.status === "confirmed"
                          ? "green"
                          : pledge.status === "pledged"
                            ? "amber"
                            : "gray"
                      }
                    >
                      ¥{Number(pledge.amount_yen).toLocaleString()}
                    </Badge>
                    <span>
                      {(supporter?.display_name as string) ?? "匿名の応援者"}
                      <span className="ml-1 text-xs text-stone-400">
                        {SUPPORT_METHODS[pledge.method as keyof typeof SUPPORT_METHODS] ??
                          (pledge.method as string)}
                        {quest ? ` ・${quest.title as string}` : " ・里山全体"}
                      </span>
                    </span>
                    {pledge.message ? (
                      <span className="text-xs text-stone-500">「{pledge.message as string}」</span>
                    ) : null}
                    <PledgeActions
                      pledgeId={pledge.id as string}
                      status={pledge.status as string}
                    />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-stone-400">
              まだ応援はありません。クエストを公開して、応援リンクをSNSや知人に共有してみてください。
            </p>
          )}
        </Card>

        {/* ギャップ表 */}
        <Card>
          <CardTitle>調査ギャップ（分類群 × 季節）</CardTitle>
          <div className="mb-2 flex flex-wrap gap-3 text-xs text-stone-500">
            <span>季節カバー率 {summary.seasonCoverage}%</span>
            <span>レビュー完了 {summary.reviewCompletion}%</span>
            <span>証拠カバー {summary.evidenceCoverage}%</span>
            <span>生態系理解度: — （100%を置きません）</span>
          </div>
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

        {/* 称号 */}
        <Card>
          <CardTitle>称号（数の競争はしません）</CardTitle>
          <div className="flex flex-wrap gap-2">
            {ACHIEVEMENTS.filter((a) => a.audience !== "supporter").map((a) => {
              const earned = earnedKeys.includes(a.key);
              return (
                <span
                  key={a.key}
                  title={a.description}
                  className={`rounded-xl border px-3 py-2 text-sm ${
                    earned
                      ? "border-green-600 bg-green-50 font-semibold text-green-800"
                      : "border-stone-200 text-stone-400"
                  }`}
                >
                  {earned ? a.icon : "🔒"} {a.name}
                </span>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-stone-400">
            投稿数の多さでは付きません。季節をまたぐ継続、証拠の多様性、レビュー承認率で評価します。
            希少種の発見は称号の対象にしません（乱獲・位置暴露を招かないため）。
            応援者向けの称号（{ACHIEVEMENT_BY_KEY.get("first_supporter")?.name} 等）は応援ページで表示します。
          </p>
        </Card>
      </div>
    </>
  );
}
