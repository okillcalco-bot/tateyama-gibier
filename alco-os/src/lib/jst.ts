/** 日本時間（Asia/Tokyo）の日付ユーティリティ。現場運用はすべてJST基準 */

const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }); // YYYY-MM-DD

export function jstToday(): string {
  return fmt.format(new Date());
}

/** "2026-07" 形式の今月 */
export function jstThisMonth(): string {
  return jstToday().slice(0, 7);
}

/** "HH:MM" / "HH:MM:SS" → 分。パースできなければ null */
export function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 分 → "H:MM" 表示 */
export function minutesToLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}
