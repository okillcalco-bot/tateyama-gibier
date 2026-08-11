-- 20260811_customer_link.sql の取り消し
drop function if exists admin_issue_customer_link(text, uuid[], int);
-- portal_sessions に発行済みのリンク由来セッション（user_agent='admin-issued-link'）は
-- 有効期限が来れば自動的に対象外になるため、ここでは削除しない。
-- 即時に無効化したい場合は次を実行:
--   delete from portal_sessions where user_agent = 'admin-issued-link';
