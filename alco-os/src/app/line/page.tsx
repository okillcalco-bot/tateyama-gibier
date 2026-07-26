import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, EmptyState } from "@/components/ui";
import { HUNTER_LINK_STATUS_LABELS } from "@/domain/hunters/hunter-link-service";
import { CHANNEL_LABELS } from "@/lib/line/channels";
import { buildThread } from "@/domain/hunters/hunter-chat-service";
import { ReplyForm, UnblockLinkForm, VerifyLinkForm, type HunterOption } from "./line-forms";

export const dynamic = "force-dynamic";

/**
 * 捕獲者LINE（職員用）。
 *
 * 高齢者UI原則:
 *  - 大きなボタン（高さ56px以上）・大きめの文字
 *  - 状態は色だけでなく必ず文字とマークでも示す
 *  - 「対応する」ではなく「何が起きるか」を書いたラベル
 *  - 390px幅で横スクロールが出ないようにする
 *
 * AIは提案のみ。返信はここで人が読んでから送る。
 * 承認による業務反映（タスク化）は /drafts の承認センターで行う。
 */

interface LinkRow {
  id: string;
  hunter_id: string | null;
  line_display_name: string | null;
  status: string;
  created_at: string;
}

interface ChannelRow {
  channel_key: string;
  destination: string | null;
  last_seen_at: string | null;
  event_count: number;
}

interface MessageRow {
  id: string;
  hunter_line_link_id: string | null;
  body: string | null;
  message_type: string;
  has_location: boolean;
  detected_intent: string | null;
  status: string;
  received_at: string;
  replied_at: string | null;
  replied_by: string | null;
}

interface OutboundRow {
  id: string;
  hunter_line_link_id: string | null;
  body: string;
  sent_at: string;
  sent_by: string | null;
  status: string;
  error: string | null;
}

function formatDateTime(value: string): string {
  const d = new Date(value);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

/** 状態は色だけで表さない。必ず記号 + 文字を出す */
function StatusLine({ mark, text }: { mark: string; text: string }) {
  return (
    <p className="text-base font-bold text-stone-700">
      <span aria-hidden="true">{mark}</span> {text}
    </p>
  );
}

export default async function LinePage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="捕獲者LINE" description="捕獲者からの連絡の確認と返信" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();

  const [linksResult, messagesResult, huntersResult, channelsResult, outboundResult, profilesResult] =
    await Promise.all([
    supabase
      .from("hunter_line_links")
      .select("id, hunter_id, line_display_name, status, created_at")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("line_inbound_messages")
      .select(
        "id, hunter_line_link_id, body, message_type, has_location, detected_intent, status, received_at, replied_at, replied_by",
      )
      .order("received_at", { ascending: false })
      .limit(50),
    supabase
      .from("hunters")
      .select("id, name, city")
      .is("deleted_at", null)
      .order("name")
      .limit(500),
    supabase
      .from("line_channel_registry")
      .select("channel_key, destination, last_seen_at, event_count")
      .order("channel_key"),
    supabase
      .from("line_outbound_messages")
      .select("id, hunter_line_link_id, body, sent_at, sent_by, status, error")
      .order("sent_at", { ascending: false })
      .limit(100),
    supabase.from("profiles").select("id, display_name").limit(200),
  ]);

  const links = (linksResult.data ?? []) as LinkRow[];
  const messages = (messagesResult.data ?? []) as MessageRow[];
  const hunters = (huntersResult.data ?? []) as HunterOption[];
  const channels = (channelsResult.data ?? []) as ChannelRow[];
  const outbound = (outboundResult.data ?? []) as OutboundRow[];
  const staffNameById = new Map(
    ((profilesResult.data ?? []) as { id: string; display_name: string }[]).map((p) => [
      p.id,
      p.display_name,
    ]),
  );

  const hunterNameById = new Map(hunters.map((h) => [h.id, h.name]));
  const linkById = new Map(links.map((l) => [l.id, l]));

  // 捕獲者ごとに受信・送信をまとめてスレッドにする
  const conversations = links
    .map((link) => {
      const inboundRows = messages.filter((m) => m.hunter_line_link_id === link.id);
      const outboundRows = outbound.filter((o) => o.hunter_line_link_id === link.id);
      if (inboundRows.length === 0 && outboundRows.length === 0) return null;

      const entries = buildThread(
        inboundRows as unknown as Record<string, unknown>[],
        outboundRows as unknown as Record<string, unknown>[],
      );
      const unhandledRows = inboundRows.filter((m) => m.status !== "handled");
      return {
        linkId: link.id,
        title: link.hunter_id
          ? (hunterNameById.get(link.hunter_id) ?? "登録ずみの捕獲者")
          : `お名前の確認まち${
              link.line_display_name ? `（LINEの表示名：${link.line_display_name}）` : ""
            }`,
        entries,
        unhandled: unhandledRows.length,
        latestUnhandledId: unhandledRows[0]?.id ?? null,
        hasLocation: inboundRows.some((m) => m.has_location),
      };
    })
    .filter((conv): conv is NonNullable<typeof conv> => conv !== null)
    .sort((a, b) =>
      (b.entries[b.entries.length - 1]?.at ?? "").localeCompare(
        a.entries[a.entries.length - 1]?.at ?? "",
      ),
    );

  const pendingLinks = links.filter((l) => l.status === "pending");
  const blockedLinks = links.filter((l) => l.status === "blocked");
  const verifiedCount = links.filter((l) => l.status === "verified").length;


  return (
    <>
      <PageHeader
        title="捕獲者LINE"
        description="捕獲者からの連絡の確認と返信。返信は必ず人が読んでから送ります。"
      />

      <div className="space-y-6">
        {/* 1. まだ誰か分からない相手 */}
        <section>
          <h2 className="mb-2 text-lg font-bold text-stone-800">
            1. お名前の確認まち（{pendingLinks.length}件）
          </h2>
          <p className="mb-2 text-base text-stone-600">
            はじめてLINEを送ってきた人です。どの捕獲者かを登録すると、次から自動で仕分けされます。
          </p>
          {pendingLinks.length === 0 ? (
            <EmptyState message="確認まちの相手はいません。" />
          ) : (
            <div className="space-y-3">
              {pendingLinks.map((link) => (
                <Card key={link.id}>
                  <StatusLine mark="●" text={HUNTER_LINK_STATUS_LABELS.pending} />
                  <p className="mt-1 text-base text-stone-700">
                    LINEの表示名：{link.line_display_name ?? "（取得できていません）"}
                  </p>
                  <p className="text-sm text-stone-500">
                    最初の連絡：{formatDateTime(link.created_at)}
                  </p>
                  <VerifyLinkForm linkId={link.id} hunters={hunters} />
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* 2. 会話（スレッド） */}
        <section>
          <h2 className="mb-2 text-lg font-bold text-stone-800">2. 届いた連絡とやりとり</h2>
          <p className="mb-2 text-base text-stone-600">
            捕獲者ごとのやりとりです。文章を書いて「LINEで送る」を押すと、その人に届きます。
            送った人と時刻は記録に残ります。
          </p>
          {conversations.length === 0 ? (
            <EmptyState message="まだ連絡は届いていません。" />
          ) : (
            <div className="space-y-3">
              {conversations.map((conv) => (
                <Card key={conv.linkId}>
                  <p className="text-base font-bold text-stone-800">{conv.title}</p>
                  {conv.unhandled > 0 ? (
                    <StatusLine mark="！" text={`未対応 ${conv.unhandled}件`} />
                  ) : (
                    <StatusLine mark="✓" text="未対応はありません" />
                  )}

                  <div className="mt-2 space-y-2">
                    {conv.entries.map((entry) => {
                      const inbound = entry.direction === "inbound";
                      return (
                        <div
                          key={`${entry.direction}-${entry.id}`}
                          className={`rounded-xl p-3 ${
                            inbound ? "bg-stone-50" : "bg-green-50"
                          }`}
                        >
                          <p className="text-sm text-stone-500">
                            <span aria-hidden="true">{inbound ? "←" : "→"}</span>{" "}
                            {inbound
                              ? "捕獲者から"
                              : `職員から（${
                                  entry.actorId
                                    ? (staffNameById.get(entry.actorId) ?? "担当者")
                                    : "担当者"
                                }）`}
                            ／{formatDateTime(entry.at)}
                            {entry.status === "failed" ? "／送信できませんでした" : ""}
                          </p>
                          {entry.body ? (
                            <p className="mt-1 whitespace-pre-wrap break-words text-base text-stone-800">
                              {entry.body}
                            </p>
                          ) : (
                            <p className="mt-1 text-base text-stone-600">
                              文章以外の連絡です（種類：{entry.messageType ?? "不明"}）
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {conv.hasLocation ? (
                    <p className="mt-2 rounded-xl bg-amber-50 p-3 text-base font-bold text-amber-900">
                      ⚠ 位置情報が送られています。捕獲場所・わなの場所は外部に出せません。
                      画面や書類に地図・座標を貼らないでください。
                    </p>
                  ) : null}

                  <ReplyForm
                    linkId={conv.linkId}
                    messageId={conv.latestUnhandledId ?? undefined}
                    suggestedReply=""
                  />
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* 3. 受け取らない設定 */}
        {blockedLinks.length > 0 ? (
          <section>
            <h2 className="mb-2 text-lg font-bold text-stone-800">
              3. 受け取らない設定の相手（{blockedLinks.length}件）
            </h2>
            <div className="space-y-3">
              {blockedLinks.map((link) => (
                <Card key={link.id}>
                  <StatusLine mark="✕" text={HUNTER_LINK_STATUS_LABELS.blocked} />
                  <p className="mt-1 text-base text-stone-700">
                    LINEの表示名：{link.line_display_name ?? "（取得できていません）"}
                  </p>
                  <UnblockLinkForm linkId={link.id} />
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        <Card className="bg-stone-50">
          <p className="text-base text-stone-700">
            登録ずみの捕獲者：{verifiedCount}人 ／ 捕獲者台帳：{hunters.length}人
          </p>
          <p className="mt-2 text-sm text-stone-500">
            お名前の登録と「受け取らない」の設定は、承認権限のある人だけが行えます。
          </p>
        </Card>

        {/* 設定の確認用。LINE Developers で Bot User ID が見つからないときはここを見る */}
        <section>
          <h2 className="mb-2 text-lg font-bold text-stone-800">つながっているLINE</h2>
          <p className="mb-2 text-base text-stone-600">
            LINEから最初のメッセージが届くと、ここに自動で表示されます。
            設定に使うIDが分からないときは、この画面をご覧ください。
          </p>
          {channels.length === 0 ? (
            <EmptyState message="まだLINEからの受信がありません。Webhookの設定後、テスト送信すると表示されます。" />
          ) : (
            <div className="space-y-3">
              {channels.map((channel) => (
                <Card key={channel.channel_key}>
                  <StatusLine
                    mark="✓"
                    text={
                      CHANNEL_LABELS[channel.channel_key as keyof typeof CHANNEL_LABELS] ??
                      channel.channel_key
                    }
                  />
                  <p className="mt-1 break-all text-base text-stone-700">
                    Bot User ID（destination）：
                    {channel.destination ?? "（まだ取得できていません）"}
                  </p>
                  <p className="text-sm text-stone-500">
                    受信回数：{channel.event_count}回
                    {channel.last_seen_at
                      ? ` ／ 最後の受信：${formatDateTime(channel.last_seen_at)}`
                      : ""}
                  </p>
                  <p className="mt-2 text-sm text-stone-500">
                    このIDは設定に使わなくても動きます。控えておきたいときにお使いください。
                  </p>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
