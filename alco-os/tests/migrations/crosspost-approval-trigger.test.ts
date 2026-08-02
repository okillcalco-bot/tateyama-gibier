import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * 0029 の承認まわりを**本物の PostgreSQL 上で**動かして確かめる。
 *
 * PGlite（WebAssembly の PostgreSQL）を使い、マイグレーションから
 * トリガー関数と2つのRPCの定義を**そのまま抜き出して**実行する。
 * SQL の文字列検査ではなく、実際に UPDATE が弾かれることを確かめる。
 *
 * Supabase 固有のもの（auth.uid() / can_approve() /
 * current_organization_id()）だけをスタブにしている。
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
const OTHER_SOURCE = "44444444-4444-4444-4444-444444444444";
const STAFF = "55555555-5555-5555-5555-555555555555";
const MANAGER = "66666666-6666-6666-6666-666666666666";
const APPROVAL_DRAFT = "77777777-7777-7777-7777-777777777777";

describe("0029 承認まわり（実DB）", () => {
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
        select nullif(current_setting('test.org', true), '')::uuid;
      $fn$;

      create table social_channel_drafts (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null,
        social_source_id uuid not null,
        channel_key text not null,
        created_by uuid,
        status text not null default 'draft',
        title text,
        ai_body text,
        edited_body text,
        approved_body text,
        hashtags text[] not null default '{}',
        cta text,
        link_guidance text,
        photo_order text[] not null default '{}',
        reject_reason text,
        approval_draft_id uuid,
        approved_by uuid,
        approved_at timestamptz,
        review_reasons text[] not null default '{}',
        review_acknowledged_by uuid,
        review_acknowledged_at timestamptz
      );

      create table generated_drafts (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid, draft_type text, source_table text, source_id uuid,
        title text, content jsonb, needs_human_review boolean, warnings text[],
        status text, reviewed_by uuid, reviewed_at timestamptz,
        applied_at timestamptz, created_by uuid
      );

      create table social_publications (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid, social_source_id uuid, social_channel_draft_id uuid,
        channel_key text, final_body text, posted_url text, posted_at timestamptz,
        result text, publisher text, approved_by uuid, approved_at timestamptz,
        posted_by uuid, created_by uuid
      );

      create table audit_logs (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid, actor_id uuid, action text, table_name text,
        record_id uuid, after jsonb, note text
      );
    `);

    // 0029 の定義を、書かれているまま流し込む
    await db.exec(extractFunction(sql, "alco_social_enforce_approval()"));
    await db.exec(`
      create trigger trg_social_channel_drafts_approval
        before update on social_channel_drafts
        for each row execute function alco_social_enforce_approval();
    `);
    await db.exec(extractFunction(sql, "alco_crosspost_approve("));
    await db.exec(extractFunction(sql, "alco_crosspost_record_publication("));
  });

  afterAll(async () => {
    await db?.close();
  });

  /** 権限を切り替える（owner/manager か、一般スタッフか） */
  async function as(role: "staff" | "manager") {
    await db.exec(
      `select set_config('test.approver', '${role === "manager" ? "on" : "off"}', false),
              set_config('test.uid', '${role === "manager" ? MANAGER : STAFF}', false),
              set_config('test.org', '${ORG}', false);`,
    );
  }

  /** 指定した状態の下書きを1件用意する（UPDATEトリガーを通さずに作る） */
  async function seed(status: string, reasons: string[] = []): Promise<string> {
    const approved = status === "approved" || status === "published" || status === "queued";
    const res = await db.query<{ id: string }>(
      `insert into social_channel_drafts
         (organization_id, social_source_id, channel_key, created_by, status,
          ai_body, edited_body, approved_body, approval_draft_id,
          approved_by, approved_at, review_reasons)
       values ($1, gen_random_uuid(), 'instagram', $2, $3, 'AIの本文', '直した本文',
               $4, $5, $6, $7, $8)
       returning id`,
      [
        ORG,
        STAFF,
        status,
        approved ? "承認済みの本文" : null,
        approved ? APPROVAL_DRAFT : null,
        approved ? MANAGER : null,
        approved ? new Date().toISOString() : null,
        reasons,
      ],
    );
    return res.rows[0].id;
  }

  async function statusOf(id: string): Promise<string> {
    const r = await db.query<{ status: string }>(
      `select status from social_channel_drafts where id = $1`,
      [id],
    );
    return r.rows[0].status;
  }

  // ────────── 唯一の承認経路（4巡目の指摘） ──────────

  it("owner/manager でも直接 UPDATE で draft → approved にはできない", async () => {
    const id = await seed("editing");
    await as("manager");
    await expect(
      db.query(
        `update social_channel_drafts
           set status = 'approved', approved_body = '勝手に承認した本文',
               approval_draft_id = $2
         where id = $1`,
        [id, APPROVAL_DRAFT],
      ),
    ).rejects.toThrow(/alco_crosspost_approve\(\) からのみ/);
    expect(await statusOf(id)).toBe("editing");
  });

  it("owner/manager でも承認済みの本文を直接書き換えられない", async () => {
    const id = await seed("approved");
    await as("manager");
    await expect(
      db.query(`update social_channel_drafts set approved_body = 'すり替えた本文' where id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/直接書き換えられません/);

    const after = await db.query<{ approved_body: string }>(
      `select approved_body from social_channel_drafts where id = $1`,
      [id],
    );
    expect(after.rows[0].approved_body).toBe("承認済みの本文");
  });

  it("owner/manager でも直接 UPDATE で approved → published にはできない", async () => {
    const id = await seed("approved");
    await as("manager");
    await expect(
      db.query(`update social_channel_drafts set status = 'published' where id = $1`, [id]),
    ).rejects.toThrow(/alco_crosspost_record_publication\(\) からのみ/);
    expect(await statusOf(id)).toBe("approved");
  });

  it("承認の印は同じトランザクションでも残らない（RPCの外では使えない）", async () => {
    const id = await seed("editing");
    const target = await seed("editing");
    await as("manager");

    // 1つのトランザクションの中で、承認RPC → 別の下書きを直接承認、を試す
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`select alco_crosspost_approve($1, $2, false)`, [id, "確定した本文"]);
        await tx.query(
          `update social_channel_drafts
             set status = 'approved', approved_body = 'ついでに承認', approval_draft_id = $2
           where id = $1`,
          [target, APPROVAL_DRAFT],
        );
      }),
    ).rejects.toThrow(/alco_crosspost_approve\(\) からのみ/);
    expect(await statusOf(target)).toBe("editing");
  });

  it("承認RPC経由なら承認できる（証跡と監査ログも残る）", async () => {
    const id = await seed("editing");
    await as("manager");
    await db.query(`select alco_crosspost_approve($1, $2, false)`, [id, "確定した本文"]);

    const draft = await db.query<{
      status: string;
      approved_body: string;
      approval_draft_id: string;
      approved_by: string;
    }>(
      `select status, approved_body, approval_draft_id, approved_by
         from social_channel_drafts where id = $1`,
      [id],
    );
    expect(draft.rows[0].status).toBe("approved");
    expect(draft.rows[0].approved_body).toBe("確定した本文");
    expect(draft.rows[0].approval_draft_id).not.toBeNull();
    expect(draft.rows[0].approved_by).toBe(MANAGER);

    // 承認証跡（generated_drafts）
    const snap = await db.query<{ draft_type: string; content: { body: string } }>(
      `select draft_type, content from generated_drafts where id = $1`,
      [draft.rows[0].approval_draft_id],
    );
    expect(snap.rows[0].draft_type).toBe("crosspost_approval");
    expect(snap.rows[0].content.body).toBe("確定した本文");

    // 監査ログ
    const log = await db.query<{ action: string }>(
      `select action from audit_logs where record_id = $1 and action = 'approve'`,
      [id],
    );
    expect(log.rows).toHaveLength(1);
  });

  it("一般スタッフは承認RPCを呼んでも承認できない", async () => {
    const id = await seed("editing");
    await as("staff");
    await expect(
      db.query(`select alco_crosspost_approve($1, $2, false)`, [id, "確定した本文"]),
    ).rejects.toThrow(/承認権限/);
  });

  it("投稿済み登録RPC経由なら published にできる（履歴と監査ログも残る）", async () => {
    const id = await seed("editing");
    await as("manager");
    await db.query(`select alco_crosspost_approve($1, $2, false)`, [id, "確定した本文"]);
    await db.query(`select alco_crosspost_record_publication($1, $2, null)`, [
      id,
      "https://example.com/p/1",
    ]);

    expect(await statusOf(id)).toBe("published");
    const pub = await db.query<{ final_body: string; posted_url: string; result: string }>(
      `select final_body, posted_url, result from social_publications
        where social_channel_draft_id = $1`,
      [id],
    );
    expect(pub.rows[0].final_body).toBe("確定した本文");
    expect(pub.rows[0].posted_url).toBe("https://example.com/p/1");
    expect(pub.rows[0].result).toBe("success");

    const log = await db.query(
      `select 1 from audit_logs where table_name = 'social_publications'`,
    );
    expect(log.rows.length).toBeGreaterThan(0);
  });

  it("承認していない下書きは投稿済み登録RPCでも弾かれる", async () => {
    const id = await seed("editing");
    await as("manager");
    await expect(
      db.query(`select alco_crosspost_record_publication($1, null, null)`, [id]),
    ).rejects.toThrow(/承認していない/);
  });

  // ────────── 状態の逆方向と識別列（3巡目の指摘） ──────────

  it("一般スタッフは approved → editing にできない", async () => {
    const id = await seed("approved");
    await as("staff");
    await expect(
      db.query(`update social_channel_drafts set status = 'editing' where id = $1`, [id]),
    ).rejects.toThrow(/承認権限/);
    expect(await statusOf(id)).toBe("approved");
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

  // ────────── 差し戻し・却下 ──────────

  it("owner/manager の差し戻しは通り、承認関連の列がすべて空に戻る", async () => {
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
      approval_draft_id: string | null;
    }>(
      `select status, approved_by, approved_at, approved_body, approval_draft_id
         from social_channel_drafts where id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe("editing");
    expect(after.rows[0].approved_by).toBeNull();
    expect(after.rows[0].approved_at).toBeNull();
    expect(after.rows[0].approved_body).toBeNull();
    expect(after.rows[0].approval_draft_id).toBeNull();
  });

  it("却下でも承認関連の列が空に戻る（本文を書き換えなくてよい）", async () => {
    const id = await seed("approved");
    await as("manager");
    await db.query(
      `update social_channel_drafts set status = 'rejected', reject_reason = '事実誤り'
       where id = $1`,
      [id],
    );
    const after = await db.query<{ approved_body: string | null; approval_draft_id: string | null }>(
      `select approved_body, approval_draft_id from social_channel_drafts where id = $1`,
      [id],
    );
    expect(after.rows[0].approved_body).toBeNull();
    expect(after.rows[0].approval_draft_id).toBeNull();
  });

  it("差し戻し後は承認RPCでもう一度承認できる", async () => {
    const id = await seed("editing");
    await as("manager");
    await db.query(`select alco_crosspost_approve($1, $2, false)`, [id, "1回目の本文"]);
    await db.query(
      `update social_channel_drafts set status = 'editing', approved_body = null,
              approval_draft_id = null where id = $1`,
      [id],
    );
    await db.query(`select alco_crosspost_approve($1, $2, false)`, [id, "2回目の本文"]);

    const after = await db.query<{ approved_body: string }>(
      `select approved_body from social_channel_drafts where id = $1`,
      [id],
    );
    expect(after.rows[0].approved_body).toBe("2回目の本文");
    // 証跡は2件とも残る
    const snaps = await db.query(
      `select 1 from generated_drafts where source_id = $1 and draft_type = 'crosspost_approval'`,
      [id],
    );
    expect(snaps.rows).toHaveLength(2);
  });

  // ────────── 通常業務と確認理由 ──────────

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

  it("要確認の理由がある下書きは確認せずに承認できない", async () => {
    const id = await seed("needs_review", ["個人名の可能性"]);
    await as("manager");
    await expect(
      db.query(`select alco_crosspost_approve($1, $2, false)`, [id, "確定した本文"]),
    ).rejects.toThrow(/確認してから承認/);

    await db.query(`select alco_crosspost_approve($1, $2, true)`, [id, "確定した本文"]);
    const after = await db.query<{ status: string; review_acknowledged_by: string }>(
      `select status, review_acknowledged_by from social_channel_drafts where id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe("approved");
    expect(after.rows[0].review_acknowledged_by).toBe(MANAGER);
    // 理由は承認後も残る
    const reasons = await db.query<{ review_reasons: string[] }>(
      `select review_reasons from social_channel_drafts where id = $1`,
      [id],
    );
    expect(reasons.rows[0].review_reasons).toEqual(["個人名の可能性"]);
  });
});
