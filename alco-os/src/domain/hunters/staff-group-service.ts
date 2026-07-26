import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";
import { normalizeKeyword } from "./hunter-keywords";

/**
 * スタッフのLINEグループへの通知（0028）。
 *
 * 捕獲者向けLINE公式アカウントをスタッフのグループに招待し、
 * 「搬入連絡」が届いたらそのグループへ Push する。
 *
 * 守秘義務のルール（docs/06・§8-2）:
 * - グループへ流すのは**最小限**。買取額・口座・捕獲場所の座標・写真は流さない
 * - グループからのメッセージは業務処理しない（誤爆防止）。
 *   反応するのは「登録」「解除」の2語だけ
 */

export type StaffGroupStatus = "pending" | "active" | "disabled" | "left";

export const STAFF_GROUP_STATUS_LABELS: Record<StaffGroupStatus, string> = {
  pending: "招待されました（未登録）",
  active: "通知します",
  disabled: "通知を止めています",
  left: "退出しました",
};

/** グループ内で反応するコマンド（これ以外は無視する） */
export type GroupCommand = "register" | "unregister" | null;

export function matchGroupCommand(text: string): GroupCommand {
  const normalized = normalizeKeyword(text);
  if (!normalized) return null;
  if (["登録", "通知登録", "通知オン", "通知on"].includes(normalized)) return "register";
  if (["解除", "登録解除", "通知停止", "通知オフ", "通知off"].includes(normalized)) {
    return "unregister";
  }
  return null;
}

export async function findGroup(db: DbPort, lineGroupId: string): Promise<Row | null> {
  const rows = await db.findMany("line_staff_groups", { line_group_id: lineGroupId }, 1);
  return rows[0] ?? null;
}

/** 招待された（join）ときに受け皿を作る。通知はまだしない */
export async function recordGroupJoin(
  db: DbPort,
  params: {
    organizationId: string;
    lineChannelId: string;
    lineGroupId: string;
    now?: Date;
  },
): Promise<Row> {
  const now = (params.now ?? new Date()).toISOString();
  const existing = await findGroup(db, params.lineGroupId);
  if (existing) {
    // 退出後に再招待されたケース。通知設定はそのままにして状態だけ戻す
    return db.update("line_staff_groups", existing.id as string, {
      status: existing.status === "left" ? "pending" : existing.status,
      joined_at: now,
    });
  }
  return db.insert("line_staff_groups", {
    organization_id: params.organizationId,
    line_channel_id: params.lineChannelId,
    line_group_id: params.lineGroupId,
    status: "pending",
    notify_delivery: false,
    joined_at: now,
  });
}

/** グループ内で「登録」と送られたとき */
export async function activateGroup(
  db: DbPort,
  params: {
    organizationId: string;
    lineChannelId: string;
    lineGroupId: string;
    ctx?: AuditContext;
    now?: Date;
  },
): Promise<Row> {
  const now = (params.now ?? new Date()).toISOString();
  const group =
    (await findGroup(db, params.lineGroupId)) ??
    (await recordGroupJoin(db, {
      organizationId: params.organizationId,
      lineChannelId: params.lineChannelId,
      lineGroupId: params.lineGroupId,
      now: params.now,
    }));

  const updated = await db.update("line_staff_groups", group.id as string, {
    status: "active",
    notify_delivery: true,
    registered_at: now,
  });

  if (params.ctx) {
    await writeAuditLog(db, params.ctx, {
      action: "update",
      tableName: "line_staff_groups",
      recordId: group.id as string,
      note: "スタッフグループへの搬入連絡の通知を開始",
    });
  }
  return updated;
}

/** グループ内で「解除」、または職員画面から止めるとき */
export async function disableGroup(
  db: DbPort,
  params: { lineGroupId?: string; groupId?: string; ctx?: AuditContext; status?: "disabled" | "left" },
): Promise<Row | null> {
  const group = params.groupId
    ? await db.findById("line_staff_groups", params.groupId)
    : params.lineGroupId
      ? await findGroup(db, params.lineGroupId)
      : null;
  if (!group) return null;

  const updated = await db.update("line_staff_groups", group.id as string, {
    status: params.status ?? "disabled",
    notify_delivery: false,
  });

  if (params.ctx) {
    await writeAuditLog(db, params.ctx, {
      action: "update",
      tableName: "line_staff_groups",
      recordId: group.id as string,
      note:
        params.status === "left"
          ? "スタッフグループから退出したため通知を停止"
          : "スタッフグループへの通知を停止",
    });
  }
  return updated;
}

/** 職員画面から通知を再開する */
export async function enableGroupNotify(
  db: DbPort,
  ctx: AuditContext,
  groupId: string,
): Promise<Row> {
  const group = await db.findById("line_staff_groups", groupId);
  if (!group) throw new Error("グループが見つかりません");
  if (group.status === "left") {
    throw new Error("このグループからは退出しています。もう一度招待してください");
  }

  const updated = await db.update("line_staff_groups", groupId, {
    status: "active",
    notify_delivery: true,
    registered_by: ctx.actorId,
    registered_at: new Date().toISOString(),
  });

  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "line_staff_groups",
    recordId: groupId,
    note: "スタッフグループへの通知を再開",
  });
  return updated;
}

/** 名前を付ける（どのグループか職員が分かるように） */
export async function renameGroup(
  db: DbPort,
  ctx: AuditContext,
  params: { groupId: string; label: string },
): Promise<Row> {
  const updated = await db.update("line_staff_groups", params.groupId, {
    label: params.label.trim() || null,
  });
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "line_staff_groups",
    recordId: params.groupId,
    note: "スタッフグループの名前を変更",
  });
  return updated;
}

/** 通知先のグループ一覧（active かつ notify_delivery のものだけ） */
export async function listNotifyTargets(db: DbPort, organizationId: string): Promise<Row[]> {
  const rows = await db.findMany(
    "line_staff_groups",
    { organization_id: organizationId, status: "active" },
    20,
  );
  return rows.filter((row) => row.notify_delivery === true);
}

export async function recordNotified(db: DbPort, groupId: string, now?: Date): Promise<void> {
  const group = await db.findById("line_staff_groups", groupId);
  if (!group) return;
  const count = typeof group.notify_count === "number" ? group.notify_count : 0;
  await db.update("line_staff_groups", groupId, {
    last_notified_at: (now ?? new Date()).toISOString(),
    notify_count: count + 1,
  });
}

// ── グループへ流す文面 ──

export interface DeliveryNoticeParams {
  /** 照合済みなら捕獲者名。未照合なら null */
  hunterName: string | null;
  receivedAt: Date;
  /** 本日の受入可否（org_settings） */
  accepting: boolean | null;
}

function formatTime(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(
    2,
    "0",
  )}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 搬入連絡の通知文。
 *
 * **最小限に保つこと。** 買取額・口座・捕獲場所の座標・写真・LINEユーザーIDは
 * 絶対に含めない（グループには社外の人が入る可能性がある）。
 */
export function buildDeliveryNoticeMessage(params: DeliveryNoticeParams): string {
  const lines = [
    "【搬入の連絡】",
    `捕獲者：${params.hunterName ?? "お名前の確認まちの方"}`,
    `受信：${formatTime(params.receivedAt)}`,
  ];
  if (params.accepting === false) {
    lines.push("本日は受け入れを止めています。対応をお願いします。");
  }
  lines.push("");
  lines.push("詳しい内容と返信は ALCO OS の「捕獲者LINE」から確認してください。");
  return lines.join("\n");
}

export function groupRegisteredReply(): string {
  return [
    "このグループに搬入連絡を通知します。",
    "捕獲者から「搬入連絡」が届いたら、ここにお知らせします。",
    "止めるときは「解除」と送ってください。",
  ].join("\n");
}

export function groupUnregisteredReply(): string {
  return [
    "このグループへの通知を止めました。",
    "また受け取るときは「登録」と送ってください。",
  ].join("\n");
}

export function groupJoinedReply(): string {
  return [
    "館山ジビエセンターです。招待ありがとうございます。",
    "このグループで搬入連絡を受け取るには「登録」と送ってください。",
    "※ このグループのメッセージには反応しません（「登録」「解除」のみ）。",
  ].join("\n");
}
