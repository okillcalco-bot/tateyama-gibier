-- 従事者の体調チェック: 出勤できている＝異常なし（2026-10-07 沖 指示）
--
-- 保健所の立入で「従事者健康チェック記録」に（記録なし）が 231人日出ていた。原因は打刻ボタン以外の入り口:
--   1. 月給制の所定勤務の自動入力 apply_fixed_schedule（沖・田口）… 体調欄を持たない
--   2. 打刻の押し忘れを後から入れる「修正」画面（punch.html）と管理者の勤怠入力（index.html）
-- 打刻ボタンだけが体調を聞き、それ以外の入り口は空欄のまま保存していた。
--
-- 方針（沖）: 出勤できている人は体調に異常がない。異常があるときは打刻時に「異常あり」を選ぶ。
-- → 出勤（退勤）時刻があって体調が空欄なら「異常なし」を入れる。どの入り口から入っても同じ。
--   打刻で選んだ「異常あり: …」は上書きしない。
create or replace function public.attendance_health_default()
returns trigger language plpgsql as $$
begin
  if coalesce(NEW.clock_in, '') <> '' and coalesce(NEW.health_in, '') = '' then NEW.health_in := '異常なし'; end if;
  if coalesce(NEW.clock_out, '') <> '' and coalesce(NEW.health_out, '') = '' then NEW.health_out := '異常なし'; end if;
  return NEW;
end $$;

create or replace trigger trg_attendance_health_default before insert or update on public.attendance
  for each row execute function public.attendance_health_default();

-- 既存の空欄（2026-07-01〜10-07: 出勤 231件・退勤 259件）を同じ方針で補記（トリガーを通す）。
-- updated_at は触らない（給与・修正履歴の判定に使っているため）。
update public.attendance set health_in = health_in
 where (coalesce(clock_in, '') <> '' and coalesce(health_in, '') = '')
    or (coalesce(clock_out, '') <> '' and coalesce(health_out, '') = '');

-- 2026-10-08 追記（データ投入・SQLは記録のみ）:
--   4〜6月のパート出勤 182件を「令和8年度TGCパートシフト表」から転記（note: シフト表…から転記（10/8））。
--   沖・田口の4〜7月は月給制の所定勤務（8:30-17:30・休憩60分、田口は月火木金・祝日除く）で 186件
--   （note: 月給制・所定勤務（10/8 一括入力））。体調はトリガーで「異常なし」。
