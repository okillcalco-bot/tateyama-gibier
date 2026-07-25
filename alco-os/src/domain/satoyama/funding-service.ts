import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 応援（支援金）と、調査への支払い。
 *
 * 循環の実装:
 *   応援表明 → 入金確認 → クエストの funded_yen 加算
 *            → 調査実施 → 調査員へ謝金（quest_payouts）→ paid_out_yen 加算
 *
 * 不変条件（お金の安全性）:
 * - 入金確認していない応援（pledged）は資金に数えない
 * - 支払い合計は入金確認済み合計を超えられない
 * - 金額の増減は必ず監査ログに残す（データは資産・削除しない）
 */

export const PLEDGE_STATUSES = ["pledged", "confirmed", "cancelled", "refunded"] as const;
export type PledgeStatus = (typeof PLEDGE_STATUSES)[number];

export const SUPPORT_METHODS = {
  transfer: "銀行振込",
  cash: "現地・イベントで直接",
  stripe: "クレジットカード（準備中）",
} as const;
export type SupportMethod = keyof typeof SUPPORT_METHODS;

export interface NewPledge {
  taskId?: string | null; // null = 里山全体への応援
  displayName: string;
  realName?: string;
  email?: string;
  isPublic?: boolean;
  amountYen: number;
  method?: SupportMethod;
  message?: string;
  messagePublic?: boolean;
}

/** 応援の申し込み（公開ページから。この時点では資金に数えない） */
export async function createPledge(
  db: DbPort,
  ctx: AuditContext,
  input: NewPledge,
): Promise<Row> {
  const amount = Math.floor(Number(input.amountYen));
  if (!Number.isFinite(amount) || amount < 100) {
    throw new Error("応援金額は100円以上で入力してください");
  }
  if (amount > 10_000_000) throw new Error("金額が大きすぎます。直接ご相談ください");
  const displayName = input.displayName.trim() || "匿名の応援者";
  const method = input.method ?? "transfer";
  if (!SUPPORT_METHODS[method]) throw new Error(`不正な支払方法: ${method}`);

  // 公開クエストにのみ応援できる（希少種クエストは公開されない = 応援対象外）
  if (input.taskId) {
    const quest = await db.findById("survey_tasks", input.taskId);
    if (!quest || !quest.published_at || quest.restricted) {
      throw new Error("このクエストは現在応援を受け付けていません");
    }
  }

  const supporter = await db.insert("supporters", {
    organization_id: ctx.organizationId,
    display_name: displayName,
    real_name: input.realName?.trim() || null,
    email: input.email?.trim() || null,
    is_public: input.isPublic ?? true,
  });

  const pledge = await db.insert("support_pledges", {
    organization_id: ctx.organizationId,
    task_id: input.taskId ?? null,
    supporter_id: supporter.id,
    amount_yen: amount,
    method,
    status: "pledged",
    message: input.message?.trim() || null,
    message_public: input.messagePublic ?? true,
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "support_pledges",
    recordId: pledge.id as string,
    after: pledge,
    note: `応援の申し込み ¥${amount.toLocaleString()}（${displayName}）`,
  });
  return pledge;
}

/** 入金確認。ここで初めてクエストの資金になる */
export async function confirmPledge(
  db: DbPort,
  ctx: AuditContext,
  pledgeId: string,
): Promise<Row> {
  const pledge = await db.findById("support_pledges", pledgeId);
  if (!pledge) throw new Error(`応援が見つかりません: ${pledgeId}`);
  if (pledge.status === "confirmed") throw new Error("すでに入金確認済みです");
  if (pledge.status === "cancelled" || pledge.status === "refunded") {
    throw new Error("取消・返金済みの応援は確認できません");
  }

  const after = await db.update("support_pledges", pledgeId, {
    status: "confirmed",
    confirmed_by: ctx.actorId,
    confirmed_at: new Date().toISOString(),
  });

  if (pledge.task_id) {
    const quest = await db.findById("survey_tasks", pledge.task_id as string);
    if (quest) {
      await db.update("survey_tasks", pledge.task_id as string, {
        funded_yen: (Number(quest.funded_yen) || 0) + (Number(pledge.amount_yen) || 0),
      });
    }
  }

  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "support_pledges",
    recordId: pledgeId,
    before: pledge,
    after,
    note: `入金確認 ¥${Number(pledge.amount_yen).toLocaleString()}`,
  });
  return after;
}

export async function cancelPledge(
  db: DbPort,
  ctx: AuditContext,
  pledgeId: string,
  status: "cancelled" | "refunded",
): Promise<Row> {
  const pledge = await db.findById("support_pledges", pledgeId);
  if (!pledge) throw new Error(`応援が見つかりません: ${pledgeId}`);

  // 確認済みを取り消す場合は資金から差し引く
  if (pledge.status === "confirmed" && pledge.task_id) {
    const quest = await db.findById("survey_tasks", pledge.task_id as string);
    if (quest) {
      const nextFunded = (Number(quest.funded_yen) || 0) - (Number(pledge.amount_yen) || 0);
      if (nextFunded < (Number(quest.paid_out_yen) || 0)) {
        throw new Error("支払い済み額を下回るため取り消せません。先に支払い記録を確認してください");
      }
      await db.update("survey_tasks", pledge.task_id as string, {
        funded_yen: Math.max(0, nextFunded),
      });
    }
  }

  const after = await db.update("support_pledges", pledgeId, { status });
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "support_pledges",
    recordId: pledgeId,
    before: pledge,
    after,
    note: status === "refunded" ? "応援を返金" : "応援を取消",
  });
  return after;
}

export interface NewPayout {
  taskId: string;
  payeeName: string;
  staffId?: string | null;
  amountYen: number;
  paidOn: string;
  purpose?: string;
  note?: string;
}

/**
 * 調査への支払い（謝金・交通費）= 地域の仕事になる部分。
 * 入金確認済みの応援を超える支払いはできない。
 */
export async function recordPayout(
  db: DbPort,
  ctx: AuditContext,
  input: NewPayout,
): Promise<Row> {
  const amount = Math.floor(Number(input.amountYen));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("支払額を入力してください");
  if (!input.payeeName.trim()) throw new Error("支払先を入力してください");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) throw new Error("支払日を入力してください");

  const quest = await db.findById("survey_tasks", input.taskId);
  if (!quest) throw new Error(`クエストが見つかりません: ${input.taskId}`);

  const funded = Number(quest.funded_yen) || 0;
  const paidOut = Number(quest.paid_out_yen) || 0;
  if (paidOut + amount > funded) {
    throw new Error(
      `応援金の残り（¥${(funded - paidOut).toLocaleString()}）を超える支払いはできません`,
    );
  }

  const payout = await db.insert("quest_payouts", {
    organization_id: ctx.organizationId,
    task_id: input.taskId,
    payee_name: input.payeeName.trim(),
    staff_id: input.staffId ?? null,
    amount_yen: amount,
    paid_on: input.paidOn,
    purpose: input.purpose?.trim() || null,
    note: input.note?.trim() || null,
    created_by: ctx.actorId,
  });

  await db.update("survey_tasks", input.taskId, { paid_out_yen: paidOut + amount });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "quest_payouts",
    recordId: payout.id as string,
    after: payout,
    note: `調査謝金 ¥${amount.toLocaleString()} → ${input.payeeName}（${quest.title}）`,
  });
  return payout;
}

/** 里山全体の応援サマリー（ダッシュボード・公開ページ用） */
export function summarizeSupport(pledges: Row[], payouts: Row[]) {
  const confirmed = pledges.filter((p) => p.status === "confirmed");
  const totalFunded = confirmed.reduce((sum, p) => sum + (Number(p.amount_yen) || 0), 0);
  const totalPaidOut = payouts.reduce((sum, p) => sum + (Number(p.amount_yen) || 0), 0);
  return {
    supporterCount: new Set(confirmed.map((p) => p.supporter_id)).size,
    pledgeCount: confirmed.length,
    totalFunded,
    totalPaidOut,
    available: Math.max(0, totalFunded - totalPaidOut),
    /** 応援がどれだけ地域に回ったか（%） */
    circulationRate: totalFunded > 0 ? Math.round((totalPaidOut / totalFunded) * 100) : 0,
  };
}
