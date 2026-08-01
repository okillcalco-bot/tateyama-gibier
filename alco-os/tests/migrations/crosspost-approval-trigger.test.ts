import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * 0029 の承認トリガーを**本物の PostgreSQL 上で**動かして確かめる。
 *
 * PGlite（WebAssembly の PostgreSQL）を使い、マイグレーションから
 * `alco_social_enforce_approval()` の定義を**そのまま抜き出して**実行する。
 * SQL の文字列検査ではなく、実際に UPDATE が弾かれることを確かめる。
 *
 * Supabase 固有のもの（auth.uid() / can_approve()）だけをスタブにしている。
 * can_approve() は `test.approver` 設定で owner/manager かどうかを切り替える。
 */

const MIGRATION = path.join(process.cwd(), "supabase", "migrations", "0029_crosspost.sql");

/** マイグレーション本体から関数定義を1つ抜き出す（改変せずそのまま使う） */
function extractFunction(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}`);
  if (start < 0) throw new Error(`${name} が 0029 に見つかりません`);
  const end = sql.indexOf("$$;", start);
  if (end < 0) throw new Error(`${name} の終わりが見つかりません`);
  return sql.slice(start, end + 3);
}

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const SOURCE = "33333333-3333-3333-3333-333333333333";
const OTHER_SOURCE = "44444444-4444-4444-4444-444444444444";
const STAFF = "55555555-5555-5555-5555-555555555555";
const MANAGER = "66666666-6666-6666-6666-666666666666";

describe("0029 承認トリガー（実DB）", () => {
  let db: PGlite;

  beforeAll(async () => {
    const sql = readFileSync(MIGRATION, "utf8");
    db = await PGlite.create();

    // Supabase 側の前提をスタブにする
    await db.exec(`
      create schema if not exists auth;
      create or replace function auth.uid() returns uuid language sql stable as $fn$
        select nullif(current_setting('test.uid', true), '')::uuid;
      $fn$;
      create or replace function can_approve() returns boolean language sql stable as $fn$
        select coalesce(current_setting('test.approver', true), 'off') = 'on';
      $fn$;
      create or replace function current_organization_id() returns uuid language sql stable as $fn$
        select '${ORG}'::uuid;
      $fn$;

      create table social_channel_drafts (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null,
        social_source_id uuid not null,
        channel_key text not null,
        created_by uuid,
        status text not null default 'draft',
        ai_body text,
        edited_body text,
        approved_body text,
        approval_draft_id uuid,
        approved_by uuid,
        approved_at timestamptz,
        review_reasons text[] not null default '{}',
        review_acknowledged_by uuid,
        review_acknowledged_at timestamptz
      );
    `);

    // 0029 の関数定義とトリガーを、書かれているまま流し込む
    await db.exec(extractFunction(sql, "alco_social_enforce_approval()"));
    await db.exec(`
      create trigger trg_social_channel_drafts_approval
        before update on social_channel_drafts
        for each row execute function alco_social_enforce_approval();
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  /** 権限を切り替える（owner/manager か、一般スタッフか） */
  async function as(role: "staff" | "manager") {
    await db.exec(
      `select set_config('test.approver', '${role === "manager" ? "on" : "off"}', false),
              set_config('test.uid', '${role === "manager" ? MANAGER : STAFF}', false);`,
    );
  }

  /** 指定した状態の下書きを1件用意する（UPDATEトリガーを通さずに作る） */
  async function seed(status: string, reasons: string[] = []): Promise<string> {
    const approved = status === "approved" || status === "published" || status === "queued";
    const res = await db.query<{ id: string }>(
      `insert into social_channel_drafts
         (organization_id, social_source_id, channel_key, created_by, status,
          approved_body, approved_by, approved_at, review_reasons)
       values ($1, $2, 'instagram', $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        ORG,
        SOURCE,
        STAFF,
        status,
        approved ? "承認済みの本文" : null,
        approved ? MANAGER : null,
        approved ? new Date().toISOString() : null,
        reasons,
      ],
    );
    return res.rows[0].id;
  }

  it("一般スタッフは approved → editing にできない", async () => {
    const id = await seed("approved");
    await as("staff");
    await expect(
      db.query(`update social_channel_drafts set status = 'editing' where id = $1`, [id]),
    ).rejects.toThrow(/承認権限/);

    const after = await db.query<{ status: string }>(
      `select status from social_channel_drafts where id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe("approved");
  });

  it("一般スタッフは published → draft にできない", async () => {
    const id = await seed("published");
    await as("staff");
    await expect(
      db.query(`update social_channel_drafts set status = 'draft' where id = $1`, [id]),
    ).rejects.toThrow(/承認権限/);
  });

  it("一般スタッフは queued → draft にもできない", async () => {
    const id = await seed("queued");
    await as("staff");
    await expect(
      db.query(`update social_channel_drafts set status = 'draft' where id = $1`, [id]),
    ).rejects.toThrow(/承認権限/);
  });

  it("承認済みの下書きの元投稿は差し替えられない（owner/manager でも）", async () => {
    const id = await seed("approved");
    await as("manager");
    await expect(
      db.query(`update social_channel_drafts set social_source_id = $2 where id = $1`, [
        id,
        OTHER_SOURCE,
      ]),
    ).rejects.toThrow(/元投稿/);
  });

  it("媒体は差し替えられない（owner/manager でも）", async () => {
    const id = await seed("approved");
    await as("manager");
    await expect(
      db.query(`update social_channel_drafts set channel_key = 'x' where id = $1`, [id]),
    ).rejects.toThrow(/媒体/);
  });

  it("組織と作成者も差し替えられない", async () => {
    const id = await seed("draft");
    await as("manager");
    await expect(
      db.query(`update social_channel_drafts set organization_id = $2 where id = $1`, [
        id,
        OTHER_ORG,
      ]),
    ).rejects.toThrow(/組織/);
    await expect(
      db.query(`update social_channel_drafts set created_by = $2 where id = $1`, [id, MANAGER]),
    ).rejects.toThrow(/作成者/);
  });

  it("owner/manager の差し戻しは通り、承認情報が消える", async () => {
    const id = await seed("approved");
    await as("manager");
    await db.query(
      `update social_channel_drafts
         set status = 'editing', approved_body = null, approval_draft_id = null
       where id = $1`,
      [id],
    );

    const after = await db.query<{
      status: string;
      approved_by: string | null;
      approved_at: string | null;
      approved_body: string | null;
    }>(
      `select status, approved_by, approved_at, approved_body
         from social_channel_drafts where id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe("editing");
    expect(after.rows[0].approved_by).toBeNull();
    expect(after.rows[0].approved_at).toBeNull();
    expect(after.rows[0].approved_body).toBeNull();
  });

  it("owner/manager の承認では承認者と日時がサーバー側で入る", async () => {
    const id = await seed("editing");
    await as("manager");
    await db.query(
      `update social_channel_drafts
         set status = 'approved', approved_body = '確定した本文',
             approved_by = $2, approved_at = '2000-01-01'
       where id = $1`,
      [id, STAFF], // クライアントが嘘の承認者を指定しても
    );

    const after = await db.query<{ approved_by: string; approved_at: string }>(
      `select approved_by, approved_at from social_channel_drafts where id = $1`,
      [id],
    );
    expect(after.rows[0].approved_by).toBe(MANAGER); // auth.uid() で上書きされる
    expect(new Date(after.rows[0].approved_at).getFullYear()).toBeGreaterThan(2020);
  });

  it("一般スタッフは編集中の下書きの本文を直せる（通常業務は止めない）", async () => {
    const id = await seed("editing");
    await as("staff");
    await db.query(`update social_channel_drafts set edited_body = '直した本文' where id = $1`, [
      id,
    ]);
    const after = await db.query<{ edited_body: string }>(
      `select edited_body from social_channel_drafts where id = $1`,
      [id],
    );
    expect(after.rows[0].edited_body).toBe("直した本文");
  });

  it("確認が必要な理由は消せない（追記だけできる）", async () => {
    const id = await seed("needs_review", ["個人名の可能性"]);
    await as("manager");
    await expect(
      db.query(`update social_channel_drafts set review_reasons = '{}' where id = $1`, [id]),
    ).rejects.toThrow(/追記のみ/);

    await db.query(
      `update social_channel_drafts
         set review_reasons = array['個人名の可能性', '文字数超過'] where id = $1`,
      [id],
    );
    const after = await db.query<{ review_reasons: string[] }>(
      `select review_reasons from social_channel_drafts where id = $1`,
      [id],
    );
    expect(after.rows[0].review_reasons).toHaveLength(2);
  });
});
