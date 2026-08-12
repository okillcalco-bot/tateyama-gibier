-- 請求書取込 確認画面まわりの実DBテスト（migrations/20260812_invoice_confirm.sql 対象）
--
-- 実行方法:
--   * psql: psql -v ON_ERROR_STOP=1 -f tests/db/invoice_confirm.test.sql
--     （-v ON_ERROR_STOP=1 は必須。付けないと raise exception 後も rollback まで走り終了コードが0になり得る）
--   * Supabase SQL Editor / API（MCP execute_sql）: ファイル全体を貼って実行し、エラー応答の有無で判定
--
-- 合否: ok=false が1件でもあれば最後のDOブロックが raise exception し、SQL全体がエラー終了する。
--       例外・テストデータ・一時スタッフキーはトランザクションごと rollback され本番に残らない。
--
-- カバー範囲（フェーズ4 2/3 の必須テスト）:
--   §5 コードと電話が別顧客→自動確定拒否 / §4 手動確定 / §7 商品alias確定・対象外・前埋め /
--   §8 金額一致・差額警告・差額理由なしで確定拒否 / §9 未照合明細で確定拒否 /
--   §10 正常反映・連打/再送の二重反映防止・途中エラー全体ロールバック /
--   §11 取消・物理削除しない・取消済み集計除外・二重取消拒否・再反映 /
--   §12 監査記録 / §14 誤スタッフキー拒否・anon直アクセス拒否・内部関数遮断・search_path固定・PUBLIC剥奪
begin;
create temp table _t(no int, item text, ok boolean, detail text) on commit drop;
do $$
declare v_key text := 'TEST-INV-KEY-' || md5(random()::text);
  v_r jsonb; v_imp uuid; v_doc uuid; v_l1 uuid; v_l2 uuid; v_cnt int;
  cA uuid; cB uuid; cC uuid; p1 uuid; p2 uuid; v_facts int;
begin
  update app_secrets set hash = extensions.crypt(v_key, extensions.gen_salt('bf')) where key='staff_key';
  select id into p1 from portal_products where coalesce(is_active,true) order by sort_order limit 1;
  select id into p2 from portal_products where coalesce(is_active,true) and id <> p1 order by sort_order limit 1;

  -- ═══ §5 コードと電話が別顧客 → 自動確定拒否（矛盾警告） ═══
  insert into customers (code, name) values ('CFA001','矛盾コード店') returning id into cA;
  insert into customers (code, name, phone) values ('CFB001','矛盾電話店','0470-99-8877') returning id into cB;
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object('file_name','conf.xlsx','content_hash','th-'||md5(random()::text),
    'documents', jsonb_build_array(jsonb_build_object('page_from',1,'invoice_number','CF1','note','顧客番号 CFA001','raw_phone','0470-99-8877'))));
  v_imp := (v_r->>'import_id')::uuid;
  v_r := admin_invoice_run_matching(v_key, v_imp);
  insert into _t values (1,'§5 矛盾は自動確定しない(conflicts=1)', (v_r->>'conflicts')::int = 1, v_r::text);
  insert into _t values (2,'§5 候補あり+conflict=true+コード側候補', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='CF1'
      and match_status='候補あり' and match_conflict=true and customer_id=cA and conflict_detail like '%矛盾%'));
  select id into v_doc from invoice_documents where import_id=v_imp and invoice_number='CF1';

  -- ═══ §4 人が候補を手動で確定できる（矛盾を解消） ═══
  v_r := admin_invoice_set_customer(v_key, v_doc, '確定', cB, 'テスト職員');
  insert into _t values (3,'§4 手動確定でconflict解消・確定', exists (
    select 1 from invoice_documents where id=v_doc and match_status='確定' and customer_id=cB
      and match_conflict=false and match_method='manual' and customer_confirmed_by='テスト職員'));

  -- ═══ 正常フロー用の完全な取込 ═══
  insert into customers (code, name) values ('OK9001','正常確定店') returning id into cC;
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object('file_name','ok.xlsx','content_hash','th-'||md5(random()::text),
    'documents', jsonb_build_array(jsonb_build_object('page_from',1,'invoice_number','OK1',
      'note','お客様番号 OK9001','invoice_date','2026-08-01','total_amount','20575',
      'lines', jsonb_build_array(
        jsonb_build_object('raw_item_name','猪ロース特上','weight_kg','2.5','unit_price','4750','amount','11875'),
        jsonb_build_object('raw_item_name','猪モモ','weight_kg','3','unit_price','2900','amount','8700'))))));
  v_imp := (v_r->>'import_id')::uuid; v_r := admin_invoice_run_matching(v_key, v_imp);
  select id into v_doc from invoice_documents where import_id=v_imp and invoice_number='OK1';
  select id into v_l1 from invoice_lines where document_id=v_doc and raw_item_name='猪ロース特上';
  select id into v_l2 from invoice_lines where document_id=v_doc and raw_item_name='猪モモ';
  insert into _t values (4,'コード自動確定済み', exists (select 1 from invoice_documents where id=v_doc and match_status='確定' and customer_id=cC));

  -- ═══ §8 金額検算: total=sum → 差額0 ═══
  v_r := admin_invoice_detail(v_key, v_imp);
  insert into _t values (5,'§8 明細合計=請求書合計(差額0)', exists (
    select 1 from jsonb_array_elements(v_r->'documents') d where (d->>'invoice_number')='OK1'
      and (d->>'lines_amount_sum')::numeric = 20575 and (d->>'amount_diff')::numeric = 0));

  -- ═══ §9 未照合明細があると確定拒否・拒否時は実績0件 ═══
  begin v_r := admin_invoice_finalize(v_key, v_imp, 'テスト職員');
    insert into _t values (6,'§9 商品未対応で反映拒否', false, '反映できてしまった');
  exception when others then insert into _t values (6,'§9 商品未対応で反映拒否', sqlerrm like '%商品が未対応%', left(sqlerrm,40)); end;
  select count(*) into v_cnt from customer_purchase_facts where source_id in (v_l1,v_l2);
  insert into _t values (7,'§9 拒否時は実績0件', v_cnt=0, v_cnt||'');

  -- ═══ §7 商品対応づけ（alias確定） ═══
  v_r := admin_invoice_map_product(v_key, v_l1, '対応づけ', p1, 'テスト職員');
  v_r := admin_invoice_map_product(v_key, v_l2, '対応づけ', p2, 'テスト職員');
  insert into _t values (8,'§7 明細が確定・product_id付与', (select count(*) from invoice_lines where document_id=v_doc and match_status='確定' and product_id is not null)=2);
  insert into _t values (9,'§7 aliasが対応づけで保存(次回候補)', exists (
    select 1 from product_name_aliases where raw_name='猪ロース特上' and decision='対応づけ' and product_id=p1 and decided_by='テスト職員'));
  insert into _t values (10,'全確定でステータス確認済', exists (select 1 from invoice_imports where id=v_imp and status='確認済'));

  -- ═══ §10 正常な実績反映 ═══
  v_r := admin_invoice_finalize(v_key, v_imp, 'テスト職員');
  insert into _t values (11,'§10 反映OK(facts=2)', (v_r->>'ok')::boolean and (v_r->>'facts')::int=2 and not (v_r->>'already')::boolean, v_r::text);
  select count(*) into v_facts from customer_purchase_facts where source_id in (v_l1,v_l2) and customer_id=cC and canceled_at is null;
  insert into _t values (12,'§10 実績2件・購入日=請求日・重量金額一致', v_facts=2 and exists(
    select 1 from customer_purchase_facts where source_id=v_l1 and purchased_on='2026-08-01' and product_id=p1 and weight_kg=2.5 and amount=11875), v_facts||'');
  insert into _t values (13,'§10 取込済へ・finalized_by記録', exists (select 1 from invoice_imports where id=v_imp and status='取込済' and finalized_by='テスト職員' and finalized_at is not null));

  -- ═══ §10 連打・再送で二重反映しない ═══
  v_r := admin_invoice_finalize(v_key, v_imp, 'テスト職員');
  select count(*) into v_cnt from customer_purchase_facts where source_id in (v_l1,v_l2);
  insert into _t values (14,'§10 再反映はalready=true・件数不変', (v_r->>'already')::boolean and v_cnt=2, v_r::text||' cnt='||v_cnt);

  -- ═══ §11 取消（物理削除しない・監査） ═══
  v_r := admin_invoice_cancel(v_key, v_imp, '請求書差し替えのため', 'テスト職員');
  insert into _t values (15,'§11 取消OK(canceled_facts=2)', (v_r->>'canceled_facts')::int=2, v_r::text);
  select count(*) into v_cnt from customer_purchase_facts where source_id in (v_l1,v_l2);
  insert into _t values (16,'§11 実績は物理削除しない(行は残る)', v_cnt=2, v_cnt||'');
  insert into _t values (17,'§11 canceled_at/by/reasonが入る', exists (
    select 1 from customer_purchase_facts where source_id=v_l1 and canceled_at is not null
      and canceled_by='テスト職員' and cancel_reason='請求書差し替えのため'));
  insert into _t values (18,'§11 集計除外用: 有効な実績は0件', 0=(select count(*) from customer_purchase_facts where source_id in (v_l1,v_l2) and canceled_at is null), '');
  insert into _t values (19,'§11 取消後は確認済へ(再反映可)', exists (select 1 from invoice_imports where id=v_imp and status='確認済'));

  -- ═══ §11 二重取消拒否 ═══
  begin v_r := admin_invoice_cancel(v_key, v_imp, '二度目', 'テスト職員');
    insert into _t values (20,'§11 二重取消拒否', false, '取消できてしまった');
  exception when others then insert into _t values (20,'§11 二重取消拒否', sqlerrm like '%取込済%', left(sqlerrm,40)); end;

  -- ═══ §11 取消後の再反映（同じsource_idを復活・増えない） ═══
  v_r := admin_invoice_finalize(v_key, v_imp, 'テスト職員2');
  select count(*) into v_facts from customer_purchase_facts where source_id in (v_l1,v_l2) and canceled_at is null;
  insert into _t values (21,'§11 再反映で復活・増えない', v_facts=2 and (select count(*) from customer_purchase_facts where source_id in (v_l1,v_l2))=2, v_facts||'');

  -- ═══ §8 差額あり → 要確認・理由なしで確定拒否・理由入力で通る ═══
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object('file_name','diff.xlsx','content_hash','th-'||md5(random()::text),
    'documents', jsonb_build_array(jsonb_build_object('page_from',1,'invoice_number','DF1',
      'note','お客様番号 OK9001','invoice_date','2026-08-02','total_amount','12000',
      'lines', jsonb_build_array(jsonb_build_object('raw_item_name','猪ロース特上','weight_kg','2.5','unit_price','4750','amount','11875'))))));
  v_imp := (v_r->>'import_id')::uuid; v_r := admin_invoice_run_matching(v_key, v_imp);
  select id into v_doc from invoice_documents where import_id=v_imp and invoice_number='DF1';
  select id into v_l1 from invoice_lines where document_id=v_doc limit 1;
  insert into _t values (22,'§7 alias前埋めで明細確定', exists (select 1 from invoice_lines where id=v_l1 and match_status='確定' and match_method='alias' and product_id=p1));
  insert into _t values (23,'§8 差額125円で要確認', exists (select 1 from invoice_imports where id=v_imp and status='要確認'));
  begin v_r := admin_invoice_finalize(v_key, v_imp, 'テスト職員');
    insert into _t values (24,'§8 差額理由なしで反映拒否', false, '反映できてしまった');
  exception when others then insert into _t values (24,'§8 差額理由なしで反映拒否', sqlerrm like '%差額%' or sqlerrm like '%理由%', left(sqlerrm,40)); end;
  v_r := admin_invoice_set_amount_reason(v_key, v_doc, '端数値引き', '値引き', 'テスト職員');
  insert into _t values (25,'§8 理由入力で確認済へ', (v_r->>'status')='確認済', v_r::text);
  v_r := admin_invoice_finalize(v_key, v_imp, 'テスト職員');
  insert into _t values (26,'§8 理由ありなら反映できる', (v_r->>'facts')::int=1, v_r::text);

  -- ═══ §7 商品対象外は反映されず・ブロックもしない ═══
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object('file_name','excl.xlsx','content_hash','th-'||md5(random()::text),
    'documents', jsonb_build_array(jsonb_build_object('page_from',1,'invoice_number','EX1','note','お客様番号 OK9001','invoice_date','2026-08-03',
      'lines', jsonb_build_array(
        jsonb_build_object('raw_item_name','送料','amount','800'),
        jsonb_build_object('raw_item_name','猪バラ新商品','weight_kg','1.5','unit_price','2000','amount','3000'))))));
  v_imp := (v_r->>'import_id')::uuid; v_r := admin_invoice_run_matching(v_key, v_imp);
  select id into v_doc from invoice_documents where import_id=v_imp and invoice_number='EX1';
  select id into v_l1 from invoice_lines where document_id=v_doc and raw_item_name='送料';
  select id into v_l2 from invoice_lines where document_id=v_doc and raw_item_name='猪バラ新商品';
  v_r := admin_invoice_map_product(v_key, v_l1, '対象外', null, 'テスト職員');
  v_r := admin_invoice_map_product(v_key, v_l2, '対応づけ', p1, 'テスト職員');
  v_r := admin_invoice_finalize(v_key, v_imp, 'テスト職員');
  insert into _t values (27,'§7 対象外明細は反映されない(facts=1)', (v_r->>'facts')::int=1, v_r::text);
  insert into _t values (28,'§7 送料(対象外)は実績に無い', not exists (select 1 from customer_purchase_facts where source_id=v_l1), '');

  -- ═══ §10 途中エラーで全体ロールバック（顧客未確定のdocが混在） ═══
  insert into customers (code, name) values ('RB9001','ロールバック店') returning id into cC;
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object('file_name','rb.xlsx','content_hash','th-'||md5(random()::text),
    'documents', jsonb_build_array(
      jsonb_build_object('page_from',1,'invoice_number','RB1','note','お客様番号 RB9001','invoice_date','2026-08-04',
        'lines', jsonb_build_array(jsonb_build_object('raw_item_name','猪ロース特上','weight_kg','2','unit_price','4750','amount','9500'))),
      jsonb_build_object('page_from',2,'invoice_number','RB2','raw_customer_name','誰も一致しない謎の店XYZ',
        'lines', jsonb_build_array(jsonb_build_object('raw_item_name','謎の品','weight_kg','1','amount','100'))))));
  v_imp := (v_r->>'import_id')::uuid; v_r := admin_invoice_run_matching(v_key, v_imp);
  select l.id into v_l1 from invoice_lines l join invoice_documents d on d.id=l.document_id where d.import_id=v_imp and d.invoice_number='RB1';
  begin v_r := admin_invoice_finalize(v_key, v_imp, 'テスト職員');
    insert into _t values (29,'§10 一部未確定で反映拒否', false, '反映できた');
  exception when others then insert into _t values (29,'§10 一部未確定で反映拒否', sqlerrm like '%未確定%' or sqlerrm like '%未対応%', left(sqlerrm,40)); end;
  select count(*) into v_cnt from customer_purchase_facts where source_id=v_l1;
  insert into _t values (30,'§10 RB1の実績も作られない（全体ロールバック）', v_cnt=0, v_cnt||'');

  -- ═══ §12 監査記録 ═══
  insert into _t values (31,'§12 監査にfinalize/cancel/customer_confirm/product_map/amount_reason', (
    select count(distinct action) from invoice_audit where action in ('finalize','cancel','customer_confirm','product_map','amount_reason'))>=5, '');

  -- ═══ §14 誤スタッフキーで各RPC拒否 ═══
  begin v_r := admin_invoice_detail('wrong', v_imp); insert into _t values (32,'誤キーでdetail拒否', false,'');
  exception when others then insert into _t values (32,'誤キーでdetail拒否', sqlerrm like '%スタッフキー%',''); end;
  begin v_r := admin_invoice_finalize('wrong', v_imp); insert into _t values (33,'誤キーでfinalize拒否', false,'');
  exception when others then insert into _t values (33,'誤キーでfinalize拒否', sqlerrm like '%スタッフキー%',''); end;
  begin v_r := admin_invoice_cancel('wrong', v_imp, 'x'); insert into _t values (34,'誤キーでcancel拒否', false,'');
  exception when others then insert into _t values (34,'誤キーでcancel拒否', sqlerrm like '%スタッフキー%',''); end;

  -- ═══ §14 anon直アクセス拒否（invoice_audit） ═══
  begin set local role anon; perform count(*) from invoice_audit; reset role;
    insert into _t values (35,'anon invoice_audit SELECT拒否', false,'読めた');
  exception when insufficient_privilege then reset role; insert into _t values (35,'anon invoice_audit SELECT拒否', true,''); end;

  -- ═══ §14 内部関数はanon実行不可 ═══
  insert into _t values (36,'内部関数はanon実行不可', not has_function_privilege('anon','_invoice_recompute_import_status(uuid)','execute')
    and not has_function_privilege('anon','_invoice_audit(uuid,uuid,uuid,text,text,text)','execute'), '');

  -- ═══ §14 新RPCのsearch_path固定・PUBLIC剥奪 ═══
  insert into _t values (37,'新RPC9本 search_path固定', (select count(*) from pg_proc p where p.proname in
    ('admin_invoice_detail','admin_invoice_set_customer','admin_invoice_map_product','admin_invoice_finalize','admin_invoice_cancel','admin_invoice_set_amount_reason','admin_invoice_customer_search','admin_invoice_products','admin_invoice_exclude_import')
    and p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%'))=9, '');
  insert into _t values (38,'新RPC PUBLIC EXECUTE無し', not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a where p.pronamespace='public'::regnamespace
      and p.proname='admin_invoice_finalize' and a.grantee=0 and a.privilege_type='EXECUTE'), '');
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
