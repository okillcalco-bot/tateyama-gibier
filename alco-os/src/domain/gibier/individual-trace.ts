/**
 * 捕獲個体トレース（読み取り専用）。
 *
 * 「1頭の一生」を label_id で串刺しにして見えるようにする。
 *   捕獲報告(LINE) → 個体台帳 → 部位在庫 → 受注 → 請求
 *
 * 設計上の約束（docs/ALCO_OS_GAP_ANALYSIS.md）:
 * - **館山ジビエのDBの軸は変えない。** 個体の軸は individuals.label_id のまま
 * - 既存テーブルへの列追加・FK追加・データ修復はしない
 * - このモジュールは**一切書き込まない**（insert/update/delete を持たない）
 * - 座標は必ず geo-masking を通してから画面に渡す（呼び出し側の責務）
 *
 * 現実のデータ事情（2026-08 実測）:
 * - inventory.individual_id / individual_code は uuid ではなく label_id 文字列
 * - inventory 135件中 111件しか個体と突合できない（24件が孤児）
 * - processing_log.individual_id は全行 null（親子は ident_code の文字列でのみ辿れる）
 * ここでは「直さずに、見えるようにする」ことだけを行う。
 */

export type Row = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** inventory 行が指している個体の label_id（individual_id 優先、無ければ individual_code） */
export function inventoryLabelId(inventory: Row): string | null {
  return str(inventory.individual_id) ?? str(inventory.individual_code);
}

/** ident_code（TGC-08-T001-RO-10）から個体部分（TGC-08-T001）を推定する */
export function labelIdFromIdentCode(identCode: string | null | undefined): string | null {
  if (!identCode) return null;
  const m = /^([A-Z]+-\d+-[A-Z]\d+)/.exec(identCode.trim());
  return m ? m[1] : null;
}

export interface PartSummary {
  identCode: string | null;
  partName: string | null;
  weightKg: number | null;
  status: string | null;
  grade: string | null;
  unitPrice: number | null;
  tier: number | null;
  /** この部位が売れた注文（order_items 経由） */
  soldOrderCodes: string[];
}

export interface IndividualTrace {
  labelId: string;
  individualId: string | null; // individuals.id（uuid）
  serialNumber: number | null;
  species: string | null;
  captureDate: string | null;
  hunterName: string | null;
  intakeStatus: string | null;
  quality: string | null; // 「食用不可」等
  weightTotal: number | null;
  meatRank: string | null;
  yieldRate: number | null;
  buybackAmount: number | null;
  radiationResult: string | null;
  lat: number | null; // 生値。画面へ出す前に必ずマスクすること
  lng: number | null;

  /** LINEからの捕獲報告（あれば） */
  captureReport: { id: string; status: string; createdAt: string | null } | null;

  parts: PartSummary[];
  partsWeightKg: number; // 部位重量の合計
  /** 部位重量合計 ÷ 体重（%）。台帳の yield_rate とは別に実データから算出 */
  calculatedYieldPercent: number | null;
  orderCodes: string[];
  issues: TraceIssue[];
}

export type TraceIssueKind =
  | "orphan_inventory" // 個体台帳に無い label_id を指す在庫
  | "no_inventory" // 個体はあるが部位在庫が無い
  | "code_mismatch" // individual_id と individual_code が食い違う
  | "yield_gap"; // 台帳の歩留まりと実データが大きく違う

export interface TraceIssue {
  kind: TraceIssueKind;
  labelId: string | null;
  detail: string;
}

export const ISSUE_LABELS: Record<TraceIssueKind, string> = {
  orphan_inventory: "個体台帳に無い在庫",
  no_inventory: "部位在庫が未登録",
  code_mismatch: "個体コードの食い違い",
  yield_gap: "歩留まりの差が大きい",
};

/**
 * 個体1頭分のトレースを組み立てる。
 * 渡すのは「その個体に関係する行」だけでよい（呼び出し側で絞り込む）。
 */
export function buildIndividualTrace(input: {
  individual: Row;
  inventory: Row[];
  captureReport?: Row | null;
  /** order_items（inventory_id で紐づく）と orders（id → order_code） */
  orderItems?: Row[];
  orders?: Row[];
}): IndividualTrace {
  const ind = input.individual;
  const labelId = str(ind.label_id) ?? "";
  const orderById = new Map(
    (input.orders ?? []).map((o) => [String(o.id), str(o.order_code) ?? String(o.id).slice(0, 8)]),
  );
  const orderCodesByInventory = new Map<string, string[]>();
  for (const item of input.orderItems ?? []) {
    const invId = str(item.inventory_id);
    if (!invId) continue;
    const code = orderById.get(String(item.order_id));
    if (!code) continue;
    const list = orderCodesByInventory.get(invId) ?? [];
    if (!list.includes(code)) list.push(code);
    orderCodesByInventory.set(invId, list);
  }

  const parts: PartSummary[] = input.inventory.map((inv) => ({
    identCode: str(inv.ident_code),
    partName: str(inv.part_name),
    weightKg: num(inv.weight_kg) ?? num(inv.weight),
    status: str(inv.status),
    grade: str(inv.grade),
    unitPrice: num(inv.unit_price),
    tier: num(inv.tier),
    soldOrderCodes: orderCodesByInventory.get(String(inv.id)) ?? [],
  }));

  // 小分け（tier>=2）は親の重量に含まれるため、合計は最上位のみを数える
  const topLevel = parts.filter((p) => (p.tier ?? 1) <= 1);
  const partsWeightKg = Number(
    (topLevel.length ? topLevel : parts)
      .reduce((sum, p) => sum + (p.weightKg ?? 0), 0)
      .toFixed(2),
  );
  const weightTotal = num(ind.weight_total);
  const calculatedYieldPercent =
    weightTotal && weightTotal > 0 && partsWeightKg > 0
      ? Math.round((partsWeightKg / weightTotal) * 1000) / 10
      : null;

  const issues: TraceIssue[] = [];
  if (!parts.length) {
    issues.push({
      kind: "no_inventory",
      labelId,
      detail: "この個体の部位在庫が登録されていません（未解体、または登録漏れ）",
    });
  }
  for (const inv of input.inventory) {
    const a = str(inv.individual_id);
    const b = str(inv.individual_code);
    if (a && b && a !== b) {
      issues.push({
        kind: "code_mismatch",
        labelId,
        detail: `在庫 ${str(inv.ident_code) ?? inv.id} の individual_id(${a}) と individual_code(${b}) が違います`,
      });
    }
  }
  const ledgerYield = num(ind.yield_rate);
  if (ledgerYield !== null && calculatedYieldPercent !== null) {
    // 台帳は 0.35 のような比率でも 35 のような%でも入りうるので両方見る
    const ledgerPercent = ledgerYield <= 1 ? ledgerYield * 100 : ledgerYield;
    if (Math.abs(ledgerPercent - calculatedYieldPercent) >= 10) {
      issues.push({
        kind: "yield_gap",
        labelId,
        detail: `台帳の歩留まり ${ledgerPercent.toFixed(1)}% に対し、在庫から計算すると ${calculatedYieldPercent}%`,
      });
    }
  }

  const report = input.captureReport;
  return {
    labelId,
    individualId: str(ind.id),
    serialNumber: num(ind.serial_number),
    species: str(ind.species),
    captureDate: str(ind.capture_date),
    hunterName: str(ind.hunter_name),
    intakeStatus: str(ind.intake_status),
    quality: str(ind.quality),
    weightTotal,
    meatRank: str(ind.meat_rank),
    yieldRate: ledgerYield,
    buybackAmount: num(ind.buyback_amount),
    radiationResult: str(ind.radiation_result),
    lat: num(ind.capture_lat),
    lng: num(ind.capture_lng),
    captureReport: report
      ? {
          id: String(report.id),
          status: str(report.status) ?? "pending",
          createdAt: str(report.created_at),
        }
      : null,
    parts,
    partsWeightKg,
    calculatedYieldPercent,
    orderCodes: [...new Set(parts.flatMap((p) => p.soldOrderCodes))],
    issues,
  };
}

export interface LinkHealth {
  individualCount: number;
  inventoryCount: number;
  /** 個体台帳と突合できた在庫の件数 */
  linkedInventoryCount: number;
  orphanInventory: { identCode: string | null; labelId: string | null; partName: string | null }[];
  individualsWithoutInventory: string[];
  linkedPercent: number;
}

/**
 * 個体↔在庫の接続状況を測る（直さない・見るだけ）。
 * これが「24件の孤児は何なのか」を人が判断するための材料になる。
 */
export function assessLinkHealth(individuals: Row[], inventory: Row[]): LinkHealth {
  const labelIds = new Set(
    individuals.map((i) => str(i.label_id)).filter((v): v is string => v !== null),
  );
  const usedLabelIds = new Set<string>();
  const orphanInventory: LinkHealth["orphanInventory"] = [];

  for (const inv of inventory) {
    const label = inventoryLabelId(inv) ?? labelIdFromIdentCode(str(inv.ident_code));
    if (label && labelIds.has(label)) {
      usedLabelIds.add(label);
    } else {
      orphanInventory.push({
        identCode: str(inv.ident_code),
        labelId: label,
        partName: str(inv.part_name),
      });
    }
  }

  const linkedInventoryCount = inventory.length - orphanInventory.length;
  return {
    individualCount: individuals.length,
    inventoryCount: inventory.length,
    linkedInventoryCount,
    orphanInventory,
    individualsWithoutInventory: [...labelIds].filter((l) => !usedLabelIds.has(l)).sort(),
    linkedPercent: inventory.length
      ? Math.round((linkedInventoryCount / inventory.length) * 100)
      : 100,
  };
}
