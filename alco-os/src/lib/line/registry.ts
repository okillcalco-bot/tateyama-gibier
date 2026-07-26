import { getServiceDbContext } from "@/lib/db/service-context";
import { recordChannelSighting } from "@/domain/hunters/line-channel-registry";
import type { LineChannel } from "./channels";

/**
 * 受信したチャネルの台帳記録（インフラ配線）。
 *
 * destination（Bot User ID）は LINE Developers の画面で見つけにくいことがある。
 * 一度でも webhook を受ければここに記録されるので、職員が /line で確認できる。
 * 記録に失敗しても webhook は止めない（受信が最優先）。
 */
export async function recordLineChannelSighting(
  channel: LineChannel,
  destination: string | null,
): Promise<void> {
  try {
    const { db, organizationId } = await getServiceDbContext();
    await recordChannelSighting(db, {
      organizationId,
      channelKey: channel.key,
      channelRef: channel.ref,
      destination,
    });
  } catch {
    // 台帳記録は補助機能。失敗しても受信処理は続ける
  }
}
