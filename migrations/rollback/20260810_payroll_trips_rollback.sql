-- 20260810_payroll_trips.sql の取り消し
drop function if exists admin_payroll_trip_upsert(text, jsonb);
drop table if exists payroll_trips;
drop table if exists staff_trip_rates;
-- admin_payroll_list は 20260810_payroll.sql の定義（trips無し版）を再適用して戻す
