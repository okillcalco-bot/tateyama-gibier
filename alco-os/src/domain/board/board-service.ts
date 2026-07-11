import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 共有ボードサービス（スタッフ向け / 飲食店向け）。
 *
 * 設計方針:
 * - タグは「辞書ベースの自動付与 + 手動追加」。AIではなくルールで付けるので
 *   即時・無料・安定（AI提案タグは段階2。付ける場合も承認フロー経由にすること）
 * - スタッフ向けは staff.role（既存テーブルの役割）で宛先を絞る
 * - 飲食店向けは customer_levels.tier（new/repeat/vip）で配信先を絞る
 * - 削除はソフトデリート、重要操作は監査ログ
 */

export const AUDIENCES = ["staff", "customer"] as const;
export type Audience = (typeof AUDIENCES)[number];

export const CUSTOMER_TIERS = {
  new: "初回",
  repeat: "リピーター",
  vip: "太客",
} as const;
export type CustomerTier = keyof typeof CUSTOMER_TIERS;

/** 自動タグの辞書。現場の言葉が増えたらここに足す（Opusで保守しやすい形） */
export const TAG_RULES: ReadonlyArray<[string, RegExp]> = [
  ["至急", /至急|今日中|大至急|急ぎ|ASAP/i],
  ["精肉・在庫", /精肉|在庫|ロース|モモ|バラ|ヒレ|スネ|枝肉|ミンチ|真空|冷凍|冷蔵|部位|歩留/],
  ["受注・配送", /注文|受注|配送|納品|発送|出荷|搬入|集荷|便/],
  ["勤怠・シフト", /シフト|勤怠|出勤|退勤|休み|有休|欠勤|遅刻|早退/],
  ["衛生・清掃", /清掃|衛生|消毒|洗浄|HACCP|ハサップ|温度|検査/],
  ["捕獲・個体", /捕獲|個体|イノシシ|猪|シカ|鹿|わな|罠|猟|止め刺し|搬入頭数/],
  ["設備・施設", /設備|故障|修理|点検|機械|冷凍庫|冷蔵庫|施設|工事/],
  ["経理・事務", /請求|支払|入金|経費|領収|補助金|申請|契約|書類/],
  ["告知・イベント", /イベント|見学|視察|取材|講演|イベント|キャンペーン|フェア/],
  ["商品案内", /おすすめ|オススメ|売りたい|特価|入荷|新商品|限定/],
];

/** 本文・タイトルから自動タグを抽出する（重複なし・辞書順） */
export function autoTags(text: string): string[] {
  return TAG_RULES.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
}

export interface NewBoardPost {
  audience: Audience;
  title?: string;
  body: string;
  manualTags?: string[];
  targetRoles?: string[]; // staff向け。空 = 全員
  targetTiers?: CustomerTier[]; // customer向け。空 = 全店
  inventorySnapshot?: unknown[] | null; // 精肉DBリンク（投稿時点の在庫）
  pinned?: boolean;
}

export async function createBoardPost(
  db: DbPort,
  ctx: AuditContext,
  input: NewBoardPost,
): Promise<Row> {
  if (!AUDIENCES.includes(input.audience)) throw new Error(`不正な掲示先: ${input.audience}`);
  const body = input.body.trim();
  if (!body) throw new Error("本文を入力してください");

  const tags = [
    ...new Set([
      ...autoTags(`${input.title ?? ""}\n${body}`),
      ...(input.manualTags ?? []).map((tag) => tag.trim()).filter(Boolean),
    ]),
  ];
  const invalidTiers = (input.targetTiers ?? []).filter((tier) => !CUSTOMER_TIERS[tier]);
  if (invalidTiers.length) throw new Error(`不正な信頼度: ${invalidTiers.join(", ")}`);

  const post = await db.insert("board_posts", {
    organization_id: ctx.organizationId,
    audience: input.audience,
    title: input.title?.trim() || null,
    body,
    tags,
    target_roles: input.audience === "staff" ? (input.targetRoles ?? []) : [],
    target_tiers: input.audience === "customer" ? (input.targetTiers ?? []) : [],
    inventory_snapshot: input.inventorySnapshot ?? null,
    pinned: input.pinned ?? false,
    status: "open",
    created_by: ctx.actorId,
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "board_posts",
    recordId: post.id as string,
    after: post,
    note: `ボード投稿（${input.audience === "staff" ? "スタッフ向け" : "飲食店向け"}）`,
  });
  return post;
}

export async function archiveBoardPost(
  db: DbPort,
  ctx: AuditContext,
  postId: string,
): Promise<Row> {
  const before = await db.findById("board_posts", postId);
  if (!before) throw new Error(`投稿が見つかりません: ${postId}`);
  const after = await db.update("board_posts", postId, { status: "archived", pinned: false });
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "board_posts",
    recordId: postId,
    before,
    after,
    note: "ボード投稿をアーカイブ",
  });
  return after;
}

/** 投稿がその役割のスタッフに向いているか（宛先なし = 全員向け） */
export function isVisibleToRole(post: Row, role: string | null | undefined): boolean {
  const targets = (post.target_roles as string[]) ?? [];
  if (!targets.length) return true;
  return !!role && targets.includes(role);
}

/** 投稿がその信頼度の飲食店に向いているか（宛先なし = 全店向け） */
export function isVisibleToTier(post: Row, tier: string): boolean {
  const targets = (post.target_tiers as string[]) ?? [];
  if (!targets.length) return true;
  return targets.includes(tier);
}

/** 飲食店の信頼度を設定（1店舗1行を upsert 相当で維持） */
export async function setCustomerTier(
  db: DbPort,
  ctx: AuditContext,
  customerId: string,
  tier: CustomerTier,
  note?: string,
): Promise<Row> {
  if (!CUSTOMER_TIERS[tier]) throw new Error(`不正な信頼度: ${tier}`);
  const existing = await db.findMany("customer_levels", { customer_id: customerId }, 1);
  let level: Row;
  if (existing.length) {
    level = await db.update("customer_levels", existing[0].id as string, {
      tier,
      note: note ?? existing[0].note,
    });
  } else {
    level = await db.insert("customer_levels", {
      organization_id: ctx.organizationId,
      customer_id: customerId,
      tier,
      note: note ?? null,
      created_by: ctx.actorId,
    });
  }
  await writeAuditLog(db, ctx, {
    action: existing.length ? "update" : "insert",
    tableName: "customer_levels",
    recordId: level.id as string,
    before: existing[0] ?? null,
    after: level,
    note: `飲食店の信頼度を ${CUSTOMER_TIERS[tier]} に設定`,
  });
  return level;
}
