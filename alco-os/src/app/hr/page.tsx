import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { jstToday, jstThisMonth, timeToMinutes, minutesToLabel } from "@/lib/jst";
import { Card, CardTitle, PageHeader, SetupNotice, Badge } from "@/components/ui";
import {
  ShiftAssignForm,
  ShiftPatternForm,
  PatternToggleButton,
  ShiftRequestForm,
  ReflectRequestButton,
  RemoveShiftButton,
} from "./hr-forms";

export const dynamic = "force-dynamic";

/**
 * 勤怠・シフト（HRMOS勤怠のシフト管理を参考にした最小構成）。
 * 予定 = shifts（既存テーブル）/ 実績 = attendance（punch.html の打刻）/
 * パターン・希望 = ALCO OS 側テーブル。
 */

type Row = Record<string, string | number | boolean | null>;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const PREFERENCE_LABELS: Record<string, string> = {
  ok: "出られる",
  ng: "休み希望",
  partial: "時間指定",
};

export default async function HrPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="勤怠・シフト" />
        <SetupNotice />
      </>
    );
  }

  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : jstThisMonth();
  const [year, monthNum] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const prevMonth = new Date(year, monthNum - 2, 1);
  const nextMonth = new Date(year, monthNum, 1);
  const toMonthParam = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const today = jstToday();

  const supabase = await createSupabaseServerClient();
  await getCurrentUser(supabase);

  const [
    { data: staff },
    { data: patterns },
    { data: shifts },
    { data: attendance },
    { data: requests },
  ] = await Promise.all([
    supabase
      .from("staff")
      .select("id, name, color, employment_type")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("name"),
    supabase.from("shift_patterns").select("*").order("sort_order").order("created_at"),
    supabase.from("shifts").select("*").gte("date", monthStart).lte("date", monthEnd).limit(1000),
    supabase
      .from("attendance")
      .select("*")
      .gte("work_date", monthStart)
      .lte("work_date", monthEnd)
      .limit(1000),
    supabase
      .from("shift_requests")
      .select("*")
      .eq("status", "open")
      .order("work_date")
      .limit(200),
  ]);

  const staffRows = (staff ?? []) as Row[];
  const patternRows = (patterns ?? []) as Row[];
  const shiftRows = (shifts ?? []) as Row[];
  const attendanceRows = (attendance ?? []) as Row[];
  const requestRows = (requests ?? []) as Row[];

  const patternByName = new Map(patternRows.map((p) => [p.name as string, p]));
  const staffById = new Map(staffRows.map((s) => [s.id as string, s]));
  const shiftByStaffDate = new Map(
    shiftRows.map((s) => [`${s.staff_id}|${s.date}`, s]),
  );
  const attendanceByStaffDate = new Map<string, Row>();
  for (const a of attendanceRows) {
    const byId = a.staff_id ? staffById.get(a.staff_id as string) : null;
    const matched = byId ?? staffRows.find((s) => s.name === a.staff_name);
    if (matched) attendanceByStaffDate.set(`${matched.id}|${a.work_date}`, a);
  }

  /** シフト1件の予定労働分数（時刻はシフト行 > パターン、休憩はパターン） */
  const plannedMinutes = (shift: Row): number => {
    const pattern = patternByName.get(shift.shift_type as string);
    const start = timeToMinutes((shift.start_time as string) ?? (pattern?.start_time as string));
    const end = timeToMinutes((shift.end_time as string) ?? (pattern?.end_time as string));
    if (start === null || end === null || end <= start) return 0;
    return end - start - (Number(pattern?.break_minutes) || 0);
  };
  const actualMinutes = (a: Row): number => {
    const start = timeToMinutes(a.clock_in as string);
    const end = timeToMinutes(a.clock_out as string);
    if (start === null || end === null || end <= start) return 0;
    return end - start - (Number(a.break_minutes) || 0);
  };

  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, "0")}`;
    const weekday = new Date(year, monthNum - 1, i + 1).getDay();
    return { date, day: i + 1, weekday };
  });

  const todayShifts = shiftRows.filter((s) => s.date === today);
  const todayAttendance = attendanceRows.filter((a) => a.work_date === today);

  return (
    <>
      <PageHeader
        title="勤怠・シフト"
        description="シフト予定（shifts）と打刻実績（punch.html）をひとつの表で。"
      />

      <div className="space-y-4">
        {/* 今日 */}
        <Card>
          <CardTitle>今日（{today}）</CardTitle>
          <div className="grid gap-3 text-sm md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-semibold text-stone-500">シフト予定</p>
              {todayShifts.length ? (
                todayShifts.map((s) => (
                  <p key={s.id as string}>
                    {(staffById.get(s.staff_id as string)?.name as string) ?? "?"} —{" "}
                    {s.shift_type as string}
                    {s.start_time ? ` ${(s.start_time as string).slice(0, 5)}〜${((s.end_time as string) ?? "").slice(0, 5)}` : ""}
                  </p>
                ))
              ) : (
                <p className="text-stone-400">予定なし</p>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold text-stone-500">打刻実績</p>
              {todayAttendance.length ? (
                todayAttendance.map((a) => (
                  <p key={a.id as string}>
                    {(a.staff_name as string) ?? "?"} — 出 {(a.clock_in as string) ?? "–"} / 退{" "}
                    {(a.clock_out as string) ?? "–"}
                  </p>
                ))
              ) : (
                <p className="text-stone-400">打刻なし</p>
              )}
            </div>
          </div>
        </Card>

        {/* 月間シフト表 */}
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <CardTitle>シフト表 {year}年{monthNum}月</CardTitle>
            <div className="flex gap-3 text-sm">
              <Link href={`/hr?month=${toMonthParam(prevMonth)}`} className="text-green-700 underline">
                ← 前月
              </Link>
              <Link href={`/hr?month=${toMonthParam(nextMonth)}`} className="text-green-700 underline">
                翌月 →
              </Link>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-white px-2 py-1 text-left font-medium">
                    スタッフ
                  </th>
                  {days.map((d) => (
                    <th
                      key={d.date}
                      className={`min-w-8 px-1 py-1 text-center font-normal ${
                        d.weekday === 0 ? "text-red-600" : d.weekday === 6 ? "text-blue-600" : "text-stone-500"
                      } ${d.date === today ? "bg-green-50" : ""}`}
                    >
                      {d.day}
                      <br />
                      {WEEKDAYS[d.weekday]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {staffRows.map((s) => (
                  <tr key={s.id as string} className="border-t border-stone-100">
                    <td className="sticky left-0 whitespace-nowrap bg-white px-2 py-1 font-medium">
                      {s.name as string}
                    </td>
                    {days.map((d) => {
                      const shift = shiftByStaffDate.get(`${s.id}|${d.date}`);
                      const worked = attendanceByStaffDate.has(`${s.id}|${d.date}`);
                      if (!shift && !worked) {
                        return <td key={d.date} className={`px-1 py-1 text-center ${d.date === today ? "bg-green-50" : ""}`} />;
                      }
                      const pattern = shift ? patternByName.get(shift.shift_type as string) : null;
                      const isOff = shift && ["公休", "有休"].includes(shift.shift_type as string);
                      return (
                        <td key={d.date} className={`px-0.5 py-1 text-center ${d.date === today ? "bg-green-50" : ""}`}>
                          {shift ? (
                            <span
                              title={`${shift.shift_type}${shift.start_time ? ` ${(shift.start_time as string).slice(0, 5)}〜${((shift.end_time as string) ?? "").slice(0, 5)}` : ""}`}
                              className="inline-block min-w-6 rounded px-1 py-0.5 font-semibold text-white"
                              style={{
                                backgroundColor: isOff
                                  ? "#a8a29e"
                                  : ((pattern?.color as string) ?? "#3B82F6"),
                              }}
                            >
                              {(pattern?.short_label as string) ||
                                (shift.shift_type as string).slice(0, 2)}
                            </span>
                          ) : null}
                          {worked ? <span className="block text-[9px] text-green-700">✓打刻</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-stone-400">✓打刻 = attendance の実績あり</p>
        </Card>

        {/* シフト登録 */}
        <Card>
          <CardTitle>シフト登録（同じスタッフ・同じ日は上書き）</CardTitle>
          <ShiftAssignForm
            staff={staffRows.map((s) => ({ id: s.id as string, name: s.name as string }))}
            patterns={patternRows.map((p) => ({
              id: p.id as string,
              name: p.name as string,
              short_label: p.short_label as string,
              start_time: p.start_time as string,
              end_time: p.end_time as string,
              is_active: Boolean(p.is_active),
            }))}
          />
          {shiftRows.length ? (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-xs font-semibold text-stone-500">
                当月のシフト明細（{shiftRows.length}件・削除はこちら）
              </summary>
              <ul className="mt-1 space-y-1">
                {[...shiftRows]
                  .sort((a, b) => String(a.date).localeCompare(String(b.date)))
                  .map((s) => (
                    <li key={s.id as string} className="flex items-center gap-2">
                      <span className="text-stone-600">
                        {s.date as string} {(staffById.get(s.staff_id as string)?.name as string) ?? "?"}{" "}
                        {s.shift_type as string}
                        {s.start_time ? ` ${(s.start_time as string).slice(0, 5)}〜${((s.end_time as string) ?? "").slice(0, 5)}` : ""}
                      </span>
                      <RemoveShiftButton shiftId={s.id as string} />
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}
        </Card>

        {/* 希望シフト */}
        <Card>
          <CardTitle>希望シフト（未反映 {requestRows.length}件）</CardTitle>
          <ShiftRequestForm
            staff={staffRows.map((s) => ({ id: s.id as string, name: s.name as string }))}
          />
          {requestRows.length ? (
            <ul className="mt-3 space-y-1 text-sm">
              {requestRows.map((r) => (
                <li key={r.id as string} className="flex flex-wrap items-center gap-2">
                  <Badge color={r.preference === "ng" ? "amber" : "blue"}>
                    {PREFERENCE_LABELS[r.preference as string] ?? (r.preference as string)}
                  </Badge>
                  <span>
                    {r.work_date as string}{" "}
                    {(staffById.get(r.staff_id as string)?.name as string) ?? "?"}
                    {r.start_time ? ` ${(r.start_time as string).slice(0, 5)}〜${((r.end_time as string) ?? "").slice(0, 5)}` : ""}
                    {r.note ? `（${r.note as string}）` : ""}
                  </span>
                  <ReflectRequestButton requestId={r.id as string} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-stone-400">
              未反映の希望はありません。スタッフの希望をここに集めて、シフト登録に反映します。
            </p>
          )}
        </Card>

        {/* 予実サマリー */}
        <Card>
          <CardTitle>予実サマリー（{monthNum}月）</CardTitle>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-stone-500">
                  <th className="py-1 pr-2">スタッフ</th>
                  <th className="py-1 pr-2">予定日数</th>
                  <th className="py-1 pr-2">予定時間</th>
                  <th className="py-1 pr-2">出勤日数</th>
                  <th className="py-1 pr-2">実働時間</th>
                </tr>
              </thead>
              <tbody>
                {staffRows.map((s) => {
                  const myShifts = shiftRows.filter(
                    (sh) =>
                      sh.staff_id === s.id && !["公休", "有休"].includes(sh.shift_type as string),
                  );
                  const myAttendance = attendanceRows.filter((a) => {
                    const byId = a.staff_id === s.id;
                    return byId || (!a.staff_id && a.staff_name === s.name);
                  });
                  const planned = myShifts.reduce((sum, sh) => sum + plannedMinutes(sh), 0);
                  const actual = myAttendance.reduce((sum, a) => sum + actualMinutes(a), 0);
                  return (
                    <tr key={s.id as string} className="border-t border-stone-100">
                      <td className="py-1 pr-2 font-medium">{s.name as string}</td>
                      <td className="py-1 pr-2">{myShifts.length}日</td>
                      <td className="py-1 pr-2">{minutesToLabel(planned)}</td>
                      <td className="py-1 pr-2">{myAttendance.length}日</td>
                      <td className="py-1 pr-2">{minutesToLabel(actual)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-stone-400">
            実働 = 打刻の出退勤から休憩を引いた時間。給与計算に使う前に打刻漏れを確認してください。
          </p>
        </Card>

        {/* パターン管理 */}
        <Card>
          <CardTitle>シフトパターン</CardTitle>
          {patternRows.length ? (
            <ul className="mb-2 space-y-1 text-sm">
              {patternRows.map((p) => (
                <li key={p.id as string} className="flex items-center gap-2">
                  <span
                    className="inline-block min-w-6 rounded px-1 py-0.5 text-center text-xs font-semibold text-white"
                    style={{ backgroundColor: (p.color as string) ?? "#3B82F6" }}
                  >
                    {(p.short_label as string) || (p.name as string).slice(0, 2)}
                  </span>
                  <span className={p.is_active ? "" : "text-stone-400 line-through"}>
                    {p.name as string} {(p.start_time as string).slice(0, 5)}〜
                    {(p.end_time as string).slice(0, 5)}（休憩{p.break_minutes as number}分）
                  </span>
                  <PatternToggleButton patternId={p.id as string} isActive={Boolean(p.is_active)} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-2 text-xs text-stone-400">
              まだパターンがありません。日勤・早番などの型を登録するとシフト入力が速くなります。
            </p>
          )}
          <ShiftPatternForm />
        </Card>
      </div>
    </>
  );
}
