-- フェーズ4(3/3) 顧客ポータルの「実連携」実DBテスト（order.html が呼ぶ portal_* RPC を通しで検証）
--
-- 実行方法:
--   psql -v ON_ERROR_STOP=1 -f tests/db/phase4_portal_e2e.test.sql
--   （SQL Editor / API はファイル全体を貼って実行し、エラー応答の有無で判定）
--
-- 目的（3社の試験運用を想定した通しシナリオ）:
--   ・リピーター顧客に「いつもの商品」が出る（portal_usual_items が customer_usual_items を読む）
--   ・取消済み請求実績は集計対象外（canceled_at）
--   ・再集計を何度実行しても購入回数が増えない（冪等）
--   ・手動お気に入り（customer_saved_items）は再集計で消えない・変わらない
--   ・is_hidden のいつもの商品は顧客画面に出ない
--   ・顧客間分離（他店のいつものは見えない）
--   ・過去価格をそのまま使わない／注文時の現在価格をサーバーRPCで再解決（rebuild_cart・place_order）
--   ・在庫切れ・販売停止商品は理由つきで再注文不可（rebuild_cart の status/reason）
--   ・portal_enabled が false の顧客はログインできない（利用開始前）
--   ・二重注文にならない（client_request_id 冪等）／不正トークンは拒否
--
-- 隔離方針: 実商品の在庫に依存しないよう、専用の (E2E) 試験商品を独自 part_name で作成し、
--   在庫も本トランザクション内で用意する。全体を begin 〜 rollback で囲むため本番に残骸を残さない。

begin;
create temp table _t(no int, item text, ok boolean, detail text) on commit drop;
do $$
declare
  v_key text := 'TEST-INV-KEY-' || md5(random()::text);
  c1 uuid; c2 uuid; c3 uuid;
  pLoin uuid; pBelly uuid; pNo uuid; pDisc uuid; pFav uuid;
  tA text; tB text;
  o1 uuid; oid uuid;
  v_r jsonb; v_reb jsonb; v_res jsonb; v_res2 jsonb; v_last jsonb; v_last2 jsonb;
  v_pc int; v_saved int; v_ip int; v_cnt int; v_ok boolean; v_line jsonb;
  v_req text := 'e2e-req-' || md5(random()::text);
begin
  -- スタッフキーを一時キーへ（rollbackで戻る）
  update app_secrets set hash = extensions.crypt(v_key, extensions.gen_salt('bf')) where key='staff_key';

  -- ── (E2E) 試験商品を作成（独自 part_name で実在庫と衝突させない）──
  insert into portal_products (species, display_name, min_order_kg, step_kg, low_kg, is_active, portal_visible, is_orderable, is_reorderable, sort_order)
    values ('イノシシ','（E2E）ロース',0.5,0.5,3.0,true,true,true,true,9001) returning id into pLoin;
  insert into portal_products (species, display_name, min_order_kg, step_kg, low_kg, is_active, portal_visible, is_orderable, is_reorderable, sort_order)
    values ('イノシシ','（E2E）バラ',0.5,0.5,3.0,true,true,true,true,9002) returning id into pBelly;
  insert into portal_products (species, display_name, min_order_kg, step_kg, low_kg, is_active, portal_visible, is_orderable, is_reorderable, sort_order)
    values ('イノシシ','（E2E）在庫なし',0.5,0.5,3.0,true,true,true,true,9003) returning id into pNo;
  insert into portal_products (species, display_name, min_order_kg, step_kg, low_kg, is_active, portal_visible, is_orderable, is_reorderable, sort_order)
    values ('イノシシ','（E2E）販売停止',0.5,0.5,3.0,true,true,false,true,9004) returning id into pDisc;  -- is_orderable=false
  insert into portal_products (species, display_name, min_order_kg, step_kg, low_kg, is_active, portal_visible, is_orderable, is_reorderable, sort_order)
    values ('イノシシ','（E2E）お気に入り',0.5,0.5,3.0,true,true,true,true,9005) returning id into pFav;

  insert into portal_product_parts (product_id, part_name, grade) values
    (pLoin,'E2E_LOIN',null),(pBelly,'E2E_BELLY',null),(pNo,'E2E_NOSTOCK',null),(pDisc,'E2E_DISC',null),(pFav,'E2E_FAV',null);
  insert into portal_product_prices (product_id, price_rank, unit_price) values
    (pLoin,'standard',3800),(pBelly,'standard',3100),(pNo,'standard',1800),(pDisc,'standard',1600),(pFav,'standard',2000);

  -- ロース用の実在庫（合計4.5kg・部分和で3.0kgを組める）
  insert into inventory (species, part_name, grade, status, weight, weight_kg, processed_at)
    values ('イノシシ','E2E_LOIN',null,'在庫',1.0,1.0, now() - interval '5 day'),
           ('イノシシ','E2E_LOIN',null,'在庫',1.2,1.2, now() - interval '4 day'),
           ('イノシシ','E2E_LOIN',null,'在庫',0.8,0.8, now() - interval '3 day'),
           ('イノシシ','E2E_LOIN',null,'在庫',1.5,1.5, now() - interval '2 day');

  -- ── 3社（C1/C2=利用可, C3=利用開始前）──
  insert into customers (code,name,price_rank,portal_login_id,portal_enabled,is_active)
    values ('E2E-C1','（E2E）試験A商店','standard','e2e_a',true,true) returning id into c1;
  insert into customers (code,name,price_rank,portal_login_id,portal_enabled,is_active)
    values ('E2E-C2','（E2E）試験B精肉','standard','e2e_b',true,true) returning id into c2;
  insert into customers (code,name,price_rank,portal_login_id,portal_enabled,is_active)
    values ('E2E-C3','（E2E）試験C未開通','standard','e2e_c',false,true) returning id into c3;
  insert into customer_secrets (customer_id,password_hash) values
    (c1, extensions.crypt('e2ePass1', extensions.gen_salt('bf'))),
    (c2, extensions.crypt('e2ePass1', extensions.gen_salt('bf'))),
    (c3, extensions.crypt('e2ePass1', extensions.gen_salt('bf')));

  -- ── 確定済み購入実績（取消を混在）──
  -- C1: ロース 2.0(有効)/3.0(有効)/5.0(取消)、バラ 1.0(取消のみ)
  insert into customer_purchase_facts (customer_id,product_id,purchased_on,weight_kg,amount,source_kind,source_id)
    values (c1,pLoin,'2026-07-01',2.0,7600,'invoice',gen_random_uuid()),
           (c1,pLoin,'2026-07-20',3.0,11400,'invoice',gen_random_uuid());
  insert into customer_purchase_facts (customer_id,product_id,purchased_on,weight_kg,amount,source_kind,source_id,canceled_at,canceled_by,cancel_reason)
    values (c1,pLoin,'2026-07-25',5.0,19000,'invoice',gen_random_uuid(),now(),'x','取消'),
           (c1,pBelly,'2026-07-10',1.0,3100,'invoice',gen_random_uuid(),now(),'x','取消');
  -- C2: バラ 1.5 × 3（有効）
  insert into customer_purchase_facts (customer_id,product_id,purchased_on,weight_kg,amount,source_kind,source_id)
    values (c2,pBelly,'2026-06-05',1.5,4650,'invoice',gen_random_uuid()),
           (c2,pBelly,'2026-06-25',1.5,4650,'invoice',gen_random_uuid()),
           (c2,pBelly,'2026-07-15',1.5,4650,'invoice',gen_random_uuid());

  -- ══════════ 再集計（センター側） ══════════
  v_r := admin_recompute_usual_items(v_key, c1, 'テスト職員');
  insert into _t values (1,'C1再集計 items>=1', (v_r->>'items')::int >= 1, v_r::text);
  insert into _t values (2,'C1いつもの: ロースは有効2件のみ(count=2,total=5.0)',
    exists(select 1 from customer_usual_items where customer_id=c1 and product_id=pLoin and purchase_count=2 and total_kg=5.0));
  insert into _t values (3,'C1いつもの: 取消のみのバラは出ない',
    not exists(select 1 from customer_usual_items where customer_id=c1 and product_id=pBelly));
  v_r := admin_recompute_usual_items(v_key, c2, 'テスト職員');
  insert into _t values (4,'C2いつもの: バラ count=3',
    exists(select 1 from customer_usual_items where customer_id=c2 and product_id=pBelly and purchase_count=3));

  -- ══════════ ログイン（portal_enabled ゲート） ══════════
  begin
    perform portal_login_v2('e2e_c','e2ePass1','test-ua');
    insert into _t values (5,'C3(未開通)はログイン不可', false, 'ログインできてしまった');
  exception when others then
    insert into _t values (5,'C3(未開通)はログイン不可', sqlerrm like '%利用開始前%', sqlerrm);
  end;
  select token into tA from portal_login_v2('e2e_a','e2ePass1','test-ua');
  select token into tB from portal_login_v2('E2E-C2','e2ePass1','test-ua');  -- codeでもログイン可
  insert into _t values (6,'C1/C2ログイン成功(token発行)', tA is not null and tB is not null and tA<>tB, '');

  -- ══════════ order.html: いつもの商品 ══════════
  insert into _t values (7,'C1 いつものにロースが出る(現在価格3800・在庫◎・お気に入りoff)',
    exists(select 1 from portal_usual_items(tA) u
            where u.product_id=pLoin and u.usual_qty_kg=2.5 and u.unit_price=3800 and u.mark='◎' and u.is_favorite=false));
  insert into _t values (8,'C1 いつものにバラ(取消のみ)は出ない',
    not exists(select 1 from portal_usual_items(tA) u where u.product_id=pBelly));

  -- is_hidden のいつものは顧客画面に出ない
  update customer_usual_items set is_hidden=true where customer_id=c1 and product_id=pLoin;
  insert into _t values (9,'is_hidden のいつものは非表示',
    not exists(select 1 from portal_usual_items(tA) u where u.product_id=pLoin));
  update customer_usual_items set is_hidden=false where customer_id=c1 and product_id=pLoin;

  -- 顧客間分離
  insert into _t values (10,'顧客間分離: C2のいつものにC1のロースは出ない/自分のバラは出る',
    (not exists(select 1 from portal_usual_items(tB) u where u.product_id=pLoin))
    and exists(select 1 from portal_usual_items(tB) u where u.product_id=pBelly));

  -- ══════════ お気に入り（手動★）と冪等 ══════════
  select count(*) into v_saved from customer_saved_items where customer_id=c1;
  select portal_toggle_favorite(tA, pFav) into v_ok;
  insert into _t values (11,'お気に入り登録(RPC)がtrue・saved_items+1',
    v_ok=true and (select count(*) from customer_saved_items where customer_id=c1)=v_saved+1);

  select purchase_count into v_pc from customer_usual_items where customer_id=c1 and product_id=pLoin;
  v_r := admin_recompute_usual_items(v_key, c1, 'テスト職員');  -- もう一度再集計
  insert into _t values (12,'再集計を繰り返しても購入回数は増えない(冪等)',
    (select purchase_count from customer_usual_items where customer_id=c1 and product_id=pLoin)=v_pc and v_pc=2);
  insert into _t values (13,'再集計してもお気に入りは不変(saved_items保持)',
    exists(select 1 from customer_saved_items where customer_id=c1 and kind='favorite' and product_id=pFav));

  -- ══════════ 前回注文 → 現在価格・在庫で再構成 ══════════
  -- 現在の顧客別価格を 3500 に設定（過去単価9999と別値）
  insert into customer_product_prices (customer_id, product_id, unit_price, updated_by) values (c1, pLoin, 3500, 'test');
  insert into _t values (14,'resolve_unit_priceが個別価格3500(customer_override)を返す',
    (select unit_price from resolve_unit_price(c1,pLoin)) = 3500
    and (select price_source from resolve_unit_price(c1,pLoin)) = 'customer_override');

  -- 過去注文 O1（ロース=旧単価9999 / 在庫なし品 / 販売停止品）
  -- created_at を明示的に過去へ（now() はトランザクション内で一定のため、確定注文O2と衝突させない）
  insert into orders (order_code, customer_id, customer_name, status, order_date, channel, created_at)
    values ('E2E-OLD-1', c1, '（E2E）試験A商店', '受注', current_date - 20, 'ポータル', now() - interval '20 days') returning id into o1;
  insert into order_items (order_id, part_name, species, product_id_v2, product_name, unit_price, requested_kg) values
    (o1,'（E2E）ロース','イノシシ',pLoin,'（E2E）ロース',9999,3.0),
    (o1,'（E2E）在庫なし','イノシシ',pNo,'（E2E）在庫なし',1800,1.0),
    (o1,'（E2E）販売停止','イノシシ',pDisc,'（E2E）販売停止',1600,1.0);

  v_reb := portal_rebuild_cart(tA, o1);
  -- ロース: 現在価格3500で再解決・価格変更フラグ・旧価格9999
  select elem into v_line from jsonb_array_elements(v_reb) elem where (elem->>'product_id')::uuid = pLoin;
  insert into _t values (15,'再構成: ロースは現在価格3500で再解決(過去9999は使わない)・price_changed',
    v_line->>'status'='ok' and (v_line->>'unit_price')::int=3500
    and (v_line->>'old_unit_price')::int=9999 and (v_line->>'price_changed')::boolean=true);
  -- 在庫なし: out_of_stock + 理由
  select elem into v_line from jsonb_array_elements(v_reb) elem where (elem->>'name')='（E2E）在庫なし';
  insert into _t values (16,'再構成: 在庫切れは理由つきで再注文不可',
    v_line->>'status'='out_of_stock' and coalesce(v_line->>'reason','')<>'');
  -- 販売停止: unavailable + 「現在は注文できません」
  select elem into v_line from jsonb_array_elements(v_reb) elem where (elem->>'name')='（E2E）販売停止';
  insert into _t values (17,'再構成: 販売停止は理由つきで再注文不可',
    v_line->>'status'='unavailable' and v_line->>'reason'='現在は注文できません');

  -- ══════════ 注文確定: 現在価格をサーバーで再解決（クライアント単価は無視） ══════════
  -- クライアントは product_id と kg のみ送る想定。ここでは念のため偽の unit_price:1 を混ぜても無視されることを確認
  v_res := portal_place_order(tA,
    jsonb_build_array(jsonb_build_object('product_id', pLoin, 'kg', 3.0, 'unit_price', 1)),
    current_date + 1, '0000', null, v_req);
  oid := (v_res->>'order_id')::uuid;
  insert into _t values (18,'確定: 注文単価はサーバー再解決の3500(クライアント値1は無視)',
    (select unit_price from order_items where order_id=oid and product_id_v2=pLoin)=3500
    and (select price_source from order_items where order_id=oid and product_id_v2=pLoin)='customer_override');
  insert into _t values (19,'確定: 在庫引当済(allocated>0)・合計=引当kg×3500',
    (select allocated_kg from order_items where order_id=oid and product_id_v2=pLoin) > 0
    and (v_res->>'total_amount')::int = round((select allocated_kg from order_items where order_id=oid and product_id_v2=pLoin) * 3500)::int);

  -- 二重注文防止（同じ request_id）
  v_res2 := portal_place_order(tA,
    jsonb_build_array(jsonb_build_object('product_id', pLoin, 'kg', 3.0)),
    current_date + 1, '0000', null, v_req);
  select count(*) into v_cnt from orders where client_request_id=v_req and customer_id=c1;
  insert into _t values (20,'冪等: 同一request_idの再送は同じ注文を返し二重にならない',
    (v_res2->>'duplicate')::boolean=true and (v_res2->>'order_id')=(v_res->>'order_id') and v_cnt=1);

  -- ══════════ 前回注文の取得（キャンセル除外） ══════════
  v_last := portal_last_order(tA);
  insert into _t values (21,'前回注文: 直近の確定注文を返す',
    v_last is not null and (v_last->>'order_code') = (v_res->>'order_code'));
  update orders set status='キャンセル' where id=oid;   -- 直近をキャンセル
  v_last2 := portal_last_order(tA);
  insert into _t values (22,'前回注文: キャンセル注文は除外し次点(O1)を返す',
    v_last2 is not null and (v_last2->>'id')::uuid = o1);

  -- ══════════ 認可・トークン ══════════
  insert into _t values (23,'不正トークンのusualは空',
    not exists(select 1 from portal_usual_items('bad-token-xyz')));
  begin
    perform portal_place_order('bad-token-xyz',
      jsonb_build_array(jsonb_build_object('product_id', pLoin, 'kg', 1.0)),
      current_date + 1, '0000', null, 'e2e-bad-'||md5(random()::text));
    insert into _t values (24,'不正トークンの注文は拒否', false, '注文できてしまった');
  exception when others then
    insert into _t values (24,'不正トークンの注文は拒否', sqlerrm like '%ログインし直して%', sqlerrm);
  end;
  begin
    perform admin_recompute_usual_items('wrong-key', c1, 'x');
    insert into _t values (25,'誤スタッフキーの再集計は拒否', false, '');
  exception when others then
    insert into _t values (25,'誤スタッフキーの再集計は拒否', sqlerrm like '%スタッフキー%', sqlerrm);
  end;
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
