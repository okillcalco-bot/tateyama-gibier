import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 沖浩志スタイル設定（0029）。
 *
 * - 変更できるのは owner / manager のみ（RLSポリシーでも強制）
 * - 変更は**新しい version を作る**（過去の生成を再現できるように）
 * - 生成時に使った id と version は social_channel_drafts に保存する
 */

export interface StyleProfile {
  id: string;
  name: string;
  version: number;
  structureNotes: string;
  keepRules: string;
  avoidRules: string;
  hardRules: string;
}

export const FALLBACK_STYLE: Omit<StyleProfile, "id"> = {
  name: "沖浩志スタイル",
  version: 0,
  structureNotes:
    "① 【テーマ〜問い・意味 #連番】の見出し / ② その日の具体的な出来事 / ③ 頭数・重量・時間・場所などの一次情報 / ④ 現場で感じた迷い・違和感・反省 / ⑤ 地域・自然・経営への視点 / ⑥ 断定せず問いか今後の姿勢で終える",
  keepRules:
    "一人称「僕」/ 現場の具体 / 数値 / 率直な感情 / 分からないことを分からないまま書く / 一次情報と推測の区別 / 地域との関係",
  avoidRules:
    "過度な美談化 / 広告文化 / AI的な綺麗な結論 / 根拠のない断定 / 大量の絵文字とハッシュタグ / 元投稿にない感情・数値・人物・実績の追加",
  hardRules:
    "止め刺し・捕獲・ウリ坊・処理・廃棄に関する投稿では、迷い・不快感・反省・割り切れなさを消さない。元原稿にない美化表現を追加しない。",
};

export function toStyleProfile(row: Row | null | undefined): StyleProfile | null {
  if (!row) return null;
  const str = (value: unknown, fallback: string) =>
    typeof value === "string" && value ? value : fallback;
  return {
    id: String(row.id),
    name: str(row.name, "沖浩志スタイル"),
    version: typeof row.version === "number" ? row.version : 1,
    structureNotes: str(row.structure_notes, FALLBACK_STYLE.structureNotes),
    keepRules: str(row.keep_rules, FALLBACK_STYLE.keepRules),
    avoidRules: str(row.avoid_rules, FALLBACK_STYLE.avoidRules),
    hardRules: str(row.hard_rules, FALLBACK_STYLE.hardRules),
  };
}

/** 有効なスタイルのうち、いちばん新しい版を返す */
export async function getActiveStyle(
  db: DbPort,
  organizationId: string,
): Promise<StyleProfile | null> {
  const rows = await db.findMany(
    "social_style_profiles",
    { organization_id: organizationId, is_active: true },
    20,
  );
  const latest = rows.sort(
    (a, b) => Number(b.version ?? 0) - Number(a.version ?? 0),
  )[0];
  return toStyleProfile(latest);
}

/** 変更は新しい版として保存する（過去の生成を再現できるように） */
export async function saveStyleVersion(
  db: DbPort,
  ctx: AuditContext,
  input: {
    name?: string;
    structureNotes: string;
    keepRules: string;
    avoidRules: string;
    hardRules: string;
  },
): Promise<Row> {
  const name = (input.name ?? "沖浩志スタイル").trim() || "沖浩志スタイル";
  const existing = await db.findMany(
    "social_style_profiles",
    { organization_id: ctx.organizationId, name },
    50,
  );
  const nextVersion =
    existing.reduce((max, row) => Math.max(max, Number(row.version ?? 0)), 0) + 1;

  // 古い版は無効にする（履歴としては残す）
  for (const row of existing) {
    if (row.is_active === true) {
      await db.update("social_style_profiles", row.id as string, { is_active: false });
    }
  }

  const saved = await db.insert("social_style_profiles", {
    organization_id: ctx.organizationId,
    name,
    version: nextVersion,
    structure_notes: input.structureNotes,
    keep_rules: input.keepRules,
    avoid_rules: input.avoidRules,
    hard_rules: input.hardRules,
    is_active: true,
    created_by: ctx.actorId,
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "social_style_profiles",
    recordId: saved.id as string,
    after: saved,
    note: `沖浩志スタイルを version ${nextVersion} に更新`,
  });

  return saved;
}
