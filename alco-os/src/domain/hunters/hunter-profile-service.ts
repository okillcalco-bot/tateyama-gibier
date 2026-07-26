import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 捕獲者の追加情報と口座（B案 / 2026-07-26 確定）。
 *
 * 収集方針:
 * - LINEでは口座を扱わない。案内だけ出す
 * - 口座は職員が電話・対面で聞き取り、**既存 hunters の口座欄**へ入力する
 * - 生年月日・住所・電話・活動エリア・従事者証は hunter_profiles（0026）へ
 * - 206名分は職員操作のCSVインポートで一括投入（監査ログ付き）
 *
 * 口座の取り扱い:
 * - 画面表示は下4桁のみ。フル表示は owner / manager だけ（呼び出し側で判定）
 * - フル表示したこと自体も監査ログに残す（誰がいつ見たか）
 */

export interface HunterProfileInput {
  hunterId: string;
  birthDate?: string | null;
  postalCode?: string | null;
  address?: string | null;
  phone?: string | null;
  activityArea?: string | null;
  hasWorkerCard?: boolean | null;
  workerCardNumber?: string | null;
  note?: string | null;
  source?: "hearing" | "csv" | "line";
}

/** 口座番号の表示用マスク。下4桁だけ見せる */
export function maskAccountNumber(accountNumber: string | null | undefined): string {
  const value = (accountNumber ?? "").trim();
  if (!value) return "未登録";
  if (value.length <= 4) return `****${value}`;
  return `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

/** 一覧に出す口座の要約（銀行名と下4桁だけ） */
export function describeBankAccount(hunter: Row): string {
  const bank = typeof hunter.bank_name === "string" ? hunter.bank_name : "";
  const number = typeof hunter.account_number === "string" ? hunter.account_number : "";
  if (!bank && !number) return "未登録";
  return `${bank || "銀行名なし"} ${maskAccountNumber(number)}`;
}

export async function getHunterProfile(db: DbPort, hunterId: string): Promise<Row | null> {
  const rows = await db.findMany("hunter_profiles", { hunter_id: hunterId }, 1);
  return rows[0] ?? null;
}

/** 追加情報の登録・更新（1捕獲者1行） */
export async function saveHunterProfile(
  db: DbPort,
  ctx: AuditContext,
  input: HunterProfileInput,
): Promise<Row> {
  if (!input.hunterId) throw new Error("捕獲者を選んでください");

  const patch: Row = {
    birth_date: input.birthDate ?? null,
    postal_code: input.postalCode ?? null,
    address: input.address ?? null,
    phone: input.phone ?? null,
    activity_area: input.activityArea ?? null,
    has_worker_card: input.hasWorkerCard ?? null,
    worker_card_number: input.workerCardNumber ?? null,
    note: input.note ?? null,
    source: input.source ?? "hearing",
    collected_by: ctx.actorId,
    collected_at: new Date().toISOString(),
  };

  const existing = await getHunterProfile(db, input.hunterId);
  const saved = existing
    ? await db.update("hunter_profiles", existing.id as string, patch)
    : await db.insert("hunter_profiles", {
        organization_id: ctx.organizationId,
        hunter_id: input.hunterId,
        ...patch,
      });

  await writeAuditLog(db, ctx, {
    action: existing ? "update" : "insert",
    tableName: "hunter_profiles",
    recordId: saved.id as string,
    before: existing,
    after: saved,
    note: "捕獲者の追加情報を保存",
  });

  return saved;
}

/**
 * 口座情報の更新。**既存 hunters の欄**へ書き込む。
 * 既存アプリ（index.html の台帳）と同じ列を使うので二重管理にならない。
 */
export async function saveHunterBankAccount(
  db: DbPort,
  ctx: AuditContext,
  params: {
    hunterId: string;
    bankName: string;
    bankBranch: string;
    accountType: string;
    accountNumber: string;
    accountHolder: string;
  },
): Promise<Row> {
  const before = await db.findById("hunters", params.hunterId);
  if (!before) throw new Error("捕獲者が見つかりません");

  const after = await db.update("hunters", params.hunterId, {
    bank_name: params.bankName.trim() || null,
    bank_branch: params.bankBranch.trim() || null,
    account_type: params.accountType.trim() || null,
    account_number: params.accountNumber.trim() || null,
    account_holder: params.accountHolder.trim() || null,
  });

  // 監査ログに口座番号そのものは残さない（下4桁のみ）
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "hunters",
    recordId: params.hunterId,
    note: `口座情報を更新（${params.bankName} ${maskAccountNumber(params.accountNumber)}）`,
  });

  return after;
}

/** 口座のフル表示。誰がいつ見たかを必ず残す */
export async function revealBankAccount(
  db: DbPort,
  ctx: AuditContext,
  hunterId: string,
): Promise<Row> {
  const hunter = await db.findById("hunters", hunterId);
  if (!hunter) throw new Error("捕獲者が見つかりません");

  await writeAuditLog(db, ctx, {
    action: "export",
    tableName: "hunters",
    recordId: hunterId,
    note: "口座情報を表示（フル）",
  });

  return hunter;
}

// ── CSVインポート（206名分の追加情報を一括投入する用途） ──

export interface CsvRowResult {
  line: number;
  hunterName: string;
  status: "saved" | "skipped";
  reason?: string;
}

const CSV_HEADERS = [
  "捕獲者名",
  "生年月日",
  "郵便番号",
  "住所",
  "電話番号",
  "活動エリア",
  "従事者証",
  "従事者証番号",
  "備考",
] as const;

export function csvTemplate(): string {
  return `${CSV_HEADERS.join(",")}\n山田 太郎,1950-01-02,294-0000,館山市〇〇1-2-3,0470-00-0000,〇〇地区,あり,12345,\n`;
}

/** ダブルクォート対応の最小CSVパーサ */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/**
 * CSVを取り込む。
 * - 捕獲者名で既存 hunters を突き合わせる。見つからない行は**作らずに飛ばす**
 *   （206名の台帳はジビエ基幹側が正。ALCO OS から捕獲者を新規作成しない）
 * - 同姓同名が複数いる行も、取り違えを避けるため飛ばす
 * - 口座列はCSVに含めない（B案。口座はこの経路では入れない）
 */
export async function importHunterProfilesCsv(
  db: DbPort,
  ctx: AuditContext,
  csvText: string,
): Promise<{ results: CsvRowResult[]; savedCount: number }> {
  const rows = parseCsv(csvText);
  if (rows.length === 0) throw new Error("CSVが空です");

  const header = rows[0].map((cell) => cell.trim());
  if (header[0] !== CSV_HEADERS[0]) {
    throw new Error(`1行目は見出し行にしてください（${CSV_HEADERS.join(",")}）`);
  }

  const results: CsvRowResult[] = [];
  let savedCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const hunterName = (cells[0] ?? "").trim();
    const line = i + 1;
    if (!hunterName) {
      results.push({ line, hunterName: "", status: "skipped", reason: "捕獲者名が空です" });
      continue;
    }

    const matches = await db.findMany("hunters", { name: hunterName }, 5);
    const alive = matches.filter((h) => !h.deleted_at);
    if (alive.length === 0) {
      results.push({
        line,
        hunterName,
        status: "skipped",
        reason: "台帳に同じ名前の捕獲者がいません",
      });
      continue;
    }
    if (alive.length > 1) {
      results.push({
        line,
        hunterName,
        status: "skipped",
        reason: "同じ名前が複数あります。画面から個別に登録してください",
      });
      continue;
    }

    const workerCard = (cells[6] ?? "").trim();
    await saveHunterProfile(db, ctx, {
      hunterId: alive[0].id as string,
      birthDate: (cells[1] ?? "").trim() || null,
      postalCode: (cells[2] ?? "").trim() || null,
      address: (cells[3] ?? "").trim() || null,
      phone: (cells[4] ?? "").trim() || null,
      activityArea: (cells[5] ?? "").trim() || null,
      hasWorkerCard: workerCard === "" ? null : /あり|有|1|true|○/i.test(workerCard),
      workerCardNumber: (cells[7] ?? "").trim() || null,
      note: (cells[8] ?? "").trim() || null,
      source: "csv",
    });
    results.push({ line, hunterName, status: "saved" });
    savedCount++;
  }

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "hunter_profiles",
    note: `CSVで捕獲者の追加情報を取り込み（${savedCount}件 / 全${results.length}行）`,
  });

  return { results, savedCount };
}
