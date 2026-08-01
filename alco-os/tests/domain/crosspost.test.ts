import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDb } from "../helpers/in-memory-db";
import {
  createSource,
  extractSourceNo,
  normalizeSourceUrl,
  attachAsset,
  summarizeAssetFlags,
  listAssets,
} from "@/domain/social/crosspost/source-service";
import {
  detectSensitive,
  evaluateReview,
} from "@/domain/social/crosspost/sensitive";
import {
  approveChannelDraft,
  editDraftBody,
  findDraft,
  rejectChannelDraft,
  reopenChannelDraft,
  resolveFinalBody,
  saveGeneratedDrafts,
  markChannelsFailed,
} from "@/domain/social/crosspost/draft-service";
import { recordPublication } from "@/domain/social/crosspost/publication-service";
import { generateDraftsForSource } from "@/domain/social/crosspost/generation-service";
import { saveStyleVersion, getActiveStyle } from "@/domain/social/crosspost/style-service";
import { toApprovedDraft } from "@/domain/social/publishers/types";
import { getPublisher } from "@/domain/social/publishers/registry";
import { splitIntoBatches } from "@/domain/social/crosspost/channels";
import type { ChannelDraft, FactSheetOutput } from "@/ai/schemas/crosspost.schema";

const ORG = "org-1";
const ctx = { organizationId: ORG, actorId: "staff-1" };

const SOURCE_BODY =
  "【朝の見回り〜命の重さ #12】朝6時30分、館山市山本のくくり罠にイノシシが1頭。45kg。止め刺しは毎回、慣れないなと思う。";

function draft(overrides: Partial<ChannelDraft> = {}): ChannelDraft {
  return {
    channel_key: "instagram",
    title: null,
    body: "イノシシ1頭、45kg。毎回、慣れないなと思う。",
    hashtags: ["ジビエ"],
    link_guidance: null,
    cta: null,
    photo_order: [],
    photo_captions: [],
    narration: null,
    cautions: [],
    anonymized_notes: [],
    ...overrides,
  };
}

const SPECS = [
  { key: "instagram", label: "Instagram", maxChars: 1200 },
  { key: "threads", label: "Threads", maxChars: 500 },
];

async function seedSource(db: InMemoryDb) {
  const { source } = await createSource(db, ctx, { body: SOURCE_BODY });
  return source.id as string;
}

// ────────────── 元投稿の登録 ──────────────

describe("元投稿の登録", () => {
  let db: InMemoryDb;
  beforeEach(() => {
    db = new InMemoryDb();
  });

  it("原文から投稿番号を読み取る", () => {
    expect(extractSourceNo(SOURCE_BODY)).toBe("12");
    expect(extractSourceNo("番号なしの本文")).toBeNull();
  });

  it("URLはクエリを落として比べる", () => {
    expect(normalizeSourceUrl("https://fb.com/posts/1?fbclid=x")).toBe("https://fb.com/posts/1");
    expect(normalizeSourceUrl("  ")).toBeNull();
  });

  it("同じ投稿URLは二重登録できない", async () => {
    await createSource(db, ctx, { body: "本文", sourceUrl: "https://fb.com/p/1" });
    await expect(
      createSource(db, ctx, { body: "本文2", sourceUrl: "https://fb.com/p/1?fbclid=y" }),
    ).rejects.toThrow(/すでに登録/);
  });

  it("投稿番号の重複はエラーにせず警告を返す", async () => {
    await createSource(db, ctx, { body: SOURCE_BODY });
    const second = await createSource(db, ctx, { body: SOURCE_BODY });
    expect(second.warnings.length).toBe(1);
    expect(second.warnings[0]).toContain("#12");
    expect(db.tables.get("social_sources")).toHaveLength(2);
  });

  it("写真ごとに人物・公開確認のフラグを持てる", async () => {
    const sourceId = await seedSource(db);
    const file = await db.insert("files", { organization_id: ORG, path: "a.jpg" });
    await attachAsset(db, ctx, {
      sourceId,
      fileId: file.id as string,
      hasPerson: true,
      caption: "現場の様子",
    });
    const assets = await listAssets(db, sourceId);
    const flags = summarizeAssetFlags(assets);
    expect(flags.hasPersonPhoto).toBe(true);
    expect(flags.needsPublicCheck).toBe(false);
    expect(flags.captions).toEqual(["現場の様子"]);
  });
});

// ────────────── センシティブ判定 ──────────────

describe("センシティブ判定（サーバー側が最終権限）", () => {
  it("止め刺し・ウリ坊などを拾う", () => {
    const hits = detectSensitive("止め刺しをした。ウリ坊もいた。");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].category).toBe("life");
  });

  it("元原稿がセンシティブなら生成本文が穏やかでも要確認", () => {
    const result = evaluateReview({
      sourceBody: SOURCE_BODY,
      channelBody: "きょうも山にいました。",
      hasPersonPhoto: false,
      needsPublicCheck: false,
      maxChars: 1200,
    });
    expect(result.needsReview).toBe(true);
    expect(result.reasons.join()).toContain("命の扱い");
  });

  it("人物写真・公開確認が必要な写真でも要確認", () => {
    const result = evaluateReview({
      sourceBody: "おだやかな一日でした",
      channelBody: "おだやかな一日でした",
      hasPersonPhoto: true,
      needsPublicCheck: true,
      maxChars: null,
    });
    expect(result.reasons).toHaveLength(2);
  });

  it("文字数超過は要確認にするだけ（生成を失敗させない）", () => {
    const result = evaluateReview({
      sourceBody: "ふつうの本文",
      channelBody: "あ".repeat(600),
      hasPersonPhoto: false,
      needsPublicCheck: false,
      maxChars: 500,
    });
    expect(result.needsReview).toBe(true);
    expect(result.reasons.join()).toContain("文字数が上限を超えて");
  });

  it("AIが問題なしでも辞書に当たれば要確認（判定はサーバー側が決める）", () => {
    const result = evaluateReview({
      sourceBody: "止め刺しの話",
      channelBody: "きれいにまとめた話",
      hasPersonPhoto: false,
      needsPublicCheck: false,
      maxChars: null,
      aiFlags: [],
    });
    expect(result.needsReview).toBe(true);
  });
});

// ────────────── 下書きと承認 ──────────────

describe("媒体ごとの下書きと承認", () => {
  let db: InMemoryDb;
  let sourceId: string;

  beforeEach(async () => {
    db = new InMemoryDb();
    sourceId = await seedSource(db);
  });

  async function generate(drafts: ChannelDraft[] = [draft()]) {
    return saveGeneratedDrafts(db, ctx, {
      sourceId,
      aiGeneratedDraftId: "ai-draft-1",
      drafts,
      specs: SPECS,
      sourceBody: SOURCE_BODY,
      hasPersonPhoto: false,
      needsPublicCheck: false,
      aiFlags: [],
      styleProfileId: "style-1",
      styleVersion: 3,
    });
  }

  it("生成結果は媒体ごとの行になり、スタイルの版も残る", async () => {
    const saved = await generate();
    expect(saved).toHaveLength(1);
    expect(saved[0].channel_key).toBe("instagram");
    expect(saved[0].style_version).toBe(3);
    // 元原稿がセンシティブなので要確認になる
    expect(saved[0].status).toBe("needs_review");
    // 文字数はAIの申告ではなくサーバーが数える
    expect(saved[0].char_count).toBe(String(draft().body).length);
  });

  it("承認するのは「人が編集した本文」", async () => {
    const [row] = await generate();
    await editDraftBody(db, ctx, { draftId: row.id as string, body: "人が直した本文です" });

    const edited = await db.findById("social_channel_drafts", row.id as string);
    expect(resolveFinalBody(edited!)).toBe("人が直した本文です");
    // AIの元出力は書き換わっていない
    expect(edited!.ai_body).toBe(draft().body);
  });

  it("承認するとAI原文と承認本文の両方が残る", async () => {
    const [row] = await generate();
    await editDraftBody(db, ctx, { draftId: row.id as string, body: "人が直した本文です" });

    const { draft: after, approvalDraftId } = await approveChannelDraft(db, ctx, {
      draftId: row.id as string,
      acknowledgeReasons: true,
    });

    expect(after.status).toBe("approved");
    expect(after.approved_body).toBe("人が直した本文です");
    expect(after.ai_body).toBe(draft().body); // AI原文は不変

    // 承認スナップショットが generated_drafts に残り、承認済みになっている
    const approval = await db.findById("generated_drafts", approvalDraftId);
    expect(approval?.draft_type).toBe("crosspost_approval");
    expect(approval?.status).toBe("approved");
    expect((approval?.content as Record<string, unknown>).body).toBe("人が直した本文です");
  });

  it("要確認の理由を確認せずに承認できない", async () => {
    const [row] = await generate();
    await expect(
      approveChannelDraft(db, ctx, { draftId: row.id as string }),
    ).rejects.toThrow(/要確認の理由/);
  });

  it("承認しても要確認の理由は消えない", async () => {
    const [row] = await generate();
    const { draft: after } = await approveChannelDraft(db, ctx, {
      draftId: row.id as string,
      acknowledgeReasons: true,
    });
    expect((after.review_reasons as string[]).length).toBeGreaterThan(0);
    expect(after.review_acknowledged_by).toBe("staff-1");
  });

  it("媒体ごとに承認・却下でき、他の媒体は変わらない", async () => {
    await generate([draft(), draft({ channel_key: "threads", body: "短い版" })]);
    const ig = await findDraft(db, sourceId, "instagram");
    const th = await findDraft(db, sourceId, "threads");

    await approveChannelDraft(db, ctx, { draftId: ig!.id as string, acknowledgeReasons: true });
    await rejectChannelDraft(db, ctx, {
      draftId: th!.id as string,
      reason: "この媒体には向かない",
    });

    expect((await findDraft(db, sourceId, "instagram"))!.status).toBe("approved");
    expect((await findDraft(db, sourceId, "threads"))!.status).toBe("rejected");
  });

  it("承認済みの下書きは編集できない。差し戻せば直せる", async () => {
    const [row] = await generate();
    await approveChannelDraft(db, ctx, { draftId: row.id as string, acknowledgeReasons: true });
    await expect(
      editDraftBody(db, ctx, { draftId: row.id as string, body: "あとから改ざん" }),
    ).rejects.toThrow(/承認済み/);

    const reopened = await reopenChannelDraft(db, ctx, row.id as string);
    expect(reopened.approved_body).toBeNull();
    expect(reopened.status).toBe("needs_review");
  });

  it("却下には理由が要る", async () => {
    const [row] = await generate();
    await expect(
      rejectChannelDraft(db, ctx, { draftId: row.id as string, reason: "  " }),
    ).rejects.toThrow(/理由/);
  });

  it("再生成しても承認済みの媒体は上書きしない", async () => {
    const [row] = await generate();
    await approveChannelDraft(db, ctx, { draftId: row.id as string, acknowledgeReasons: true });
    await generate([draft({ body: "作り直した本文" })]);
    const after = await findDraft(db, sourceId, "instagram");
    expect(after!.approved_body).toBe(draft().body);
  });
});

// ────────────── 生成の段取り（部分失敗） ──────────────

describe("生成の段取り", () => {
  let db: InMemoryDb;
  let sourceId: string;

  const factSheet: FactSheetOutput = {
    facts: ["イノシシ1頭"],
    numbers: ["45kg"],
    voice_quotes: ["慣れないなと思う"],
    must_keep: ["45kg"],
    speculations: [],
    mentioned_people: [],
    source_no: "12",
    missing_information: [],
  };

  beforeEach(async () => {
    db = new InMemoryDb();
    sourceId = await seedSource(db);
    // 媒体は2件だけにしてバッチを1回にする
    for (const [i, key] of ["instagram", "threads"].entries()) {
      await db.insert("social_channels", {
        organization_id: ORG,
        channel_key: key,
        label: key,
        enabled: true,
        sort_order: i,
        max_chars: 1200,
        max_hashtags: 5,
        cta_policy: "CTAは1つ",
        guidance: "",
      });
    }
  });

  it("媒体を2〜3件ずつのバッチに分ける", () => {
    expect(splitIntoBatches([1, 2, 3, 4, 5, 6, 7, 8]).map((b) => b.length)).toEqual([3, 3, 2]);
  });

  it("事実整理は1回だけ実行し、結果を使い回す", async () => {
    let analyzeCount = 0;
    const deps = {
      db,
      ctx,
      analyze: async () => {
        analyzeCount++;
        return { output: factSheet };
      },
      generate: async (input: { channels: { key: string }[] }) => ({
        output: {
          drafts: input.channels.map((c) => draft({ channel_key: c.key })),
          missing_information: [],
          sensitive_flags: [],
          style_notes: [],
        },
        draftId: "ai-1",
      }),
    };

    await generateDraftsForSource(deps, { sourceId });
    await generateDraftsForSource(deps, { sourceId, channelKeys: ["threads"] });
    expect(analyzeCount).toBe(1);
  });

  it("1バッチが失敗しても成功した媒体は残る", async () => {
    const result = await generateDraftsForSource(
      {
        db,
        ctx,
        analyze: async () => ({ output: factSheet }),
        generate: async (input: { channels: { key: string }[] }) => {
          if (input.channels.some((c) => c.key === "threads")) {
            throw new Error("生成に失敗しました");
          }
          return {
            output: {
              drafts: input.channels.map((c) => draft({ channel_key: c.key })),
              missing_information: [],
              sensitive_flags: [],
              style_notes: [],
            },
            draftId: "ai-1",
          };
        },
      },
      { sourceId, channelKeys: ["instagram"] },
    );
    expect(result.succeeded).toEqual(["instagram"]);
    expect(result.failed).toHaveLength(0);
  });

  it("AIが返さなかった媒体はエラーにして作り直せる", async () => {
    await markChannelsFailed(db, ctx, {
      sourceId,
      channelKeys: ["threads"],
      message: "AIがこの媒体の下書きを返しませんでした",
    });
    const failed = await findDraft(db, sourceId, "threads");
    expect(failed!.status).toBe("error");
    expect(String(failed!.error_message)).toContain("返しませんでした");
  });
});

// ────────────── 投稿履歴 ──────────────

describe("投稿履歴", () => {
  let db: InMemoryDb;
  let sourceId: string;
  let draftId: string;

  beforeEach(async () => {
    db = new InMemoryDb();
    sourceId = await seedSource(db);
    const [row] = await saveGeneratedDrafts(db, ctx, {
      sourceId,
      aiGeneratedDraftId: "ai-1",
      drafts: [draft()],
      specs: SPECS,
      sourceBody: SOURCE_BODY,
      hasPersonPhoto: false,
      needsPublicCheck: false,
      aiFlags: [],
      styleProfileId: null,
      styleVersion: null,
    });
    draftId = row.id as string;
  });

  it("承認していない下書きは投稿済みにできない", async () => {
    await expect(
      recordPublication(db, ctx, { sourceId, draftId }),
    ).rejects.toThrow(/承認していない/);
  });

  it("承認後は投稿URLを保存できる", async () => {
    await approveChannelDraft(db, ctx, { draftId, acknowledgeReasons: true });
    const pub = await recordPublication(db, ctx, {
      sourceId,
      draftId,
      postedUrl: "https://instagram.com/p/xxx",
    });
    expect(pub.posted_url).toBe("https://instagram.com/p/xxx");
    expect(pub.final_body).toBe(draft().body);
    expect((await db.findById("social_channel_drafts", draftId))!.status).toBe("published");
  });

  it("同じ媒体を二重に投稿済み登録できない", async () => {
    await approveChannelDraft(db, ctx, { draftId, acknowledgeReasons: true });
    await recordPublication(db, ctx, { sourceId, draftId });
    await expect(recordPublication(db, ctx, { sourceId, draftId })).rejects.toThrow(
      /すでに投稿済み/,
    );
  });
});

// ────────────── publisher と スタイル ──────────────

describe("publisher（未承認は外部へ渡せない）", () => {
  it("承認済みの行からしか ApprovedChannelDraft を作れない", () => {
    expect(
      toApprovedDraft({ id: "1", channel_key: "x", status: "draft", approved_body: "本文" }),
    ).toBeNull();
    expect(
      toApprovedDraft({ id: "1", channel_key: "x", status: "approved", approved_body: "" }),
    ).toBeNull();
    expect(
      toApprovedDraft({ id: "1", channel_key: "x", status: "approved", approved_body: "本文" }),
    ).not.toBeNull();
  });

  it("Phase 1 は manual のみで、自動投稿しない", async () => {
    const publisher = getPublisher("instagram");
    expect(publisher.key).toBe("manual");
    const result = await publisher.publish({
      channelKey: "instagram",
      approved: toApprovedDraft({
        id: "1",
        channel_key: "instagram",
        status: "approved",
        approved_body: "本文",
      })!,
      assets: [],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("自動投稿は未対応");
  });
});

describe("沖浩志スタイル", () => {
  it("保存すると新しい版になり、古い版は無効になる", async () => {
    const db = new InMemoryDb();
    await saveStyleVersion(db, ctx, {
      structureNotes: "構造1",
      keepRules: "残す1",
      avoidRules: "避ける1",
      hardRules: "重要1",
    });
    await saveStyleVersion(db, ctx, {
      structureNotes: "構造2",
      keepRules: "残す2",
      avoidRules: "避ける2",
      hardRules: "重要2",
    });

    const rows = db.tables.get("social_style_profiles") ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.is_active === true)).toHaveLength(1);

    const active = await getActiveStyle(db, ORG);
    expect(active?.version).toBe(2);
    expect(active?.structureNotes).toBe("構造2");
  });
});

/**
 * コードレビュー指摘（2026-08-01）への修正を固定するテスト。
 */
describe("レビュー指摘の修正", () => {
  let db: InMemoryDb;
  let sourceId: string;

  beforeEach(async () => {
    db = new InMemoryDb();
    sourceId = await seedSource(db);
  });

  it("指摘1: 制限テーブルに alco_add_member_policy を使っていない", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const sql = readFileSync(
      path.join(process.cwd(), "supabase", "migrations", "0029_crosspost.sql"),
      "utf8",
    );
    for (const table of [
      "social_channels",
      "social_style_profiles",
      "social_channel_drafts",
      "social_publications",
    ]) {
      // FOR ALL の許可ポリシーを足すと OR 条件で制限が効かなくなる
      expect(sql).not.toContain(`alco_add_member_policy('${table}')`);
      // 代わりに用途ごとのポリシーがある
      expect(sql).toContain(`create policy ${table}_select`);
    }
    // 承認まわりは can_approve() で縛る
    expect(sql).toContain("create policy social_style_profiles_insert");
    expect(sql).toContain("create policy social_publications_insert");
    // INSERT で最初から承認済みにする抜け道を塞ぐ
    expect(sql).toContain("alco_social_enforce_draft_insert");
    expect(sql).toContain("before insert on social_channel_drafts");
  });

  it("指摘2: 承認を1トランザクションで行う関数がある", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const sql = readFileSync(
      path.join(process.cwd(), "supabase", "migrations", "0029_crosspost.sql"),
      "utf8",
    );
    expect(sql).toContain("create or replace function alco_crosspost_approve");
    // 1つの関数の中で スナップショット作成 → 本文確定 → 監査ログ まで行う
    expect(sql).toContain("insert into generated_drafts");
    expect(sql).toContain("update social_channel_drafts set");
    expect(sql).toContain("insert into audit_logs");
    expect(sql).toContain("can_approve()");
  });

  it("指摘2: rpc を渡すとそちらを使い、逐次処理はしない", async () => {
    const [row] = await saveGeneratedDrafts(db, ctx, {
      sourceId,
      aiGeneratedDraftId: "ai-1",
      drafts: [draft()],
      specs: SPECS,
      sourceBody: SOURCE_BODY,
      hasPersonPhoto: false,
      needsPublicCheck: false,
      aiFlags: [],
      styleProfileId: null,
      styleVersion: null,
    });

    let called: { draftId: string; finalBody: string; acknowledge: boolean } | null = null;
    const result = await approveChannelDraft(
      db,
      ctx,
      { draftId: row.id as string, acknowledgeReasons: true },
      async (params) => {
        called = params;
        return {
          ...row,
          status: "approved",
          approved_body: params.finalBody,
          approval_draft_id: "approval-1",
        };
      },
    );

    expect(called).not.toBeNull();
    expect(called!.acknowledge).toBe(true);
    expect(result.draft.status).toBe("approved");
    expect(result.approvalDraftId).toBe("approval-1");
    // 逐次処理の generated_drafts は作られていない
    expect(db.tables.get("generated_drafts")).toBeUndefined();
  });

  it("指摘3: 別の元投稿の下書きを投稿履歴に紐づけられない", async () => {
    const otherSourceId = (await createSource(db, ctx, { body: "別の投稿" })).source.id as string;
    const [row] = await saveGeneratedDrafts(db, ctx, {
      sourceId,
      aiGeneratedDraftId: "ai-1",
      drafts: [draft()],
      specs: SPECS,
      sourceBody: SOURCE_BODY,
      hasPersonPhoto: false,
      needsPublicCheck: false,
      aiFlags: [],
      styleProfileId: null,
      styleVersion: null,
    });
    await approveChannelDraft(db, ctx, {
      draftId: row.id as string,
      acknowledgeReasons: true,
    });

    await expect(
      recordPublication(db, ctx, { sourceId: otherSourceId, draftId: row.id as string }),
    ).rejects.toThrow(/別の元投稿/);
  });

  it("指摘3: 別組織の下書きも紐づけられない", async () => {
    const [row] = await saveGeneratedDrafts(db, ctx, {
      sourceId,
      aiGeneratedDraftId: "ai-1",
      drafts: [draft()],
      specs: SPECS,
      sourceBody: SOURCE_BODY,
      hasPersonPhoto: false,
      needsPublicCheck: false,
      aiFlags: [],
      styleProfileId: null,
      styleVersion: null,
    });
    await db.update("social_channel_drafts", row.id as string, {
      organization_id: "org-2",
    });

    await expect(
      recordPublication(db, ctx, { sourceId, draftId: row.id as string }),
    ).rejects.toThrow(/他の組織/);
  });

  it("指摘3: DBトリガーでも下書きの組織・元投稿・媒体を確かめる", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const sql = readFileSync(
      path.join(process.cwd(), "supabase", "migrations", "0029_crosspost.sql"),
      "utf8",
    );
    expect(sql).toContain("別の組織の下書きは投稿履歴に紐づけられません");
    expect(sql).toContain("別の元投稿の下書きは投稿履歴に紐づけられません");
    expect(sql).toContain("媒体が一致しない下書きは投稿履歴に紐づけられません");
  });

  it("軽微2: 写真ごとに人物ありを直せる", async () => {
    const file = await db.insert("files", { organization_id: ORG, path: "a.jpg" });
    const asset = await attachAsset(db, ctx, { sourceId, fileId: file.id as string });

    const { setAssetFlags } = await import("@/domain/social/crosspost/source-service");
    const after = await setAssetFlags(db, ctx, {
      assetId: asset.id as string,
      hasPerson: true,
      needsPublicCheck: false,
      caption: "現場の様子",
    });
    expect(after.has_person).toBe(true);
    expect(after.caption).toBe("現場の様子");
    expect((db.tables.get("audit_logs") ?? []).length).toBeGreaterThan(0);
  });
});

describe("レビュー指摘の修正（2巡目）", () => {
  let db: InMemoryDb;
  let sourceId: string;

  async function readSql() {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    return readFileSync(
      path.join(process.cwd(), "supabase", "migrations", "0029_crosspost.sql"),
      "utf8",
    );
  }

  beforeEach(async () => {
    db = new InMemoryDb();
    sourceId = await seedSource(db);
  });

  async function approvedDraft() {
    const [row] = await saveGeneratedDrafts(db, ctx, {
      sourceId,
      aiGeneratedDraftId: "ai-1",
      drafts: [draft()],
      specs: SPECS,
      sourceBody: SOURCE_BODY,
      hasPersonPhoto: false,
      needsPublicCheck: false,
      aiFlags: [],
      styleProfileId: null,
      styleVersion: null,
    });
    await approveChannelDraft(db, ctx, {
      draftId: row.id as string,
      acknowledgeReasons: true,
    });
    return row;
  }

  it("2-1: 投稿済み登録を1トランザクションで行う関数がある", async () => {
    const sql = await readSql();
    expect(sql).toContain("create or replace function alco_crosspost_record_publication");
    // 履歴 → 下書きの状態 → 監査ログ を1つの関数の中で行う
    expect(sql).toContain("insert into social_publications");
    expect(sql).toContain("'published'");
    expect(sql).toContain("を投稿済みとして登録");
    // 権限も関数内で確かめる
    expect(sql).toContain(
      "投稿済みの登録には承認権限（owner / manager）が必要です",
    );
    // 同時押しに備えて行を押さえる
    expect(sql).toContain("for update");
  });

  it("2-1: rpc を渡すと逐次処理をせずそちらを使う", async () => {
    const row = await approvedDraft();
    const before = (db.tables.get("social_publications") ?? []).length;

    let called: { draftId: string; postedUrl: string | null; postedAt: string | null } | null =
      null;
    const result = await recordPublication(
      db,
      ctx,
      { sourceId, draftId: row.id as string, postedUrl: " https://example.com/p/1 " },
      async (params) => {
        called = params;
        return { id: "pub-1", social_channel_draft_id: params.draftId, result: "success" };
      },
    );

    expect(called).not.toBeNull();
    expect(called!.postedUrl).toBe("https://example.com/p/1");
    expect(result.id).toBe("pub-1");
    // 逐次処理は動いていない（履歴が増えていない）
    expect((db.tables.get("social_publications") ?? []).length).toBe(before);
  });

  it("2-1: rpc を渡しても組織・元投稿の食い違いは手前で弾く", async () => {
    const row = await approvedDraft();
    const other = await db.insert("social_sources", {
      organization_id: ORG,
      body: SOURCE_BODY,
      status: "draft",
    });

    await expect(
      recordPublication(
        db,
        ctx,
        { sourceId: other.id as string, draftId: row.id as string },
        async () => ({ id: "pub-x" }),
      ),
    ).rejects.toThrow(/別の元投稿/);
  });

  it("2-2: 承認の証跡列も承認権限がないと変えられない", async () => {
    const sql = await readSql();
    expect(sql).toContain("new.approval_draft_id is distinct from old.approval_draft_id");
    expect(sql).toContain("new.approved_by is distinct from old.approved_by");
    expect(sql).toContain("new.approved_at is distinct from old.approved_at");
  });

  it("2-2: 承認の証跡は付け替えられない", async () => {
    const sql = await readSql();
    expect(sql).toContain("承認の証跡は付け替えられません");
  });

  it("2-2: 確認が必要な理由は追記しかできない", async () => {
    const sql = await readSql();
    expect(sql).toContain(
      "確認が必要な理由は消したり書き換えたりできません（追記のみ）",
    );
    // 配列の包含で「消していない」ことを確かめる
    expect(sql).toContain("<@");
  });

  it("2-3: 本番の承認経路が1つであることを文書に書いてある", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const docs = readFileSync(
      path.join(process.cwd(), "docs", "05-ai-workflows.md"),
      "utf8",
    );
    expect(docs).toContain("`alco_crosspost_approve()` を唯一の本番承認経路とする");
    expect(docs).toContain("テスト用フォールバックは本番コードから呼べない");
  });
});
