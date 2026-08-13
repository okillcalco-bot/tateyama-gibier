-- フェーズ4(3/3) の実DBテスト（migrations/20260813_phase4_usual_prices.sql 対象）
--
-- 実行方法:
--   psql -v ON_ERROR_STOP=1 -f tests/db/phase4_usual_prices.test.sql
--   （SQL Editor / API はファイル全体を貼って実行しエラー応答で判定）
--
-- カバー範囲:
--   いつもの商品の自動再集計（取消済み実績を除外・is_pinned/is_hidden保持・
--   実績が消えた非pin行の削除・customer_saved_items を変更しない）／
--   顧客別価格比較（個別価格の override・standardとの差額）／
--   ポータル利用（portal_enabled のトグル・監査・一覧・担当者必須）／認可。
begin;
create temp table _t(no int, item text, ok boolean, detail text) on commit drop;
do $$
declare v_key text := 'TEST-INV-KEY-' || md5(random()::text);
  v_r jsonb; cust uuid; pA uuid; pB uuid; pC uuid; v_saved int; v_std int;
begin
  update app_secrets set hash = extensions.crypt(v_key, extensions.gen_salt('bf')) where key='staff_key';
  select id into pA from portal_products where coalesce(is_active,true) and coalesce(is_reorderable,true)
     and exists(select 1 from portal_product_prices pp where pp.product_id=portal_products.id and pp.price_rank='standard') order by sort_order limit 1;
  select id into pB from portal_products where coalesce(is_active,true) and coalesce(is_reorderable,true) and id<>pA order by sort_order limit 1;
  select id into pC from portal_products where coalesce(is_active,true) and coalesce(is_reorderable,true) and id not in (pA,pB) order by sort_order limit 1;
  insert into customers (code,name,price_rank) values ('UZ9001','いつもの実験店','standard') returning id into cust;

  insert into customer_purchase_facts (customer_id,product_id,purchased_on,weight_kg,amount,source_kind,source_id)
    values (cust,pA,'2026-07-01',2.0,9500,'invoice',gen_random_uuid()),
           (cust,pA,'2026-07-20',3.0,14250,'invoice',gen_random_uuid());
  insert into customer_purchase_facts (customer_id,product_id,purchased_on,weight_kg,amount,source_kind,source_id,canceled_at,canceled_by,cancel_reason)
    values (cust,pA,'2026-07-25',5.0,20000,'invoice',gen_random_uuid(),now(),'x','取消'),
           (cust,pB,'2026-07-10',1.0,2000,'invoice',gen_random_uuid(),now(),'x','取消');

  insert into customer_saved_items (customer_id,kind,product_id) values (cust,'favorite',pC);
  select count(*) into v_saved from customer_saved_items where customer_id=cust;

  v_r := admin_recompute_usual_items(v_key, cust, 'テスト職員');
  insert into _t values (1,'再集計 items>=1', (v_r->>'items')::int >= 1, v_r::text);
  insert into _t values (2,'取消除外: pAは有効2件のみ集計(total_kg=5.0)', exists(select 1 from customer_usual_items where customer_id=cust and product_id=pA and purchase_count=2 and total_kg=5.0));
  insert into _t values (3,'取消のみのpBはいつものに出ない', not exists(select 1 from customer_usual_items where customer_id=cust and product_id=pB));
  insert into _t values (4,'saved_itemsは再集計で不変', (select count(*) from customer_saved_items where customer_id=cust)=v_saved and exists(select 1 from customer_saved_items where customer_id=cust and product_id=pC));

  update customer_usual_items set is_pinned=true where customer_id=cust and product_id=pA;
  insert into customer_usual_items (customer_id,product_id,rank,is_pinned) values (cust,pC,99,true);
  insert into customer_usual_items (customer_id,product_id,rank,is_pinned) values (cust,pB,98,false);
  v_r := admin_recompute_usual_items(v_key, cust, 'テスト職員');
  insert into _t values (5,'pin保持: pAのis_pinnedは維持', exists(select 1 from customer_usual_items where customer_id=cust and product_id=pA and is_pinned=true));
  insert into _t values (6,'pin行(実績なしpC)は残る', exists(select 1 from customer_usual_items where customer_id=cust and product_id=pC and is_pinned=true));
  insert into _t values (7,'非pin実績なし行(pB)は削除される', not exists(select 1 from customer_usual_items where customer_id=cust and product_id=pB));
  insert into _t values (8,'再集計後もsaved_items不変', (select count(*) from customer_saved_items where customer_id=cust)=v_saved);

  update customer_usual_items set is_hidden=true where customer_id=cust and product_id=pA;
  v_r := admin_recompute_usual_items(v_key, cust, 'テスト職員');
  insert into _t values (9,'is_hidden保持', exists(select 1 from customer_usual_items where customer_id=cust and product_id=pA and is_hidden=true));

  v_r := admin_customer_usual_items(v_key, cust);
  insert into _t values (10,'いつもの一覧が返る', jsonb_array_length(v_r) >= 1, v_r::text);

  select unit_price into v_std from portal_product_prices where product_id=pA and price_rank='standard' limit 1;
  insert into customer_product_prices (customer_id,product_id,unit_price,updated_by) values (cust,pA,v_std-500,'テスト');
  v_r := admin_customer_price_comparison(v_key, cust);
  insert into _t values (11,'価格比較が全商品返す', jsonb_array_length(v_r) >= 1);
  insert into _t values (12,'個別価格の商品はoverride/差額が出る', exists(select 1 from jsonb_array_elements(v_r) e
    where (e->>'product_id')::uuid=pA and (e->>'has_override')::boolean and (e->>'override_price')::int=v_std-500
      and (e->>'price_source')='customer_override' and (e->>'diff_vs_standard')::int=-500), v_r::text);

  v_r := admin_set_portal_enabled(v_key, cust, true, 'テスト職員');
  insert into _t values (13,'portal_enabled=trueへ', (v_r->>'portal_enabled')::boolean and exists(select 1 from customers where id=cust and portal_enabled=true));
  insert into _t values (14,'変更が監査(security_events)に残る', exists(select 1 from security_events where event='portal_enabled_change' and detail like '%UZ9001%'));
  v_r := admin_list_portal_enabled(v_key, 'enabled');
  insert into _t values (15,'一覧(enabled)に出る', exists(select 1 from jsonb_array_elements(v_r) e where (e->>'id')::uuid=cust and (e->>'portal_enabled')::boolean));
  v_r := admin_set_portal_enabled(v_key, cust, false, 'テスト職員');
  insert into _t values (16,'portal_enabled=falseへ', exists(select 1 from customers where id=cust and portal_enabled=false));
  begin v_r := admin_set_portal_enabled(v_key, cust, true, '  ');
    insert into _t values (17,'担当者空は拒否', false,'');
  exception when others then insert into _t values (17,'担当者空は拒否', sqlerrm like '%担当者%',''); end;

  begin perform admin_recompute_usual_items('wrong', cust); insert into _t values (18,'誤キーrecompute拒否',false,'');
  exception when others then insert into _t values (18,'誤キーrecompute拒否', sqlerrm like '%スタッフキー%',''); end;
  begin perform admin_customer_price_comparison('wrong', cust); insert into _t values (19,'誤キー価格比較拒否',false,'');
  exception when others then insert into _t values (19,'誤キー価格比較拒否', sqlerrm like '%スタッフキー%',''); end;
  begin perform admin_list_portal_enabled('wrong'); insert into _t values (20,'誤キーlist拒否',false,'');
  exception when others then insert into _t values (20,'誤キーlist拒否', sqlerrm like '%スタッフキー%',''); end;

  insert into _t values (21,'新5RPC 認可(PUBLIC無/anon・auth有/definer/path固定)', (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace
      and p.proname in ('admin_recompute_usual_items','admin_customer_usual_items','admin_customer_price_comparison','admin_list_portal_enabled','admin_set_portal_enabled')
      and p.prosecdef and exists(select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')
      and not exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE')
      and has_function_privilege('anon',p.oid,'execute') and has_function_privilege('authenticated',p.oid,'execute'))=5, '');

  v_r := admin_recompute_usual_items(v_key, null, 'テスト職員');
  insert into _t values (22,'全顧客再集計 ok', (v_r->>'ok')::boolean, v_r::text);
end $$;

select * from _t order by no;

do $$
declare v_fails text; v_total int; v_ng int;
begin
  select count(*), count(*) filter (where not ok) into v_total, v_ng from _t;
  if v_ng > 0 then
    select string_agg(no || ':' || item, ' / ' order by no) into v_fails from _t where not ok;
    raise exception 'TEST FAILED (%/% 件): %', v_ng, v_total, v_fails;
  end if;
  raise notice 'ALL TESTS PASSED (% 件)', v_total;
end $$;

rollback;
