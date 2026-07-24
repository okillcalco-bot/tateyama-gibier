import { describe, it, expect } from "vitest";
import {
  maskCoordinate,
  maskObservationPoint,
  precisionKmFor,
  effectiveSensitivity,
  toExportRow,
} from "@/domain/satoyama/geo-masking";
import { evaluateConfidence, scoreToGrade } from "@/domain/satoyama/confidence";
import { calculateGaps, suggestTasks, seasonOf } from "@/domain/satoyama/knowledge-gap";
import {
  createObservation,
  reviewObservation,
  enforceVisibility,
  createTaxon,
} from "@/domain/satoyama/observation-service";
import { InMemoryDb } from "../helpers/in-memory-db";

const CTX = { organizationId: "org-1", actorId: "user-1" };
const TATEYAMA = { lat: 34.996, lng: 139.87 };

describe("位置情報マスキング（希少種保護 — 最重要）", () => {
  it("希少種は一般公開でも会員でも座標を出さない", () => {
    for (const scope of ["public", "members"] as const) {
      const point = maskObservationPoint({ ...TATEYAMA, sensitivity: "sensitive" }, scope);
      expect(point.lat).toBeNull();
      expect(point.lng).toBeNull();
      expect(point.hidden).toBe(true);
    }
  });

  it("業務権限（restricted / owner）だけが原座標を見られる", () => {
    const point = maskObservationPoint({ ...TATEYAMA, sensitivity: "sensitive" }, "restricted");
    expect(point.lat).toBe(TATEYAMA.lat);
    expect(point.precisionLabel).toBe("原座標");
  });

  it("要注意種は一般公開で5kmメッシュに丸められる", () => {
    const point = maskObservationPoint({ ...TATEYAMA, sensitivity: "caution" }, "public");
    expect(point.lat).not.toBe(TATEYAMA.lat);
    // 5km ≒ 0.045度。丸め誤差は半メッシュ以内
    expect(Math.abs((point.lat as number) - TATEYAMA.lat)).toBeLessThanOrEqual(5 / 111 / 2 + 1e-9);
    expect(point.precisionLabel).toBe("約5kmメッシュ");
  });

  it("一般種でも公開時は1kmメッシュ。原座標をそのまま出さない", () => {
    const publicPoint = maskObservationPoint({ ...TATEYAMA, sensitivity: "normal" }, "public");
    expect(publicPoint.lat).not.toBe(TATEYAMA.lat);
    expect(precisionKmFor("normal", "public")).toBe(1);
    expect(precisionKmFor("sensitive", "public")).toBeNull();
  });

  it("maskCoordinate は null 安全・precision 0 は原座標", () => {
    expect(maskCoordinate(null, 1)).toBeNull();
    expect(maskCoordinate(35.0, null)).toBeNull();
    expect(maskCoordinate(35.0, 0)).toBe(35.0);
  });

  it("実効感度は 個別上書き > 種マスタ > normal", () => {
    expect(effectiveSensitivity("sensitive", "normal")).toBe("sensitive");
    expect(effectiveSensitivity(null, "caution")).toBe("caution");
    expect(effectiveSensitivity(null, null)).toBe("normal");
    expect(effectiveSensitivity("bogus", null)).toBe("normal"); // 不正値は安全側
  });

  it("エクスポート行にも権限が適用され、希少種の座標は出力されない", () => {
    const row = {
      id: "o1",
      observed_at: "2026-05-01",
      species_name: "サシバ",
      taxon_group: "鳥類",
      count: 1,
      evidence_type: "sighting",
      confidence_grade: "C",
      ...TATEYAMA,
      sensitivity: "sensitive" as const,
    };
    const exported = toExportRow(row, "public");
    expect(exported.lat).toBeNull();
    expect(exported.lng).toBeNull();
    expect(exported.location_precision).toBe("非公開（希少種保護）");
  });
});

describe("信頼度モデル（証拠充足度）", () => {
  it("胃内容物＋専門家確認＋承認は高スコア、聞き取り＋AIのみは低スコア", () => {
    const strong = evaluateConfidence({
      evidenceType: "stomach",
      identification: "expert",
      independentRepeats: 3,
      hasLiterature: true,
      reviewStatus: "approved",
    });
    const weak = evaluateConfidence({
      evidenceType: "hearsay",
      identification: "ai_only",
      reviewStatus: "pending",
    });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.grade).toBe("A");
    expect(weak.grade === "D" || weak.grade === "E").toBe(true);
  });

  it("要素ごとの内訳とバージョンを保存する（説明可能性）", () => {
    const result = evaluateConfidence({ evidenceType: "photo", identification: "single_photo" });
    expect(Object.keys(result.factors)).toContain("evidenceDirectness");
    expect(result.version).toBeTruthy();
    expect(result.label).toBe("現時点の証拠充足度");
  });

  it("スコア→グレードの境界", () => {
    expect(scoreToGrade(85)).toBe("A");
    expect(scoreToGrade(84)).toBe("B");
    expect(scoreToGrade(29)).toBe("E");
  });
});

describe("観察記録サービス", () => {
  it("希少種は要求に関わらず restricted へ落とされる（自動保護）", () => {
    expect(enforceVisibility("public", "sensitive")).toBe("restricted");
    expect(enforceVisibility("members", "sensitive")).toBe("restricted");
    expect(enforceVisibility("public", "caution")).toBe("members");
    expect(enforceVisibility("public", "normal")).toBe("public");
  });

  it("登録時に希少種保護が適用され、信頼度と監査ログが記録される", async () => {
    const db = new InMemoryDb();
    const taxon = await createTaxon(db, CTX, {
      commonName: "サシバ",
      taxonGroup: "鳥類",
      sensitivity: "sensitive",
    });
    const observation = await createObservation(db, CTX, {
      siteId: "site-1",
      observedAt: "2026-05-01T09:00:00Z",
      speciesName: "サシバ",
      taxonId: taxon.id as string,
      taxonGroup: "鳥類",
      lat: TATEYAMA.lat,
      lng: TATEYAMA.lng,
      evidenceType: "sighting",
      visibilityLevel: "public", // 公開を要求しても…
      taxonSensitivity: "sensitive",
    });

    expect(observation.visibility_level).toBe("restricted"); // …保護される
    expect(observation.review_status).toBe("pending"); // 未レビュー
    expect(observation.confidence_grade).toBeTruthy();
    const logs = await db.findMany("audit_logs", { table_name: "biodiversity_observations" });
    expect(logs).toHaveLength(1);
  });

  it("レビュー承認で信頼度が上がり、監査ログが残る", async () => {
    const db = new InMemoryDb();
    const observation = await createObservation(db, CTX, {
      siteId: "site-1",
      observedAt: "2026-05-01T09:00:00Z",
      speciesName: "ニホンアカガエル",
      evidenceType: "photo",
    });
    const before = Number(observation.confidence_score);
    const approved = await reviewObservation(db, CTX, observation.id as string, "approved");

    expect(approved.review_status).toBe("approved");
    expect(Number(approved.confidence_score)).toBeGreaterThan(before);
    const logs = await db.findMany("audit_logs", { action: "approve" });
    expect(logs).toHaveLength(1);
  });

  it("不正なレビュー状態は拒否される", async () => {
    const db = new InMemoryDb();
    const o = await createObservation(db, CTX, {
      siteId: "site-1",
      observedAt: "2026-05-01T09:00:00Z",
      speciesName: "不明",
    });
    // @ts-expect-error 不正値
    await expect(reviewObservation(db, CTX, o.id as string, "ok")).rejects.toThrow();
  });
});

describe("調査ギャップエンジン", () => {
  const observations = [
    { taxon_group: "両生類", observed_at: "2026-04-10", review_status: "approved", evidence_type: "photo" },
    { taxon_group: "両生類", observed_at: "2026-05-10", review_status: "pending", evidence_type: "sighting" },
    { taxon_group: "鳥類", observed_at: "2026-01-10", review_status: "approved", evidence_type: "audio" },
  ];

  it("季節判定", () => {
    expect(seasonOf("2026-04-10")).toBe("spring");
    expect(seasonOf("2026-07-01")).toBe("summer");
    expect(seasonOf("2026-10-01")).toBe("autumn");
    expect(seasonOf("2026-01-10")).toBe("winter");
  });

  it("分類群×季節の不足を算出する", () => {
    const summary = calculateGaps(observations, { requiredPerCell: 3 });
    // 4月・5月とも春なので春は2件（あと1件で必要数を満たす）
    const spring = summary.cells.find((c) => c.taxonGroup === "両生類" && c.season === "spring");
    expect(spring).toMatchObject({ observed: 2, required: 3, missing: 1 });
    const summer = summary.cells.find((c) => c.taxonGroup === "両生類" && c.season === "summer");
    expect(summer?.missing).toBe(3); // 夏は未調査
    expect(summary.reviewCompletion).toBe(67); // 3件中2件承認
  });

  it("希少種を含む分類群のタスクは restricted になる（一般募集しない）", () => {
    const summary = calculateGaps(observations, { requiredPerCell: 3 });
    const tasks = suggestTasks(summary, { sensitiveGroups: ["鳥類"] });
    expect(tasks.every((t) => t.priority > 0)).toBe(true);
    expect(tasks.filter((t) => t.taxonGroup === "鳥類").every((t) => t.restricted)).toBe(true);
    expect(tasks.filter((t) => t.taxonGroup === "両生類").every((t) => !t.restricted)).toBe(true);
  });
});
