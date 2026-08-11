-- 20260811_staff_payslip_link.sql の取り消し
drop function if exists staff_payslip_view(text, text);
drop function if exists admin_revoke_staff_payslip_link(text, uuid);
drop function if exists admin_issue_staff_payslip_link(text, uuid);
drop table if exists staff_payslip_links;
