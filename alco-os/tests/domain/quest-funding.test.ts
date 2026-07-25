import { describe, it, expect } from "vitest";
import {
  createQuest,
  publishQuest,
  updateQuestProgress,
  questProgress,
  toSlug,
} from "@/domain/satoyama/quest-service";
import {
  createPledge,
  confirmPledge,
  cancelPledge,
  recordPayout,
  summarizeSupport,
} from "@/domain/satoyama/funding-service";
import {
  evaluateSupporterAchievements,
  evaluateObserverAchievements,
  communityLevel,
} from "@/domain/satoyama/achievements";
import { InMemoryDb } from "../helpers/in-memory-db";

const CTX = { organizationId: "org-1", actorId: "user-1" };

async function openQuest(db: InMemoryDb, overrides = {}) {
  const quest = await createQuest(db, CTX, {
    title: "夏のコウモリ調査",
    targetCount: 3,
    fundingGoalYen: 30000,
    taxonGroup: "哺乳類",
    ...overrides,
  });
  return publishQuest(db, CTX, quest.id as string);
}

describe("クエスト（ゲーミフィケーション）", () => {
  it("進捗と資金の割合を算出し、達成で completed になる", async () => {
    const db = new InMemoryDb();
    const quest = await openQuest(db);
    expect(questProgress(quest).percent).toBe(0);

    await updateQuestProgress(db, CTX, quest.id as string, 2);
    let current = await db.findById("survey_tasks", quest.id as string);
    expect(questProgress(current!).percent).toBe(67);
    expect(current!.status).toBe("open");

    await updateQuestProgress(db, CTX, quest.id as string, 3);
    current = await db.findById("survey_tasks", quest.id as string);
    expect(questProgress(current!).completed).toBe(true);
    expect(current!.status).toBe("done");
    expect(current!.completed_at).toBeTruthy();
  });

  it("希少種クエストは公開できない（位置暴露・乱獲の防止）", async () => {
    const db = new InMemoryDb();
    const quest = await createQuest(db, CTX, {
      title: "サシバの営巣調査",
      targetCount: 2,
      restricted: true,
    });
    await expect(publishQuest(db, CTX, quest.id as string)).rejects.toThrow("公開できません");
    const stored = await db.findById("survey_tasks", quest.id as string);
    expect(stored?.published_at).toBeFalsy();
  });

  it("公開するとスラッグが付き、監査ログが残る", async () => {
    const db = new InMemoryDb();
    const quest = await openQuest(db);
    expect(quest.public_slug).toBeTruthy();
    expect(quest.published_at).toBeTruthy();
    expect(toSlug("Summer Bat Survey", "abc-def-123")).toContain("summer-bat-survey");
    expect(toSlug("夏のコウモリ調査", "abc-def-123")).toMatch(/^quest-/); // 日本語はid断片
  });
});

describe("応援（支援金）の循環", () => {
  it("表明だけでは資金にならず、入金確認で初めて加算される", async () => {
    const db = new InMemoryDb();
    const quest = await openQuest(db);

    const pledge = await createPledge(db, CTX, {
      taskId: quest.id as string,
      displayName: "応援者A",
      amountYen: 5000,
    });
    expect(pledge.status).toBe("pledged");
    let current = await db.findById("survey_tasks", quest.id as string);
    expect(Number(current!.funded_yen)).toBe(0); // まだ資金ではない

    await confirmPledge(db, CTX, pledge.id as string);
    current = await db.findById("survey_tasks", quest.id as string);
    expect(Number(current!.funded_yen)).toBe(5000);
  });

  it("非公開クエストには応援できない", async () => {
    const db = new InMemoryDb();
    const quest = await createQuest(db, CTX, { title: "下書き", targetCount: 1 });
    await expect(
      createPledge(db, CTX, {
        taskId: quest.id as string,
        displayName: "応援者",
        amountYen: 1000,
      }),
    ).rejects.toThrow("受け付けていません");
  });

  it("100円未満・過大な金額は拒否される", async () => {
    const db = new InMemoryDb();
    const quest = await openQuest(db);
    await expect(
      createPledge(db, CTX, { taskId: quest.id as string, displayName: "A", amountYen: 50 }),
    ).rejects.toThrow("100円以上");
    await expect(
      createPledge(db, CTX, { taskId: quest.id as string, displayName: "A", amountYen: 99999999 }),
    ).rejects.toThrow("大きすぎます");
  });

  it("支払いは入金確認済みの応援を超えられない（お金の整合性）", async () => {
    const db = new InMemoryDb();
    const quest = await openQuest(db);
    const pledge = await createPledge(db, CTX, {
      taskId: quest.id as string,
      displayName: "応援者A",
      amountYen: 10000,
    });
    await confirmPledge(db, CTX, pledge.id as string);

    await expect(
      recordPayout(db, CTX, {
        taskId: quest.id as string,
        payeeName: "調査員B",
        amountYen: 12000,
        paidOn: "2026-07-20",
      }),
    ).rejects.toThrow("超える支払いはできません");

    // 範囲内なら記録でき、paid_out_yen に反映される（＝地域の仕事になった額）
    await recordPayout(db, CTX, {
      taskId: quest.id as string,
      payeeName: "調査員B",
      amountYen: 8000,
      paidOn: "2026-07-20",
      purpose: "謝金",
    });
    const current = await db.findById("survey_tasks", quest.id as string);
    expect(Number(current!.paid_out_yen)).toBe(8000);
    expect(questProgress(current!).availableYen).toBe(2000);
  });

  it("支払い済みを下回る取り消しはできない", async () => {
    const db = new InMemoryDb();
    const quest = await openQuest(db);
    const pledge = await createPledge(db, CTX, {
      taskId: quest.id as string,
      displayName: "A",
      amountYen: 10000,
    });
    await confirmPledge(db, CTX, pledge.id as string);
    await recordPayout(db, CTX, {
      taskId: quest.id as string,
      payeeName: "調査員",
      amountYen: 9000,
      paidOn: "2026-07-20",
    });
    await expect(cancelPledge(db, CTX, pledge.id as string, "refunded")).rejects.toThrow(
      "下回るため取り消せません",
    );
  });

  it("応援サマリーは循環率（仕事に変わった割合）を出す", () => {
    const pledges = [
      { supporter_id: "s1", amount_yen: 5000, status: "confirmed" },
      { supporter_id: "s2", amount_yen: 5000, status: "confirmed" },
      { supporter_id: "s3", amount_yen: 3000, status: "pledged" }, // 未確認は数えない
    ];
    const payouts = [{ amount_yen: 6000 }];
    const summary = summarizeSupport(pledges, payouts);
    expect(summary.totalFunded).toBe(10000);
    expect(summary.supporterCount).toBe(2);
    expect(summary.totalPaidOut).toBe(6000);
    expect(summary.circulationRate).toBe(60);
  });
});

describe("称号（乱獲・競争を煽らない設計）", () => {
  it("応援者の称号は金額でなく継続と成果で決まる", () => {
    expect(
      evaluateSupporterAchievements({
        confirmedPledgeCount: 1,
        isFirstSupporterOfAnyQuest: true,
        supportedCompletedQuestCount: 0,
      }),
    ).toEqual(["first_supporter"]);

    expect(
      evaluateSupporterAchievements({
        confirmedPledgeCount: 3,
        isFirstSupporterOfAnyQuest: false,
        supportedCompletedQuestCount: 1,
      }),
    ).toEqual(expect.arrayContaining(["quest_completer", "continuous_supporter"]));
  });

  it("観察者の称号は投稿数では付かない（承認率・季節・証拠の多様性）", () => {
    // 20件投稿しても承認率が低ければ「丁寧な観察者」は付かない
    const sloppy = Array.from({ length: 20 }, (_, i) => ({
      site_id: "s1",
      observed_at: "2026-04-01",
      review_status: i < 5 ? "approved" : "pending",
      evidence_type: "sighting",
    }));
    expect(evaluateObserverAchievements(sloppy)).not.toContain("careful_observer");

    // 4季 + 証拠3種 + 高承認率なら付く
    const careful = [
      ...["2026-04-01", "2026-07-01", "2026-10-01", "2026-01-01"].map((d) => ({
        site_id: "s1",
        observed_at: d,
        review_status: "approved",
        evidence_type: "photo",
      })),
      ...["audio", "track", "photo", "photo", "photo", "photo"].map((e) => ({
        site_id: "s1",
        observed_at: "2026-05-01",
        review_status: "approved",
        evidence_type: e,
      })),
    ];
    const keys = evaluateObserverAchievements(careful);
    expect(keys).toEqual(expect.arrayContaining(["four_seasons", "evidence_bridge", "careful_observer"]));
  });

  it("地域レベルは共同の成果で上がる", () => {
    const start = communityLevel({ approvedObservations: 0, filledCells: 0, completedQuests: 0 });
    expect(start.level).toBe(1);
    const grown = communityLevel({ approvedObservations: 100, filledCells: 8, completedQuests: 3 });
    expect(grown.level).toBeGreaterThan(start.level);
    expect(grown.title).toBeTruthy();
  });
});
