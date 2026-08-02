import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * ① Social Inbox 一覧。
 * スマホ優先（375px幅で横スクロールなし）。状態は記号＋文字で示す。
 */
export default async function CrosspostPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="FB横展開" description="Facebook投稿を各媒体の下書きにします" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const [{ data: sources }, { data: drafts }] = await Promise.all([
    supabase
      .from("social_sources")
      .select("id, title, source_no, body, posted_on, category, status, created_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("social_channel_drafts").select("social_source_id, status").limit(500),
  ]);

  const bySource = new Map<string, { total: number; approved: number; review: number; published: number }>();
  for (const draft of drafts ?? []) {
    const key = String(draft.social_source_id);
    const entry = bySource.get(key) ?? { total: 0, approved: 0, review: 0, published: 0 };
    entry.total++;
    if (draft.status === "approved" || draft.status === "queued") entry.approved++;
    if (draft.status === "needs_review") entry.review++;
    if (draft.status === "published") entry.published++;
    bySource.set(key, entry);
  }

  return (
    <>
      <PageHeader
        title="FB横展開"
        description="Facebookの投稿を登録すると、媒体別の下書きを作ります。公開する前に必ず人が確認します。"
      />

      <div className="space-y-4">
        <Link
          href="/crosspost/new"
          className="flex min-h-[56px] w-full items-center justify-center rounded-xl bg-green-700 px-4 text-base font-bold text-white"
        >
          ＋ 新しい投稿を登録する
        </Link>

        {!sources?.length ? (
          <EmptyState message="まだ登録がありません。Facebookの投稿を登録してください。" />
        ) : (
          <div className="space-y-3">
            {sources.map((source) => {
              const progress = bySource.get(String(source.id));
              return (
                <Card key={source.id}>
                  <Link href={`/crosspost/${source.id}`} className="block">
                    <p className="text-base font-bold text-stone-800">
                      {source.title || `${String(source.body).slice(0, 30)}…`}
                    </p>
                    <p className="mt-1 text-sm text-stone-500">
                      {source.posted_on ?? "投稿日なし"}
                      {source.source_no ? ` ／ #${source.source_no}` : ""}
                      {source.category ? ` ／ ${source.category}` : ""}
                    </p>
                    <p className="mt-2 text-base text-stone-700">
                      {progress ? (
                        <>
                          <span aria-hidden="true">●</span> 下書き {progress.total}件
                          {progress.review > 0 ? (
                            <>
                              {" ／ "}
                              <span aria-hidden="true">！</span> 要確認 {progress.review}件
                            </>
                          ) : null}
                          {progress.approved > 0 ? (
                            <>
                              {" ／ "}
                              <span aria-hidden="true">✓</span> 承認 {progress.approved}件
                            </>
                          ) : null}
                          {progress.published > 0 ? (
                            <>
                              {" ／ "}
                              <span aria-hidden="true">✔</span> 投稿済み {progress.published}件
                            </>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <span aria-hidden="true">－</span> まだ下書きを作っていません
                        </>
                      )}
                    </p>
                  </Link>
                </Card>
              );
            })}
          </div>
        )}

        <Link
          href="/crosspost/settings"
          className="flex min-h-[56px] w-full items-center justify-center rounded-xl border-2 border-stone-400 px-4 text-base font-bold text-stone-700"
        >
          ⚙ 媒体とスタイルの設定
        </Link>
      </div>
    </>
  );
}
