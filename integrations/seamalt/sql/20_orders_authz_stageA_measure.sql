-- ============================================================================
-- 既存の直接アクセス経路（anon キーで orders / order_items を読み書き）の認可移行 — 段階A: 測るだけ
-- 状態: 【案・本番未適用】本人の承認後に適用。この段階では何も拒否しない（既存画面は止まらない）
-- ============================================================================
-- 目的: 段階B（スタッフキー必須に戻す）を入れたときに止まる書込みが、どの画面・どれくらいあるかを先に数える。
--   orders / order_items への INSERT / UPDATE ごとに「スタッフキーのヘッダが付いていたか」を日別に数える。
--   個人情報は記録しない（日付・表・操作・キー有無・件数だけ）。
-- 読取り（SELECT）はトリガーで数えられないため、同じ画面が書込みもしている前提で書込みの比率から判断する。
begin;
create table if not exists order_link.access_counts (
  day date not null, tbl text not null, op text not null, with_key boolean not null, role text not null, n bigint not null default 0,
  primary key (day, tbl, op, with_key, role)
);
alter table order_link.access_counts enable row level security;
revoke all on order_link.access_counts from public, anon, authenticated;

create or replace function order_link.count_access() returns trigger
language plpgsql security definer set search_path = order_link, public, pg_temp as $$
begin
  insert into order_link.access_counts(day, tbl, op, with_key, role, n)
  values ((now() at time zone 'Asia/Tokyo')::date, TG_TABLE_NAME, TG_OP, coalesce(public.staff_key_header_ok(), false), current_user, 1)
  on conflict (day, tbl, op, with_key, role) do update set n = order_link.access_counts.n + 1;
  return null;
exception when others then
  return null;   -- 計測の失敗で業務の書込みを止めない（AFTER トリガー・結果は使わない）
end $$;
revoke all on function order_link.count_access() from public;
create trigger order_link_count_access after insert or update on public.orders for each row execute function order_link.count_access();
create trigger order_link_count_access after insert or update on public.order_items for each row execute function order_link.count_access();
commit;
-- 確認用: select day, tbl, op, with_key, role, n from order_link.access_counts order by day desc, tbl, op;
-- 取り消し: drop trigger order_link_count_access on public.orders; drop trigger order_link_count_access on public.order_items;
