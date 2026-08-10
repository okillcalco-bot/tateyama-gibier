-- 20260810_payroll.sql の取り消し
drop function if exists admin_payroll_delete(text, uuid);
drop function if exists admin_payroll_upsert(text, jsonb);
drop function if exists admin_payroll_list(text, text);
drop table if exists payroll_lines;
alter table staff drop column if exists stopkill_eligible;
alter table staff drop column if exists commute_yen_per_km;
alter table staff drop column if exists commute_round_km;
