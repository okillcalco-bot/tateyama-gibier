import { getServiceDbContext } from "@/lib/db/service-context";
import { getAcceptanceStatus } from "@/domain/hunters/gibier-status-service";
import {
  activateGroup,
  buildDeliveryNoticeMessage,
  disableGroup,
  groupJoinedReply,
  groupRegisteredReply,
  groupUnregisteredReply,
  listNotifyTargets,
  matchGroupCommand,
  recordGroupJoin,
  recordNotified,
} from "@/domain/hunters/staff-group-service";
import { pushMessage, textMessage } from "./client";
import type { LineChannel } from "./channels";

/**
 * スタッフのLINEグループまわり（0028・インフラ配線）。
 *
 * グループのメッセージは**業務処理しない**（誤爆防止）。
 * 反応するのは招待（join）と「登録」「解除」の2語だけ。
 */

export interface GroupEventInput {
  eventType: string;
  lineGroupId: string;
  text: string | null;
}

/** グループのイベントを処理する。返信が必要なら文面を返す */
export async function handleStaffGroupEvent(
  channel: LineChannel,
  input: GroupEventInput,
): Promise<string | null> {
  try {
    const { db, organizationId } = await getServiceDbContext();

    if (input.eventType === "join") {
      await recordGroupJoin(db, {
        organizationId,
        lineChannelId: channel.ref,
        lineGroupId: input.lineGroupId,
      });
      return groupJoinedReply();
    }

    if (input.eventType === "leave") {
      await disableGroup(db, { lineGroupId: input.lineGroupId, status: "left" });
      return null;
    }

    if (input.eventType !== "message" || !input.text) return null;

    // 「登録」「解除」以外のグループ発言には**一切反応しない**
    const command = matchGroupCommand(input.text);
    if (command === "register") {
      await activateGroup(db, {
        organizationId,
        lineChannelId: channel.ref,
        lineGroupId: input.lineGroupId,
      });
      return groupRegisteredReply();
    }
    if (command === "unregister") {
      await disableGroup(db, { lineGroupId: input.lineGroupId });
      return groupUnregisteredReply();
    }
    return null;
  } catch {
    // グループ処理の失敗で webhook を落とさない
    return null;
  }
}

/**
 * 搬入連絡をスタッフグループへ通知する。
 *
 * 流すのは最小限（誰から・いつ・本日の受入可否まで）。
 * 買取額・口座・捕獲場所の座標・写真は含めない。
 */
export async function notifyStaffGroupsOfDelivery(
  channel: LineChannel,
  params: { hunterName: string | null; receivedAt?: Date },
): Promise<void> {
  if (!channel.accessToken) return;
  try {
    const { db, organizationId } = await getServiceDbContext();
    const targets = await listNotifyTargets(db, organizationId);
    if (targets.length === 0) return;

    const acceptance = await getAcceptanceStatus(db);
    const text = buildDeliveryNoticeMessage({
      hunterName: params.hunterName,
      receivedAt: params.receivedAt ?? new Date(),
      accepting: acceptance.accepting,
    });

    for (const group of targets) {
      const result = await pushMessage(channel.accessToken, String(group.line_group_id), [
        textMessage(text),
      ]);
      if (result.ok) await recordNotified(db, group.id as string);
    }
  } catch {
    // 通知の失敗で捕獲者への返信を止めない
  }
}
