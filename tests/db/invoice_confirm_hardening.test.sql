-- 請求書取込 ハードニングの実DBテスト（migrations/20260813_invoice_confirm_hardening.sql 対象）
--
-- 実行方法:
--   psql -v ON_ERROR_STOP=1 -f tests/db/invoice_confirm_hardening.test.sql
--   （ON_ERROR_STOP=1 は必須。SQL Editor / API はファイル全体を貼って実行しエラー応答で判定）
--
-- カバー範囲（Codexレビュー対応）:
--   修正1 反映済み(取込済)・除外の編集をサーバ側で拒否・親行ロックで直列化
--   修正2 顧客検索の数字桁ガード・80字上限・LIKEワイルドカードのエスケープ
--   修正3 商品対応づけの残存値クリア（別商品・対象外）
--   修正4 担当者名(p_by)必須（空白拒否・'staff'フォールバック廃止）
--   追加5 新RPC9本の認可・内部関数の遮断・invoice_audit のRLS実測
begin;
create temp table _t(no int, item text, ok boolean, detail text) on commit drop;
do $$
declare v_key text := 'TEST-INV-KEY-' || md5(random()::text);
  v_r jsonb; v_imp uuid; v_doc uuid; v_l1 uuid; v_l2 uuid; v_cnt int;
  cC uuid; cD uuid; p1 uuid; p2 uuid; zmp uuid; aaa uuid; pht uuid; v_no int; v_op text; v_fn text;
begin
  update app_secrets set hash = extensions.crypt(v_key, extensions.gen_salt('bf')) where key='staff_key';
  select id into p1 from portal_products where coalesce(is_active,true) order by sort_order limit 1;
  select id into p2 from portal_products where coalesce(is_active,true) and id<>p1 order by sort_order limit 1;

  -- 完全な取込を作る
  insert into customers (code, name) values ('OK9001','正常確定店') returning id into cC;
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object('file_name','ok.xlsx','content_hash','th-'||md5(random()::text),
    'documents', jsonb_build_array(jsonb_build_object('page_from',1,'invoice_number','OK1','note','お客様番号 OK9001','invoice_date','2026-08-01','total_amount','20575',
      'lines', jsonb_build_array(
        jsonb_build_object('raw_item_name','猪ロース特上','weight_kg','2.5','unit_price','4750','amount','11875'),
        jsonb_build_object('raw_item_name','猪モモ','weight_kg','3','unit_price','2900','amount','8700'))))));
  v_imp := (v_r->>'import_id')::uuid; v_r := admin_invoice_run_matching(v_key, v_imp);
  select id into v_doc from invoice_documents where import_id=v_imp;
  select id into v_l1 from invoice_lines where document_id=v_doc and raw_item_name='猪ロース特上';
  select id into v_l2 from invoice_lines where document_id=v_doc and raw_item_name='猪モモ';

  -- 修正4: 担当者名必須（空白拒否）
  begin v_r := admin_invoice_set_customer(v_key, v_doc, '確定', cC, '   ');
    insert into _t values (1,'担当者名 空白は拒否', false,'通った');
  exception when others then insert into _t values (1,'担当者名 空白は拒否', sqlerrm like '%担当者名%', left(sqlerrm,30)); end;
  begin v_r := admin_invoice_map_product(v_key, v_l1, '対応づけ', p1, '');
    insert into _t values (2,'map_product 担当者空は拒否', false,'');
  exception when others then insert into _t values (2,'map_product 担当者空は拒否', sqlerrm like '%担当者名%', ''); end;

  -- 正常に確定→反映
  v_r := admin_invoice_set_customer(v_key, v_doc, '確定', cC, 'テスト職員');
  v_r := admin_invoice_map_product(v_key, v_l1, '対応づけ', p1, 'テスト職員');
  v_r := admin_invoice_map_product(v_key, v_l2, '対応づけ', p2, 'テスト職員');
  v_r := admin_invoice_finalize(v_key, v_imp, 'テスト職員');
  insert into _t values (3,'反映OK(取込済)', (v_r->>'facts')::int=2 and exists(select 1 from invoice_imports where id=v_imp and status='取込済'), v_r::text);

  -- 修正1: 取込済で編集RPC直接呼び→拒否
  begin v_r := admin_invoice_set_customer(v_key, v_doc, '未照合', null, 'テスト職員');
    insert into _t values (4,'取込済でset_customer拒否', false,'変更できた');
  exception when others then insert into _t values (4,'取込済でset_customer拒否', sqlerrm like '%編集できません%', left(sqlerrm,40)); end;
  begin v_r := admin_invoice_map_product(v_key, v_l1, '別商品', null, 'テスト職員');
    insert into _t values (5,'取込済でmap_product拒否', false,'変更できた');
  exception when others then insert into _t values (5,'取込済でmap_product拒否', sqlerrm like '%編集できません%', left(sqlerrm,40)); end;
  begin v_r := admin_invoice_set_amount_reason(v_key, v_doc, 'x', null, 'テスト職員');
    insert into _t values (6,'取込済でset_amount_reason拒否', false,'変更できた');
  exception when others then insert into _t values (6,'取込済でset_amount_reason拒否', sqlerrm like '%編集できません%', left(sqlerrm,40)); end;

  -- 取込済でrun_matching→対象外(変更なし)
  update invoice_documents set match_status='未照合', customer_id=null where id=v_doc;
  v_r := admin_invoice_run_matching(v_key, v_imp);
  insert into _t values (7,'取込済でrun_matchingは対象外(変更なし)', exists(select 1 from invoice_documents where id=v_doc and match_status='未照合') and (v_r->>'auto')::int=0, v_r::text);
  update invoice_documents set match_status='確定', customer_id=cC where id=v_doc;

  -- 修正1: 取消→確認済で編集可能→商品変更→再反映で更新・行数不変
  v_r := admin_invoice_cancel(v_key, v_imp, '差し替え', 'テスト職員');
  insert into _t values (8,'取消で確認済へ', (v_r->>'status')='確認済');
  select count(*) into v_cnt from customer_purchase_facts where source_id in (v_l1,v_l2);
  v_r := admin_invoice_map_product(v_key, v_l1, '対応づけ', p2, 'テスト職員2');
  insert into _t values (9,'取消後(確認済)は編集可能', exists(select 1 from invoice_lines where id=v_l1 and product_id=p2));
  v_r := admin_invoice_finalize(v_key, v_imp, 'テスト職員2');
  insert into _t values (10,'取消→商品変更→再反映でfacts更新', exists(select 1 from customer_purchase_facts where source_id=v_l1 and product_id=p2 and canceled_at is null));
  insert into _t values (11,'再反映で行数不変', (select count(*) from customer_purchase_facts where source_id in (v_l1,v_l2))=v_cnt, v_cnt||'');

  -- 取消→顧客変更→再反映で更新・行数不変
  insert into customers (code,name) values ('OK9002','別の確定店') returning id into cD;
  v_r := admin_invoice_cancel(v_key, v_imp, '顧客違い', 'テスト職員');
  v_r := admin_invoice_set_customer(v_key, v_doc, '確定', cD, 'テスト職員');
  v_r := admin_invoice_finalize(v_key, v_imp, 'テスト職員');
  insert into _t values (12,'取消→顧客変更→再反映でcustomer更新', exists(select 1 from customer_purchase_facts where source_id=v_l1 and customer_id=cD and canceled_at is null));
  insert into _t values (13,'顧客変更の再反映も行数不変', (select count(*) from customer_purchase_facts where source_id in (v_l1,v_l2))=v_cnt, '');

  -- 除外中の編集拒否
  v_r := admin_invoice_cancel(v_key, v_imp, '除外テスト', 'テスト職員');
  v_r := admin_invoice_exclude_import(v_key, v_imp, true, 'テスト職員');
  begin v_r := admin_invoice_set_customer(v_key, v_doc, '未照合', null, 'テスト職員');
    insert into _t values (14,'除外中の編集拒否', false,'');
  exception when others then insert into _t values (14,'除外中の編集拒否', sqlerrm like '%編集できません%', left(sqlerrm,30)); end;
  v_r := admin_invoice_exclude_import(v_key, v_imp, false, 'テスト職員');

  -- 修正3: alias残存値クリア（別商品・対象外）
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object('file_name','res.xlsx','content_hash','th-'||md5(random()::text),
    'documents', jsonb_build_array(jsonb_build_object('page_from',1,'invoice_number','RS1','note','お客様番号 OK9001','invoice_date','2026-08-05',
      'lines', jsonb_build_array(jsonb_build_object('raw_item_name','残存テスト品','weight_kg','1','amount','1000'))))));
  v_imp := (v_r->>'import_id')::uuid; v_r := admin_invoice_run_matching(v_key, v_imp);
  select id into v_doc from invoice_documents where import_id=v_imp;
  select id into v_l1 from invoice_lines where document_id=v_doc;
  v_r := admin_invoice_map_product(v_key, v_l1, '対応づけ', p1, 'テスト職員');
  v_r := admin_invoice_map_product(v_key, v_l1, '別商品', null, 'テスト職員2');
  insert into _t values (15,'別商品で line.product_id=null・保留', exists(select 1 from invoice_lines where id=v_l1 and product_id is null and match_status='保留'));
  insert into _t values (16,'別商品で line.product_decided_by更新', exists(select 1 from invoice_lines where id=v_l1 and product_decided_by='テスト職員2'));
  insert into _t values (17,'別商品で alias.product_id=null・担当更新', exists(select 1 from product_name_aliases where raw_name='残存テスト品' and product_id is null and decision='別商品' and decided_by='テスト職員2'));
  v_r := admin_invoice_map_product(v_key, v_l1, '対応づけ', p1, 'テスト職員');
  v_r := admin_invoice_map_product(v_key, v_l1, '対象外', null, 'テスト職員3');
  insert into _t values (18,'対象外で alias.product_id=null・担当更新', exists(select 1 from product_name_aliases where raw_name='残存テスト品' and product_id is null and decision='対象外' and decided_by='テスト職員3'));

  -- 修正2: 顧客検索
  insert into customers (code,name) values ('AAA000','先頭コード店') returning id into aaa;
  insert into customers (code,name,kana) values ('ZMS777','ズミテスト特殊店','ズミテストトクシュテン') returning id into zmp;
  insert into customers (code,name,phone) values ('PHT111','電話下4桁店','0470-55-6789') returning id into pht;
  v_r := admin_invoice_customer_search(v_key, 'ズミテスト特殊', 25);
  insert into _t values (19,'日本語店名検索は該当のみ(無関係含まない)',
    exists(select 1 from jsonb_array_elements(v_r) e where (e->>'id')::uuid=zmp)
    and not exists(select 1 from jsonb_array_elements(v_r) e where (e->>'id')::uuid=aaa), v_r::text);
  v_r := admin_invoice_customer_search(v_key, 'ズミテストトクシュ', 25);
  insert into _t values (20,'カナ検索', exists(select 1 from jsonb_array_elements(v_r) e where (e->>'id')::uuid=zmp));
  v_r := admin_invoice_customer_search(v_key, 'ZMS777', 25);
  insert into _t values (21,'コード検索', exists(select 1 from jsonb_array_elements(v_r) e where (e->>'id')::uuid=zmp));
  v_r := admin_invoice_customer_search(v_key, '6789', 25);
  insert into _t values (22,'電話下4桁検索', exists(select 1 from jsonb_array_elements(v_r) e where (e->>'id')::uuid=pht));
  v_r := admin_invoice_customer_search(v_key, 'ズミテスト特殊', 25);
  insert into _t values (23,'数字なし語で電話条件は無効(AAA000返さない)', not exists(select 1 from jsonb_array_elements(v_r) e where (e->>'id')::uuid=aaa));
  v_r := admin_invoice_customer_search(v_key, '%', 25);
  insert into _t values (24,'「%」だけは全件返さない', not exists(select 1 from jsonb_array_elements(v_r) e where (e->>'id')::uuid in (aaa,zmp)), v_r::text);
  v_r := admin_invoice_customer_search(v_key, '_', 25);
  insert into _t values (25,'「_」だけは全件返さない', not exists(select 1 from jsonb_array_elements(v_r) e where (e->>'id')::uuid in (aaa,zmp)));
  v_r := admin_invoice_customer_search(v_key, '   ', 25);
  insert into _t values (26,'空白だけは空配列', v_r = '[]'::jsonb, v_r::text);
  begin v_r := admin_invoice_customer_search(v_key, repeat('あ',81), 25);
    insert into _t values (27,'81文字以上は拒否', false,'通った');
  exception when others then insert into _t values (27,'81文字以上は拒否', sqlerrm like '%長すぎ%', left(sqlerrm,30)); end;

  -- 追加5: 認可（新RPC9本：PUBLIC無・anon/authenticated有・definer・search_path固定）
  insert into _t values (28,'新RPC9本 PUBLIC無/anon・auth有/definer/path固定', (
    select count(*) from pg_proc p where p.pronamespace='public'::regnamespace
      and p.proname in ('admin_invoice_detail','admin_invoice_customer_search','admin_invoice_products',
        'admin_invoice_set_customer','admin_invoice_map_product','admin_invoice_set_amount_reason',
        'admin_invoice_finalize','admin_invoice_cancel','admin_invoice_exclude_import')
      and p.prosecdef and exists(select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')
      and not exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE')
      and has_function_privilege('anon', p.oid, 'execute') and has_function_privilege('authenticated', p.oid, 'execute'))=9, '');
  -- 内部関数4本の遮断
  insert into _t values (29,'内部関数4本 PUBLIC/anon/authenticated 実行不可', (
    select count(*) from pg_proc p where p.pronamespace='public'::regnamespace
      and p.proname in ('_invoice_actor','_invoice_lock_editable','_invoice_audit','_invoice_recompute_import_status')
      and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
      and not exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE'))=4, '');

  -- 誤スタッフキーで代表RPC拒否
  v_no := 30;
  begin perform admin_invoice_detail('wrong', v_imp); insert into _t values (v_no,'誤キーdetail拒否',false,'');
  exception when others then insert into _t values (v_no,'誤キーdetail拒否', sqlerrm like '%スタッフキー%',''); end; v_no:=v_no+1;
  begin perform admin_invoice_products('wrong'); insert into _t values (v_no,'誤キーproducts拒否',false,'');
  exception when others then insert into _t values (v_no,'誤キーproducts拒否', sqlerrm like '%スタッフキー%',''); end; v_no:=v_no+1;
  begin perform admin_invoice_customer_search('wrong','x'); insert into _t values (v_no,'誤キーsearch拒否',false,'');
  exception when others then insert into _t values (v_no,'誤キーsearch拒否', sqlerrm like '%スタッフキー%',''); end; v_no:=v_no+1;
  begin perform admin_invoice_map_product('wrong', v_l1, '対象外', null, 'x'); insert into _t values (v_no,'誤キーmap拒否',false,'');
  exception when others then insert into _t values (v_no,'誤キーmap拒否', sqlerrm like '%スタッフキー%',''); end; v_no:=v_no+1;

  -- invoice_audit RLS: anon/authenticated × SELECT/INSERT/UPDATE/DELETE をすべて拒否
  v_no := 34;
  foreach v_op in array array['anon','authenticated'] loop
    foreach v_fn in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      begin execute format('set local role %I', v_op);
        case v_fn when 'SELECT' then perform count(*) from invoice_audit;
          when 'INSERT' then insert into invoice_audit(action) values('x');
          when 'UPDATE' then update invoice_audit set action=action;
          when 'DELETE' then delete from invoice_audit; end case;
        reset role; insert into _t values (v_no,'invoice_audit '||v_op||' '||v_fn||'拒否', false,'できた');
      exception when insufficient_privilege then reset role; insert into _t values (v_no,'invoice_audit '||v_op||' '||v_fn||'拒否', true,'');
      when others then reset role; insert into _t values (v_no,'invoice_audit '||v_op||' '||v_fn||'拒否', false, sqlerrm); end;
      v_no := v_no+1;
    end loop;
  end loop;
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
