import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@supabase/supabase-js";
import { env, isSupabaseConfigured } from "@/lib/env";
import { questProgress } from "@/domain/satoyama/quest-service";
import { ACHIEVEMENTS } from "@/domain/satoyama/achievements";
import { SupportForm } from "./support-form";

export const dynamic = "force-dynamic";

/**
 * 公開の応援ページ（ログイン不要）。
 * v_public_quests のみを参照するため、希少種クエスト（restricted）は
 * 構造的にここへ出てこない。位置情報も一切表示しない。
 */

type Row = Record<string, unknown>;

function serviceClient() {
  if (!isSupabaseConfigured() || !env.supabaseServiceRoleKey) return null;
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
}

async function fetchQuest(slug: string) {
  const supabase = serviceClient();
  if (!supabase) return null;
  const { data } = await supabase
    .from("v_public_quests")
    .select("*")
    .eq("public_slug", slug)
    .maybeSingle();
  return data;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const quest = await fetchQuest(slug);
  return {
    title: quest ? `${quest.title as string}｜里山の調査を応援する` : "里山の調査を応援する",
    description: (quest?.story as string) ?? "館山・南房総の里山調査を応援できます。",
  };
}

export default async function SupportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const quest = await fetchQuest(slug);
  if (!quest) notFound();

  const supabase = serviceClient();
  const [{ data: pledges }, { data: org }] = await Promise.all([
    supabase!
      .from("support_pledges")
      .select("amount_yen, message, message_public, created_at, supporters(display_name, is_public)")
      .eq("task_id", quest.id)
      .eq("status", "confirmed")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase!.from("org_settings").select("key, value").eq("key", "org_bank_info").maybeSingle(),
  ]);

  const p = questProgress(quest as Row);
  const pledgeRows = (pledges ?? []) as Row[];
  const supporterAchievements = ACHIEVEMENTS.filter((a) => a.audience === "supporter");

  return (
    <div className="mx-auto max-w-2xl p-4">
      <header className="mb-4 text-center">
        <p className="text-xs font-semibold text-green-800">館山・南房総の里山調査</p>
        <h1 className="mt-1 text-2xl font-bold text-green-900">{quest.title as string}</h1>
        <p className="mt-1 text-sm text-stone-500">
          {(quest.taxon_group as string) ?? ""}
          {quest.season ? ` ・${quest.season as string}` : ""}
        </p>
      </header>

      {/* 進捗メーター */}
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="mb-1 flex items-end justify-between">
          <span className="text-sm font-semibold">調査の進みぐあい</span>
          <span className="text-2xl font-bold text-green-800">{p.percent}%</span>
        </div>
        <div className="h-3 w-full overflow-hidden rounded-full bg-stone-100">
          <div className="h-3 rounded-full bg-green-600 transition-all" style={{ width: `${p.percent}%` }} />
        </div>
        <p className="mt-1 text-xs text-stone-500">
          目標 {p.targetCount}件のうち {p.progressCount}件が完了
          {p.completed ? " 🏅 達成しました！" : ""}
        </p>

        {p.fundingGoalYen > 0 ? (
          <>
            <div className="mb-1 mt-4 flex items-end justify-between">
              <span className="text-sm font-semibold">集まった応援</span>
              <span className="text-lg font-bold text-amber-700">
                ¥{p.fundedYen.toLocaleString()}
                <span className="ml-1 text-xs font-normal text-stone-500">
                  / ¥{p.fundingGoalYen.toLocaleString()}
                </span>
              </span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-stone-100">
              <div
                className="h-3 rounded-full bg-amber-400 transition-all"
                style={{ width: `${p.fundedPercent}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-stone-500">
              うち ¥{p.paidOutYen.toLocaleString()} が、地域の調査員への謝金・交通費として支払われました。
            </p>
          </>
        ) : null}
      </div>

      {quest.story ? (
        <section className="mt-4 rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="mb-1 text-sm font-bold text-green-900">なぜこの調査が必要か</h2>
          <p className="whitespace-pre-wrap text-sm text-stone-700">{quest.story as string}</p>
        </section>
      ) : null}

      <section className="mt-4 rounded-xl border border-stone-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-bold text-green-900">あなたの応援は、こう使われます</h2>
        <ol className="ml-4 list-decimal space-y-1 text-sm text-stone-700">
          <li>応援金は、この調査の謝金・交通費・機材にあてられます</li>
          <li>調査するのは地域の猟師・調査員です（＝里山の仕事になります）</li>
          <li>集まった記録は保全の判断材料になり、進捗はこのページで公開されます</li>
          <li>支払った金額と使いみちは、すべて記録・公開されます</li>
        </ol>
        <p className="mt-2 text-xs text-stone-500">
          ※ 希少種の生息地や罠の位置など、公開すると保全に悪影響がある情報は、
          応援者にも公開されません（地域の生きものを守るためです）。
        </p>
      </section>

      <section className="mt-4 rounded-xl border border-green-600 bg-green-50 p-4">
        <h2 className="mb-2 text-base font-bold text-green-900">この調査を応援する</h2>
        <SupportForm slug={slug} bankInfo={(org?.value as string) ?? ""} />
      </section>

      {pledgeRows.length ? (
        <section className="mt-4 rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-bold text-green-900">
            応援してくれた方（{pledgeRows.length}人）
          </h2>
          <ul className="space-y-2 text-sm">
            {pledgeRows.map((pledge, i) => {
              const supporter = pledge.supporters as Row | null;
              const name = supporter?.is_public
                ? ((supporter?.display_name as string) ?? "匿名の応援者")
                : "匿名の応援者";
              return (
                <li key={i} className="border-b border-stone-100 pb-2">
                  <span className="font-medium">{name}</span>
                  <span className="ml-2 text-xs text-stone-400">
                    ¥{Number(pledge.amount_yen).toLocaleString()}
                  </span>
                  {pledge.message_public && pledge.message ? (
                    <p className="mt-0.5 text-stone-600">「{pledge.message as string}」</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="mt-4 rounded-xl border border-stone-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-bold text-green-900">応援者の称号</h2>
        <div className="flex flex-wrap gap-2">
          {supporterAchievements.map((a) => (
            <span
              key={a.key}
              className="rounded-xl border border-stone-200 px-3 py-2 text-sm text-stone-600"
              title={a.description}
            >
              {a.icon} {a.name}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-stone-400">
          金額の大きさではなく、関わりの継続と成果で贈られます。
        </p>
      </section>

      <footer className="mt-8 text-center text-xs text-stone-400">
        合同会社アルコ（千葉県館山市）・里山OS
      </footer>
    </div>
  );
}
