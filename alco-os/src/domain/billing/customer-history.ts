import type { Row } from "@/lib/db/port";

/**
 * 顧客ごとの取引履歴（billing_documents から集計）。
 *
 * Misocaから取り込んだ過去の請求（source='misoca'）と、ALCO OS で発行した
 * 帳票を同じ土俵で見る。取引の頻度・金額・未入金が分かると、
 * 「そろそろ注文が来る頃」「入金がまだ」に気づける。
 *
 * 明細（何を買ったか）は Misoca の一覧CSVに含まれないため、
 * ここでは「いつ・いくら・入金したか」までを扱う。
 */

export interface CustomerTransaction {
  id: string;
  docNumber: string;
  docType: string;
  issueDate: string;
  total: number;
  dueDate: string | null;
  /** 未入金なら true（Misocaの取り込み時に note へ入れた情報から判定） */
  unpaid: boolean;
  source: string;
  cancelled: boolean;
}

export interface CustomerSummary {
  customerName: string;
  count: number;
  total: number;
  firstDate: string;
  lastDate: string;
  /** 平均の取引間隔（日）。2回以上のときだけ */
  averageIntervalDays: number | null;
  /** 最終取引からの経過日数 */
  daysSinceLast: number;
  /** 平均間隔を大きく超えて音沙汰がない（フォローの目安） */
  overdue: boolean;
  unpaidCount: number;
  unpaidTotal: number;
  transactions: CustomerTransaction[];
}

const dayMs = 24 * 60 * 60 * 1000;

function toDate(value: string): number {
  return new Date(`${value}T00:00:00+09:00`).getTime();
}

/** 帳票1行を取引に変換する。未入金は note の内容で判定（Misoca取り込み時に付与） */
export function toTransaction(row: Row): CustomerTransaction {
  const note = String(row.note ?? "");
  return {
    id: String(row.id),
    docNumber: String(row.doc_number ?? ""),
    docType: String(row.doc_type ?? ""),
    issueDate: String(row.issue_date ?? ""),
    total: Number(row.total) || 0,
    dueDate: (row.due_date as string) ?? null,
    unpaid: note.includes("未入金"),
    source: String(row.source ?? "alco"),
    cancelled: Boolean(row.deleted_at),
  };
}

/**
 * 顧客ごとにまとめる。取消済みは金額に数えないが、履歴には残す（削除より履歴）。
 * today は "YYYY-MM-DD"（テストしやすいよう引数にする）。
 */
export function summarizeByCustomer(rows: Row[], today: string): CustomerSummary[] {
  const byName = new Map<string, CustomerTransaction[]>();
  for (const row of rows) {
    const name = String(row.customer_name ?? "").trim();
    if (!name) continue;
    const list = byName.get(name) ?? [];
    list.push(toTransaction(row));
    byName.set(name, list);
  }

  const todayMs = toDate(today);
  const summaries: CustomerSummary[] = [];

  for (const [customerName, all] of byName) {
    const transactions = [...all].sort((a, b) => (a.issueDate < b.issueDate ? 1 : -1));
    const live = transactions.filter((t) => !t.cancelled);
    if (!live.length) continue;

    const dates = live.map((t) => t.issueDate).sort();
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];
    const spanDays = (toDate(lastDate) - toDate(firstDate)) / dayMs;
    const averageIntervalDays =
      live.length >= 2 ? Math.round(spanDays / (live.length - 1)) : null;
    const daysSinceLast = Math.max(0, Math.round((todayMs - toDate(lastDate)) / dayMs));
    const unpaid = live.filter((t) => t.unpaid);

    summaries.push({
      customerName,
      count: live.length,
      total: live.reduce((sum, t) => sum + t.total, 0),
      firstDate,
      lastDate,
      averageIntervalDays,
      daysSinceLast,
      // 平均間隔の1.5倍を超えたら「そろそろ声をかける」目安（2回以上の取引がある人だけ）
      overdue:
        averageIntervalDays !== null &&
        averageIntervalDays > 0 &&
        daysSinceLast > averageIntervalDays * 1.5,
      unpaidCount: unpaid.length,
      unpaidTotal: unpaid.reduce((sum, t) => sum + t.total, 0),
      transactions,
    });
  }

  return summaries.sort((a, b) => b.total - a.total);
}

/** 全体のまとめ（画面上部に出す） */
export function overallSummary(summaries: CustomerSummary[]) {
  return {
    customerCount: summaries.length,
    transactionCount: summaries.reduce((s, c) => s + c.count, 0),
    total: summaries.reduce((s, c) => s + c.total, 0),
    unpaidCount: summaries.reduce((s, c) => s + c.unpaidCount, 0),
    unpaidTotal: summaries.reduce((s, c) => s + c.unpaidTotal, 0),
    overdueCount: summaries.filter((c) => c.overdue).length,
  };
}
