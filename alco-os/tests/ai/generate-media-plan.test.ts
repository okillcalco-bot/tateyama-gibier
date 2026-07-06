import { describe, it, expect } from "vitest";
import { generatePresentation, generateVideoPlan } from "@/ai/workflows/generate-media-plan";
import { approveDraft } from "@/domain/drafts/draft-service";
import { MockProvider } from "@/ai/providers/mock-provider";
import { InMemoryDb } from "../helpers/in-memory-db";

const ORG = "org-1";
const CTX = { organizationId: ORG, actorId: "user-1" };

const baseBrief = {
  title: "◯◯商工会 講演",
  target_audience: "行政職員・商工会会員",
  duration_minutes: 15,
  format: "講演",
  key_messages: "ジビエは地域資源。獣害は価値に変えられる。",
  source_material: "2025年度 捕獲頭数312頭、うち食肉利用率41%。",
  photo_filenames: ["kaitai.jpg", "satoyama.jpg"],
};

function makePresentation(photoFilenames: (string | null)[]) {
  return JSON.stringify({
    title: "獣害を地域の価値に",
    subtitle: "館山ジビエセンターの実践",
    total_minutes: 15,
    slides: photoFilenames.map((photo, i) => ({
      title: `スライド${i + 1}`,
      bullets: ["ポイント"],
      speaker_notes: "話す内容",
      minutes: 5,
      photo_filename: photo,
    })),
    key_message_recap: ["ジビエは地域資源"],
    qa_prep: ["Q: 衛生管理は? A: HACCP準拠"],
    missing_information: [],
  });
}

function makeVideoPlan(assetFilenames: (string | null)[]) {
  return JSON.stringify({
    title_candidates: ["【密着】猟師の一日"],
    description: "館山ジビエセンターの一日に密着。",
    tags: ["ジビエ", "館山"],
    target_duration_minutes: 10,
    script: assetFilenames.map((asset, i) => ({
      section: `カット${i + 1}`,
      narration: "ナレーション",
      seconds: 60,
      visual: "テロップ",
      asset_filename: asset,
    })),
    chapters: [{ time: "0:00", label: "オープニング" }],
    thumbnail_text: ["獣害→地域資源"],
    cta: "チャンネル登録をお願いします",
    missing_information: [],
  });
}

describe("generatePresentation / generateVideoPlan（素材の実在チェック強制）", () => {
  it("添付済みの写真のみ割り付けた構成はドラフト保存される", async () => {
    const db = new InMemoryDb();
    const provider = new MockProvider({
      generate_presentation: makePresentation(["kaitai.jpg", null]),
    });

    const result = await generatePresentation(
      { db, provider, organizationId: ORG, userId: "user-1" },
      baseBrief,
      { mediaProjectId: "proj-1" },
    );

    expect(result.output.slides).toHaveLength(2);
    const drafts = await db.findMany("generated_drafts", { status: "draft" });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].draft_type).toBe("presentation_outline");
  });

  it("添付していない写真名（捏造）を含む構成は保存拒否され、失敗が記録される", async () => {
    const db = new InMemoryDb();
    const provider = new MockProvider({
      generate_presentation: makePresentation(["sonzai-shinai.jpg"]),
    });

    await expect(
      generatePresentation({ db, provider, organizationId: ORG, userId: "user-1" }, baseBrief),
    ).rejects.toThrow();

    const failed = await db.findMany("ai_runs", { status: "failed" });
    expect(failed).toHaveLength(1);
    expect(String(failed[0].error)).toContain("sonzai-shinai.jpg");
    expect(await db.findMany("generated_drafts", {})).toHaveLength(0);
  });

  it("動画プランも同様に、実在しない素材名は保存拒否される", async () => {
    const db = new InMemoryDb();
    const provider = new MockProvider({
      generate_video_plan: makeVideoPlan(["kaitai.jpg", "nai-douga.mp4"]),
    });

    await expect(
      generateVideoPlan({ db, provider, organizationId: ORG, userId: "user-1" }, baseBrief),
    ).rejects.toThrow();
    expect(await db.findMany("generated_drafts", {})).toHaveLength(0);
  });

  it("承認すると media_projects.approved_content に確定保存され status が approved になる", async () => {
    const db = new InMemoryDb();
    const project = await db.insert("media_projects", {
      organization_id: ORG,
      kind: "presentation",
      title: baseBrief.title,
      status: "brief",
    });

    const provider = new MockProvider({
      generate_presentation: makePresentation(["satoyama.jpg"]),
    });
    await generatePresentation(
      { db, provider, organizationId: ORG, userId: "user-1" },
      baseBrief,
      { mediaProjectId: project.id as string },
    );

    const [draft] = await db.findMany("generated_drafts", { status: "draft" });
    const { createdRecords } = await approveDraft(db, CTX, draft.id as string);

    expect(createdRecords).toHaveLength(1);
    const updated = await db.findById("media_projects", project.id as string);
    expect(updated?.status).toBe("approved");
    expect(updated?.approved_content).toBeTruthy();

    // 承認の監査ログ + media_projects 更新の監査ログが残る
    const logs = await db.findMany("audit_logs", { table_name: "media_projects" });
    expect(logs).toHaveLength(1);
  });
});
