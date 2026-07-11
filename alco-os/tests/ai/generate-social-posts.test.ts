import { describe, it, expect } from "vitest";
import { generateSocialPosts } from "@/ai/workflows/generate-social-posts";
import { markChannelPosted } from "@/domain/social/social-service";
import { approveDraft } from "@/domain/drafts/draft-service";
import { MockProvider } from "@/ai/providers/mock-provider";
import { InMemoryDb } from "../helpers/in-memory-db";

const ORG = "org-1";
const CTX = { organizationId: ORG, actorId: "user-1" };

const brief = {
  title: "小学校でジビエ出前授業",
  source_kind: "memo",
  source_text: "今日は館山市内の小学校で出前授業。子どもたちがイノシシの革に興味津々だった。",
  channels: ["hp", "instagram"] as ("hp" | "instagram")[],
};

describe("generate_social_posts（投稿一括更新）", () => {
  it("生成 → 承認 → social_projects に確定保存 → 投稿済み管理まで一周する", async () => {
    const db = new InMemoryDb();
    const project = await db.insert("social_projects", {
      organization_id: ORG,
      title: brief.title,
      channels: brief.channels,
      posted_channels: [],
      status: "brief",
    });

    await generateSocialPosts(
      { db, provider: new MockProvider(), organizationId: ORG, userId: "user-1" },
      brief,
      { socialProjectId: project.id as string },
    );

    const [draft] = await db.findMany("generated_drafts", { status: "draft" });
    expect(draft.draft_type).toBe("social_posts");
    await approveDraft(db, CTX, draft.id as string);

    let updated = await db.findById("social_projects", project.id as string);
    expect(updated?.status).toBe("approved");
    expect(updated?.approved_content).toBeTruthy();

    // 投稿済み管理: 1つ目で approved のまま、全部で posted
    await markChannelPosted(db, CTX, project.id as string, "hp");
    updated = await db.findById("social_projects", project.id as string);
    expect(updated?.status).toBe("approved");
    await markChannelPosted(db, CTX, project.id as string, "instagram");
    updated = await db.findById("social_projects", project.id as string);
    expect(updated?.status).toBe("posted");
    expect(updated?.posted_channels).toEqual(["hp", "instagram"]);
  });

  it("依頼したチャンネルの原稿が無い出力は保存拒否される", async () => {
    const db = new InMemoryDb();
    const provider = new MockProvider({
      generate_social_posts: JSON.stringify({
        hp: { title: "T", body: "B" },
        instagram: null, // 依頼したのに無い
        facebook: null,
        youtube: null,
        missing_information: [],
      }),
    });

    await expect(
      generateSocialPosts({ db, provider, organizationId: ORG, userId: "user-1" }, brief),
    ).rejects.toThrow();
    expect(await db.findMany("generated_drafts", {})).toHaveLength(0);
    expect(await db.findMany("ai_runs", { status: "failed" })).toHaveLength(1);
  });

  it("承認前の案件は投稿済みにできない", async () => {
    const db = new InMemoryDb();
    const project = await db.insert("social_projects", {
      organization_id: ORG,
      channels: ["hp"],
      posted_channels: [],
      status: "brief",
      approved_content: null,
    });
    await expect(markChannelPosted(db, CTX, project.id as string, "hp")).rejects.toThrow("承認前");
  });
});
