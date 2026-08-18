-- 顧客サイトの「おすすめ入荷情報」で新着に NEW! を出すため、
-- 公開掲示RPC portal_bulletins() の返却に created_at を追加する。
--
-- 返却カラムが変わるため create or replace ではなく drop→create（追加のみ・データ不変）。
-- 掲示板は公開情報。stable のまま（内部で書込みは無い）。anon実行を再付与。
--
-- ロールバック: migrations/rollback/20260818_bulletins_created_at_rollback.sql

drop function if exists portal_bulletins();
create or replace function portal_bulletins()
returns table(id uuid, product_id uuid, title text, body text, badge text,
              sort_order int, created_at timestamptz)
language sql stable security definer set search_path to 'public' as $$
  select b.id, b.product_id, b.title, b.body, b.badge, b.sort_order, b.created_at
    from portal_bulletins b
   where b.is_active
   order by b.sort_order, b.created_at desc;
$$;
grant execute on function portal_bulletins() to anon;
