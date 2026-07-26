import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, EmptyState } from "@/components/ui";
import { HUNTER_INTENT_LABELS } from "@/ai/schemas/hunter-message.schema";
import { HUNTER_LINK_STATUS_LABELS } from "@/domain/hunters/hunter-link-service";
import { CHANNEL_LABELS } from "@/lib/line/channels";
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

  const [linksResult, messagesResult, huntersResult, channelsResult] = await Promise.all([
    supabase
      .from("hunter_line_links")
      .select("id, hunter_id, line_display_name, status, created_at")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("line_inbound_messages")
      .select(
        "id, hunter_line_link_id, body, message_type, has_location, detected_intent, status, received_at",
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
  ]);

  const links = (linksResult.data ?? []) as LinkRow[];
  const messages = (messagesResult.data ?? []) as MessageRow[];
  const hunters = (huntersResult.data ?? []) as HunterOption[];
  const channels = (channelsResult.data ?? []) as ChannelRow[];

  const hunterNameById = new Map(hunters.map((h) => [h.id, h.name]));
  const linkById = new Map(links.map((l) => [l.id, l]));

  const pendingLinks = links.filter((l) => l.status === "pending");
  const blockedLinks = links.filter((l) => l.status === "blocked");
  const verifiedCount = links.filter((l) => l.status === "verified").length;

  const senderLabel = (message: MessageRow): string => {
    const link = message.hunter_line_link_id ? linkById.get(message.hunter_line_link_id) : null;
    if (!link) return "送信者：不明";
    if (link.hunter_id) {
      return `送信者：${hunterNameById.get(link.hunter_id) ?? "登録ずみの捕獲者"}`;
    }
    return `送信者：まだ確認できていません${
      link.line_display_name ? `（LINEの表示名：${link.line_display_name}）` : ""
    }`;
  };

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

        {/* 2. 受信メッセージ */}
        <section>
          <h2 className="mb-2 text-lg font-bold text-stone-800">2. 届いた連絡</h2>
          <p className="mb-2 text-base text-stone-600">
            AIの仕分けは目安です。搬入するかどうかは職員が決めてください。
            タスクにするときは「承認」タブで承認します。
          </p>
          {messages.length === 0 ? (
            <EmptyState message="まだ連絡は届いていません。" />
          ) : (
            <div className="space-y-3">
              {messages.map((message) => (
                <Card key={message.id}>
                  <p className="text-sm text-stone-500">{formatDateTime(message.received_at)}</p>
                  <p className="mt-1 text-base font-bold text-stone-800">
                    {senderLabel(message)}
                  </p>

                  {message.detected_intent ? (
                    <StatusLine
                      mark="▶"
                      text={`AIの仕分け：${
                        HUNTER_INTENT_LABELS[
                          message.detected_intent as keyof typeof HUNTER_INTENT_LABELS
                        ] ?? message.detected_intent
                      }`}
                    />
                  ) : (
                    <StatusLine mark="－" text="AIの仕分け：まだありません" />
                  )}

                  {message.status === "handled" ? (
                    <StatusLine mark="✓" text="対応ずみ" />
                  ) : (
                    <StatusLine mark="！" text="未対応" />
                  )}

                  {message.body ? (
                    <p className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-stone-50 p-3 text-base text-stone-800">
                      {message.body}
                    </p>
                  ) : (
                    <p className="mt-2 text-base text-stone-600">
                      文章以外の連絡です（種類：{message.message_type}）
                    </p>
                  )}

                  {message.has_location ? (
                    <p className="mt-2 rounded-xl bg-amber-50 p-3 text-base font-bold text-amber-900">
                      ⚠ 位置情報が送られています。捕獲場所・わなの場所は外部に出せません。
                      画面や書類に地図・座標を貼らないでください。
                    </p>
                  ) : null}

                  <ReplyForm messageId={message.id} suggestedReply="" />
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
