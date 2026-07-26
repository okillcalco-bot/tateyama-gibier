import type { DbPort } from "@/lib/db/port";
import type { PaymentSummaryLine } from "./hunter-replies";

/**
 * 捕獲者へ返す「受入状況」「買取状況」の照会。
 *
 * 既存ジビエ基幹テーブル（org_settings / individuals）は**読み取りのみ**。
 * org_settings は既存のキーバリュー表。0014 で org_bank_info を足したのと
 * 同じ流儀で、行（キー）を足すだけでスキーマは変更しない。
 */

export const ACCEPTING_KEY = "gibier_accepting";
export const ACCEPTANCE_NOTE_KEY = "gibier_acceptance_note";

export interface AcceptanceStatus {
  /** true=受入可 / false=受入停止 / null=未設定 */
  accepting: boolean | null;
  /** 捕獲者へ添える補足文（受付時間など） */
  note: string;
}

async function readSetting(db: DbPort, key: string): Promise<string> {
  try {
    const rows = await db.findMany("org_settings", { key }, 1);
    const value = rows[0]?.value;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

/** 当日の受入可否。値は既存アプリと共用するため日本語の '受入可' / '受入停止' */
export async function getAcceptanceStatus(db: DbPort): Promise<AcceptanceStatus> {
  const [raw, note] = await Promise.all([
    readSetting(db, ACCEPTING_KEY),
    readSetting(db, ACCEPTANCE_NOTE_KEY),
  ]);
  let accepting: boolean | null = null;
  if (raw === "受入可") accepting = true;
  else if (raw === "受入停止") accepting = false;
  return { accepting, note };
}

/**
 * 本日の受入件数（「受入状況」ボタンの答え）。
 * individuals は既存テーブルのため読み取りのみ。
 * 仕様（2026-07-26 確定）: まずは件数だけを返す。
 */
export async function getTodayIntakeCount(db: DbPort, today: string): Promise<number> {
  try {
    const rows = await db.findMany("individuals", { capture_date: today }, 500);
    return rows.length;
  } catch {
    return 0;
  }
}

/**
 * 捕獲者の直近の買取状況。
 * ※「買取状況」ボタンは現在「準備中」の案内を返す運用のため、この関数は
 *   職員画面や将来の個別配信のために残している（LINE返信には使っていない）。
 */
export async function getRecentBuybacks(
  db: DbPort,
  hunterName: string,
  limit = 5,
): Promise<PaymentSummaryLine[]> {
  if (!hunterName) return [];
  let rows;
  try {
    rows = await db.findMany("individuals", { hunter_name: hunterName }, 200);
  } catch {
    return [];
  }
  return rows
    .map((row) => ({
      captureDate: typeof row.capture_date === "string" ? row.capture_date : null,
      species: typeof row.species === "string" ? row.species : null,
      labelId: typeof row.label_id === "string" ? row.label_id : null,
      amount: typeof row.buyback_amount === "number" ? row.buyback_amount : null,
    }))
    .sort((a, b) => (b.captureDate ?? "").localeCompare(a.captureDate ?? ""))
    .slice(0, limit);
}
