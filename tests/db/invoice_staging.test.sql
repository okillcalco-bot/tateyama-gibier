-- 請求書ステージングの実DBテスト（migrations/20260811_invoice_staging.sql 対象）
--
-- 実行方法: Supabase SQL Editor（または MCP execute_sql）にこのファイル全体を貼って実行。
-- 全体が begin〜rollback で囲まれており、テストデータ（顧客・取込）は一切残らない。
-- スタッフキーもトランザクション内で一時キーに差し替え、rollbackで元に戻る。
-- 期待結果: すべての行が ok=true。
begin;
create temp table _t(no int, item text, ok boolean, detail text) on commit drop;
do $$
declare v_key text := 'TEST-INV-KEY-' || md5(random()::text);
        v_code text; v_phone text; v_name text; v_cid uuid;
        v_r jsonb; v_imp uuid; v_cnt int;
        c001 uuid; c0011 uuid; zc900 uuid; zc901 uuid;
begin
  update app_secrets set hash = extensions.crypt(v_key, extensions.gen_salt('bf')) where key='staff_key';

  -- ═══════════ A. 基本フロー（投入・冪等・名寄せ・遮断） ═══════════
  select c.code, c.phone, c.name, c.id into v_code, v_phone, v_name, v_cid
    from customers c
   where c.phone is not null and length(regexp_replace(c.phone,'\D','','g')) >= 10
     and c.code is not null
     and 1 = (select count(*) from customers c2
               where regexp_replace(c2.phone,'\D','','g') = regexp_replace(c.phone,'\D','','g'))
   limit 1;

  v_r := admin_invoice_stage_import(v_key, jsonb_build_object(
    'source','local','file_name','mock-invoice.xlsx','mime_type','application/vnd.test',
    'content_hash','testhash-' || md5(random()::text),'page_count',3,
    'documents', jsonb_build_array(
      jsonb_build_object('page_from',1,'invoice_number','INV-001',
        'raw_customer_name', v_name, 'raw_addressee','お客様番号 '||v_code,
        'lines', jsonb_build_array(
          jsonb_build_object('raw_item_name','猪ロース（上）','weight_kg','2.5','unit_price','4750','amount','11875','source_ref','p.1 表1 行1'),
          jsonb_build_object('raw_item_name','猪 カタ','weight_kg','3','unit_price','2900','amount','8700','source_ref','p.1 表1 行2'))),
      jsonb_build_object('page_from',2,'invoice_number','INV-002',
        'raw_customer_name','（判読不能）','raw_phone', v_phone,
        'lines', jsonb_build_array(
          jsonb_build_object('raw_item_name','ミンチ肉','weight_kg','5','unit_price','1800'))),
      jsonb_build_object('page_from',3,'invoice_number','INV-003',
        'raw_customer_name','存在しない商店XYZ',
        'lines', jsonb_build_array(
          jsonb_build_object('raw_item_name','骨付きスペアリブ','weight_kg','1.2')))
    )));
  v_imp := (v_r->>'import_id')::uuid;
  insert into _t values (1,'投入OK（3枚・4行）',
    (v_r->>'ok')::boolean and (v_r->>'documents')::int=3 and (v_r->>'lines')::int=4, v_r::text);

  v_r := admin_invoice_stage_import(v_key, jsonb_build_object(
    'file_name','mock-invoice.xlsx',
    'content_hash', (select content_hash from invoice_imports where id=v_imp)));
  insert into _t values (2,'同じファイルはskip', (v_r->>'skipped')::boolean, v_r::text);
  select count(*) into v_cnt from invoice_imports where id=v_imp;
  insert into _t values (3,'取込行は増えない', v_cnt=1, v_cnt||'件');

  select count(*) into v_cnt from product_name_aliases
   where raw_name in ('猪ロース（上）','猪 カタ','ミンチ肉','骨付きスペアリブ') and decision='未判定';
  insert into _t values (4,'品名4種が未判定で登録', v_cnt=4, v_cnt||'件');

  v_r := admin_invoice_run_matching(v_key, v_imp);
  insert into _t values (5,'名寄せ実行 auto=2', (v_r->>'auto')::int = 2, v_r::text);
  insert into _t values (6,'code印字は1.00で自動確定', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='INV-001'
      and customer_id=v_cid and match_confidence=1.00 and match_status='確定' and match_method='code'));
  insert into _t values (7,'電話一意は0.95で自動確定', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='INV-002'
      and customer_id=v_cid and match_confidence=0.95 and match_status='確定' and match_method='phone'));
  insert into _t values (8,'不明な名称は自動確定しない', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='INV-003'
      and match_status in ('未照合','候補あり') and coalesce(match_confidence,0) < 0.95));
  insert into _t values (9,'取込ステータスは顧客未照合', exists (
    select 1 from invoice_imports where id=v_imp and status='顧客未照合'));

  v_r := admin_invoice_list(v_key, null);
  insert into _t values (10,'一覧に未照合数が出る', exists (
    select 1 from jsonb_array_elements(v_r) e
     where (e->>'id')::uuid = v_imp and (e->>'unmatched_customers')::int = 1
       and (e->>'unmatched_products')::int = 4));

  begin
    set local role anon;
    select count(*) into v_cnt from invoice_lines;
    reset role;
    insert into _t values (11,'anonはinvoice_linesを読めない', false, '読めてしまった');
  exception when insufficient_privilege then
    reset role;
    insert into _t values (11,'anonはinvoice_linesを読めない', true, 'permission denied');
  end;
  begin
    perform admin_invoice_list('wrong-key', null);
    insert into _t values (12,'誤キーで一覧は開けない', false, '');
  exception when others then
    insert into _t values (12,'誤キーで一覧は開けない', sqlerrm like '%スタッフキー%', left(sqlerrm,40));
  end;

  -- ═══════════ B. 顧客コード照合（境界付き完全一致・曖昧時は自動確定しない） ═══════════
  -- テスト用顧客（rollbackで消える）。code は本番に存在しない値を使う。
  -- 包含ペア: ZC90 ⊂ ZC900（C001/C0011 と同じ構図）
  insert into customers (code, name) values ('ZC90','包含テストA店') returning id into c001;
  insert into customers (code, name) values ('ZC900','包含テストB店') returning id into c0011;
  insert into customers (code, name) values ('ZC901','コード単独店') returning id into zc900;
  insert into customers (code, name) values ('ZC902','コード単独店2') returning id into zc901;

  v_r := admin_invoice_stage_import(v_key, jsonb_build_object(
    'file_name','mock-code-cases.xlsx','content_hash','testhash-' || md5(random()::text),
    'documents', jsonb_build_array(
      jsonb_build_object('page_from',1,'invoice_number','B1','note','お客様番号 ZC901'),
      jsonb_build_object('page_from',2,'invoice_number','B2','note','お客様番号 ZC900'),
      jsonb_build_object('page_from',3,'invoice_number','B3','note','お客様番号 ZC90'),
      jsonb_build_object('page_from',5,'invoice_number','B5','note','ZC901 と ZC902 の合算'),
      jsonb_build_object('page_from',6,'invoice_number','B6','note','管理番号 INVZC901X'),
      jsonb_build_object('page_from',7,'invoice_number','B7','note','伝票 INV-ZC901'),
      jsonb_build_object('page_from',8,'invoice_number','B8','note','お客様番号 　ｚｃ９０１　'),
      jsonb_build_object('page_from',9,'invoice_number','B9','raw_customer_name','コード単独店')
    )));
  v_imp := (v_r->>'import_id')::uuid;
  v_r := admin_invoice_run_matching(v_key, v_imp);

  insert into _t values (13,'B1: コード1件完全一致→1.00自動確定', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='B1'
      and customer_id=zc900 and match_confidence=1.00 and match_status='確定'));
  insert into _t values (14,'B2: ZC900印字→ZC900だけに一致(ZC90に誤爆しない)', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='B2'
      and customer_id=c0011 and match_confidence=1.00 and match_status='確定'));
  insert into _t values (15,'B3: ZC90印字→ZC90に一致(ZC900に誤爆しない)', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='B3'
      and customer_id=c001 and match_confidence=1.00 and match_status='確定'));
  -- B4: 「同一コードの顧客が複数」はDBの一意制約(customers_code_key)で発生し得ない。
  --     制約が実際に働くことを実測して証明する（防御ロジック自体は関数側にも実装済み）
  begin
    insert into customers (code, name) values ('ZC901','重複コード店');
    insert into _t values (16,'B4: 同一コードはDB一意制約で作れない', false, '重複が作れてしまった');
  exception when unique_violation then
    insert into _t values (16,'B4: 同一コードはDB一意制約で作れない', true, 'unique_violation');
  end;
  insert into _t values (17,'B5: 複数コード印字→自動確定しない', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='B5'
      and match_status <> '確定' and customer_id is null));
  insert into _t values (18,'B6: 別文字列への埋め込み(INVZC901X)→一致しない', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='B6'
      and match_status = '未照合' and customer_id is null));
  insert into _t values (19,'B7: ハイフン連結(INV-ZC901)→一致しない', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='B7'
      and match_status = '未照合' and customer_id is null));
  insert into _t values (20,'B8: 全角小文字・前後空白でも正規化して一致', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='B8'
      and customer_id=zc900 and match_confidence=1.00 and match_status='確定'));
  insert into _t values (21,'B9: 名称一致は候補提示のみ(自動確定しない)', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='B9'
      and match_status = '候補あり' and coalesce(match_confidence,0) <= 0.50));

  -- 修正後も電話一意の自動確定が動くこと（Aの7で検証済みだが、コード曖昧+電話一意の組合せも確認）
  insert into customers (code, name, phone) values ('ZC903','電話併記店','0470-77-9911');
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object(
    'file_name','mock-code-phone.xlsx','content_hash','testhash-' || md5(random()::text),
    'documents', jsonb_build_array(
      jsonb_build_object('page_from',1,'invoice_number','B10',
        'note','ZC901 と ZC902 の合算分','raw_phone','0470-77-9911'))));
  v_imp := (v_r->>'import_id')::uuid;
  v_r := admin_invoice_run_matching(v_key, v_imp);
  insert into _t values (22,'B10: コード曖昧でも電話一意なら0.95で確定', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='B10'
      and match_confidence=0.95 and match_status='確定' and match_method='phone'));
end $$;
select * from _t order by no;
rollback;
