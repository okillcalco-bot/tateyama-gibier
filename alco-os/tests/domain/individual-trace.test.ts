import { describe, it, expect } from "vitest";
import {
  buildIndividualTrace,
  assessLinkHealth,
  inventoryLabelId,
  labelIdFromIdentCode,
} from "@/domain/gibier/individual-trace";

/**
 * 個体トレース（読み取り専用）のテスト。
 * 館山ジビエのDBの軸（individuals.label_id）を変えない前提で、
 * 既存データの形をそのまま扱えることを固定する。
 */

const INDIVIDUAL = {
  id: "11111111-1111-1111-1111-111111111111",
  label_id: "TGC-08-T001",
  serial_number: 1,
  species: "イノシシ",
  capture_date: "2026-07-01",
  hunter_name: "山田",
  weight_total: 40,
  meat_rank: "A",
  yield_rate: 0.3,
  buyback_amount: 8000,
  intake_status: "受入済",
  quality: null,
  capture_lat: 34.996,
  capture_lng: 139.87,
  radiation_result: "検出下限値以下",
};

// 既存データの実態: individual_id は uuid ではなく label_id の文字列
const INVENTORY = [
  {
    id: "inv-1",
    individual_id: "TGC-08-T001",
    individual_code: "TGC-08-T001",
    ident_code: "TGC-08-T001-RO",
    part_name: "ロース",
    weight_kg: 6,
    status: "在庫",
    tier: 1,
  },
  {
    id: "inv-2",
    individual_id: "TGC-08-T001",
    individual_code: "TGC-08-T001",
    ident_code: "TGC-08-T001-BA",
    part_name: "バラ",
    weight_kg: 6,
    status: "出荷済",
    tier: 1,
  },
  {
    // 小分け（親の重量に含まれるので合計には数えない）
    id: "inv-3",
    individual_id: "TGC-08-T001",
    individual_code: "TGC-08-T001",
    ident_code: "TGC-08-T001-RO-10",
    part_name: "ロース小分け",
    weight_kg: 2,
    status: "在庫",
    tier: 2,
    parent_inventory_id: "inv-1",
  },
];

describe("個体トレース（読み取り専用）", () => {
  it("label_id を軸に、部位・受注・買取を1頭分にまとめる", () => {
    const trace = buildIndividualTrace({
      individual: INDIVIDUAL,
      inventory: INVENTORY,
      captureReport: { id: "rep-1", status: "accepted", created_at: "2026-07-01T00:00:00Z" },
      orderItems: [{ id: "oi-1", order_id: "ord-1", inventory_id: "inv-2" }],
      orders: [{ id: "ord-1", order_code: "ORD-001" }],
    });

    expect(trace.labelId).toBe("TGC-08-T001");
    expect(trace.parts).toHaveLength(3);
    // 小分け(tier2)は二重計上しない: 6 + 6 = 12kg
    expect(trace.partsWeightKg).toBe(12);
    // 体重40kgに対して12kg → 30%
    expect(trace.calculatedYieldPercent).toBe(30);
    expect(trace.orderCodes).toEqual(["ORD-001"]);
    expect(trace.captureReport?.status).toBe("accepted");
    expect(trace.buybackAmount).toBe(8000);
  });

  it("部位在庫が無い個体は「要確認」になる", () => {
    const trace = buildIndividualTrace({ individual: INDIVIDUAL, inventory: [] });
    expect(trace.issues.map((i) => i.kind)).toContain("no_inventory");
    expect(trace.partsWeightKg).toBe(0);
    expect(trace.calculatedYieldPercent).toBeNull();
  });

  it("individual_id と individual_code の食い違いを検出する", () => {
    const trace = buildIndividualTrace({
      individual: INDIVIDUAL,
      inventory: [
        { ...INVENTORY[0], individual_code: "TGC-08-T999" },
      ],
    });
    expect(trace.issues.map((i) => i.kind)).toContain("code_mismatch");
  });

  it("台帳の歩留まりと実データが10ポイント以上ずれたら知らせる（比率・%の両表記に対応）", () => {
    // 台帳0.6(=60%) に対し実データ30% → 差30ポイント
    const gap = buildIndividualTrace({
      individual: { ...INDIVIDUAL, yield_rate: 0.6 },
      inventory: INVENTORY,
    });
    expect(gap.issues.map((i) => i.kind)).toContain("yield_gap");

    // 台帳が 32（%表記）なら実データ30%との差は2ポイント → 知らせない
    const ok = buildIndividualTrace({
      individual: { ...INDIVIDUAL, yield_rate: 32 },
      inventory: INVENTORY,
    });
    expect(ok.issues.map((i) => i.kind)).not.toContain("yield_gap");
  });

  it("個体が無くても落ちない（体重0・受注なし）", () => {
    const trace = buildIndividualTrace({
      individual: { id: "x", label_id: "仮-ABC", weight_total: null },
      inventory: [],
    });
    expect(trace.labelId).toBe("仮-ABC");
    expect(trace.orderCodes).toEqual([]);
    expect(trace.calculatedYieldPercent).toBeNull();
  });
});

describe("個体↔在庫の接続状況（測るだけ・直さない）", () => {
  it("孤児の在庫と、在庫が無い個体を数える", () => {
    const health = assessLinkHealth(
      [{ label_id: "TGC-08-T001" }, { label_id: "TGC-08-T002" }],
      [
        ...INVENTORY,
        { id: "inv-x", individual_id: "TGC-08-T999", ident_code: "TGC-08-T999-RO", part_name: "ロース" },
      ],
    );

    expect(health.individualCount).toBe(2);
    expect(health.inventoryCount).toBe(4);
    expect(health.linkedInventoryCount).toBe(3);
    expect(health.orphanInventory).toHaveLength(1);
    expect(health.orphanInventory[0].labelId).toBe("TGC-08-T999");
    expect(health.individualsWithoutInventory).toEqual(["TGC-08-T002"]);
    expect(health.linkedPercent).toBe(75);
  });

  it("在庫が空でも100%として扱う（ゼロ除算しない）", () => {
    const health = assessLinkHealth([{ label_id: "TGC-08-T001" }], []);
    expect(health.linkedPercent).toBe(100);
    expect(health.orphanInventory).toEqual([]);
  });

  it("individual_id が無くても individual_code / ident_code から個体を辿れる", () => {
    expect(inventoryLabelId({ individual_id: null, individual_code: "TGC-08-M001" })).toBe(
      "TGC-08-M001",
    );
    expect(labelIdFromIdentCode("TGC-08-T001-RO-10")).toBe("TGC-08-T001");
    expect(labelIdFromIdentCode(null)).toBeNull();

    const health = assessLinkHealth(
      [{ label_id: "TGC-08-M001" }],
      [{ id: "i1", ident_code: "TGC-08-M001-HI", part_name: "ヒレ" }],
    );
    expect(health.linkedInventoryCount).toBe(1);
  });
});
