import type { DbPort, Row } from "@/lib/db/port";

/**
 * LINEチャネル台帳（0023）。
 *
 * 受信した webhook の destination（Bot User ID）を初回に自動記録する。
 * **ルーティングには使わない**（チャネルの特定は署名検証で完結している）。
 * LINE Developers の画面で Bot User ID が見つからなくても、
 * 一度でも受信すればここに出るので、職員が画面で確認できる。
 */

export type LineChannelKey = "secretary" | "hunter";

export interface ChannelSighting {
  organizationId: string;
  channelKey: LineChannelKey;
  channelRef: string;
  /** 署名検証を通ったボディから読んだ destination。無ければ null */
  destination: string | null;
  now?: Date;
}

/**
 * 受信を記録する。destination が既に記録済みで値が変わった場合も上書きする
 * （チャネルを作り直したケースを拾う）。失敗しても呼び出し側を止めない想定。
 */
export async function recordChannelSighting(
  db: DbPort,
  params: ChannelSighting,
): Promise<Row | null> {
  const now = (params.now ?? new Date()).toISOString();
  const rows = await db.findMany(
    "line_channel_registry",
    { organization_id: params.organizationId, channel_key: params.channelKey },
    1,
  );
  const existing = rows[0];

  if (!existing) {
    return db.insert("line_channel_registry", {
      organization_id: params.organizationId,
      channel_key: params.channelKey,
      channel_ref: params.channelRef,
      destination: params.destination,
      first_seen_at: now,
      last_seen_at: now,
      event_count: 1,
    });
  }

  const previousCount =
    typeof existing.event_count === "number" ? existing.event_count : 0;
  return db.update("line_channel_registry", existing.id as string, {
    channel_ref: params.channelRef,
    // 未記録なら記録し、変わっていれば追従する
    destination: params.destination ?? existing.destination ?? null,
    first_seen_at: existing.first_seen_at ?? now,
    last_seen_at: now,
    event_count: previousCount + 1,
  });
}

export async function listChannelRegistry(
  db: DbPort,
  organizationId: string,
): Promise<Row[]> {
  return db.findMany("line_channel_registry", { organization_id: organizationId }, 10);
}
