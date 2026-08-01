import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser, canApprove } from "@/lib/auth";
import { Card, PageHeader, SetupNotice, EmptyState } from "@/components/ui";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getActiveStyle, FALLBACK_STYLE } from "@/domain/social/crosspost/style-service";
import { ChannelToggleForm, StyleForm } from "../crosspost-forms";

export const dynamic = "force-dynamic";

/** ⑧ 媒体設定 ＋ ⑨ 沖浩志スタイル設定 */
export default async function CrosspostSettingsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="媒体とスタイルの設定" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) {
    return (
      <>
        <PageHeader title="媒体とスタイルの設定" />
        <Card>
          <p className="text-base">ログインが必要です。</p>
        </Card>
      </>
    );
  }
  const approver = await canApprove(supabase);

  const [{ data: channels }, style] = await Promise.all([
    supabase
      .from("social_channels")
      .select("id, channel_key, label, enabled, max_chars, max_hashtags, cta_policy, guidance")
      .order("sort_order"),
    getActiveStyle(new SupabaseDb(supabase), user.organizationId),
  ]);

  const active = style ?? { id: "", ...FALLBACK_STYLE };

  return (
    <>
      <PageHeader title="媒体とスタイルの設定" description="どの媒体に出すか、どんな書き方にするか" />

      <div className="space-y-5">
        <section>
          <h2 className="mb-2 text-lg font-bold text-stone-800">媒体</h2>
          {!channels?.length ? (
            <EmptyState message="媒体がまだ登録されていません（0029の適用後に表示されます）。" />
          ) : (
            <div className="space-y-3">
              {channels.map((channel) => (
                <Card key={channel.id}>
                  <p className="text-base font-bold text-stone-800">
                    <span aria-hidden="true">{channel.enabled ? "✓" : "－"}</span> {channel.label}
                    ：{channel.enabled ? "使う" : "使わない"}
                  </p>
                  <p className="mt-1 text-sm text-stone-500">
                    文字数の目安 {channel.max_chars ?? "指定なし"}字 ／ ハッシュタグ最大{" "}
                    {channel.max_hashtags ?? 0}個
                  </p>
                  <p className="mt-1 break-words text-base text-stone-700">{channel.guidance}</p>
                  {approver ? (
                    <ChannelToggleForm
                      channelId={String(channel.id)}
                      enabled={channel.enabled === true}
                    />
                  ) : null}
                </Card>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-lg font-bold text-stone-800">沖浩志スタイル</h2>
          <Card>
            {approver ? (
              <StyleForm
                structureNotes={active.structureNotes}
                keepRules={active.keepRules}
                avoidRules={active.avoidRules}
                hardRules={active.hardRules}
                version={active.version}
              />
            ) : (
              <>
                <p className="text-base text-stone-700">
                  いまの版：version {active.version}。変更は承認権限のある人だけができます。
                </p>
                <p className="mt-2 whitespace-pre-wrap break-words text-base text-stone-700">
                  {active.hardRules}
                </p>
              </>
            )}
          </Card>
        </section>

        <Link
          href="/crosspost"
          className="flex min-h-[56px] w-full items-center justify-center rounded-xl border-2 border-stone-400 px-4 text-base font-bold text-stone-700"
        >
          ← 一覧へもどる
        </Link>
      </div>
    </>
  );
}
