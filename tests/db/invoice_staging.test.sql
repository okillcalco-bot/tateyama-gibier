-- 請求書ステージングの実DBテスト（migrations/20260811_invoice_staging.sql 対象）
--
-- 実行方法:
--   * psql の場合（-v ON_ERROR_STOP=1 は必須。付けないと raise exception 後も後続の
--     rollback まで実行され、終了コードが0になることがある）:
--       psql -v ON_ERROR_STOP=1 -f tests/db/invoice_staging.test.sql
--   * Supabase SQL Editor / API（MCP execute_sql）の場合: ファイル全体を貼って実行し、
--     エラー応答の有無を確認する
--
-- 合否の機械判定: ok=false が1件でも存在した場合はテスト失敗とする。
--   * 全件PASS → 結果表が表示され、最後に NOTICE『ALL TESTS PASSED』が出て rollback で終わる
--   * 1件でもFAIL → 最後のDOブロックが raise exception し、SQL全体がエラー終了する
--     （例外メッセージに失敗したテスト名の一覧が入るため、結果表を目視しなくても検知できる。
--       psqlでは ON_ERROR_STOP=1 により終了ステータス非0、SQL Editor / API ではエラー応答になる）
--   * 例外で中断した場合もトランザクションごと巻き戻るため、テストデータ・一時スタッフキーは
--     本番に一切残らない
begin;
create temp table _t(no int, item text, ok boolean, detail text) on commit drop;
do $$
declare v_key text := 'TEST-INV-KEY-' || md5(random()::text);
        v_code text; v_phone text; v_name text; v_cid uuid;
        v_r jsonb; v_imp uuid; v_cnt int; v_hash text;
        c001 uuid; c0011 uuid; zc900 uuid; zc901 uuid;
        n2026 uuid; n1000 uuid; n0470 uuid; n5566 uuid; hy901 uuid; hy77 uuid;
        v_tbl text; v_op text; v_ok boolean; v_no int;
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
  insert into _t values (2,'同じファイルはskip（既存idを返す）',
    (v_r->>'skipped')::boolean and (v_r->>'import_id')::uuid = v_imp, v_r::text);
  select count(*) into v_cnt from invoice_imports where id=v_imp;
  insert into _t values (3,'取込行は増えない', v_cnt=1, v_cnt||'件');

  select count(*) into v_cnt from product_name_aliases
   where raw_name in ('猪ロース（上）','猪 カタ','ミンチ肉','骨付きスペアリブ') and decision='未判定';
  insert into _t values (4,'品名4種が未判定で登録', v_cnt=4, v_cnt||'件');

  v_r := admin_invoice_run_matching(v_key, v_imp);
  insert into _t values (5,'名寄せ実行 auto=2', (v_r->>'auto')::int = 2, v_r::text);
  insert into _t values (6,'code印字は1.00で確定(matched_by=auto)', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='INV-001'
      and customer_id=v_cid and match_confidence=1.00 and match_status='確定'
      and match_method='code' and matched_by='auto'));
  insert into _t values (7,'電話一意は0.95で確定(matched_by=auto)', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='INV-002'
      and customer_id=v_cid and match_confidence=0.95 and match_status='確定'
      and match_method='phone' and matched_by='auto'));
  insert into _t values (8,'不明な名称は確定しない', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='INV-003'
      and match_status in ('未照合','候補あり') and coalesce(match_confidence,0) < 0.95));
  insert into _t values (9,'取込ステータスは顧客未照合', exists (
    select 1 from invoice_imports where id=v_imp and status='顧客未照合'));

  v_r := admin_invoice_list(v_key, null);
  insert into _t values (10,'一覧に未照合数が出る', exists (
    select 1 from jsonb_array_elements(v_r) e
     where (e->>'id')::uuid = v_imp and (e->>'unmatched_customers')::int = 1
       and (e->>'unmatched_products')::int = 4));

  -- ═══════════ B. 顧客コード照合（境界付き完全一致・曖昧時は確定しない） ═══════════
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

  insert into _t values (13,'B1: コード1件完全一致→1.00確定', exists (
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
  insert into _t values (17,'B5: 複数コード印字→確定しない', exists (
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
  insert into _t values (21,'B9: 名称一致は候補提示のみ(確定しない)', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='B9'
      and match_status = '候補あり' and coalesce(match_confidence,0) <= 0.50));

  -- 修正後も電話一意の自動確定が動くこと（コード曖昧+電話一意の組合せ）
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

  -- ═══════════ C. 数字だけの顧客コード（ラベル直後のみ一致） ═══════════
  insert into customers (code, name) values ('2026','数字コード店') returning id into n2026;
  insert into customers (code, name) values ('1000','数字コード店2') returning id into n1000;
  insert into customers (code, name, phone) values ('0470123456','数字コード店3','0470-12-3456') returning id into n0470;
  insert into customers (code, name) values ('5566','数字コード店4') returning id into n5566;

  v_r := admin_invoice_stage_import(v_key, jsonb_build_object(
    'file_name','mock-numeric-codes.xlsx','content_hash','testhash-' || md5(random()::text),
    'documents', jsonb_build_array(
      jsonb_build_object('page_from',1,'invoice_number','C1','note','2026年度請求分'),
      jsonb_build_object('page_from',2,'invoice_number','C2','note','お客様番号：2026'),
      jsonb_build_object('page_from',3,'invoice_number','C3','raw_phone','0470-12-3456','note','ご請求'),
      jsonb_build_object('page_from',4,'invoice_number','C4','note','ご請求額 1,000円（税込）'),
      jsonb_build_object('page_from',5,'invoice_number','C5','note','顧客番号 2026 ／ 得意先コード 5566 の合算'),
      jsonb_build_object('page_from',6,'invoice_number','C6','note','顧客コード 1000')
    )));
  v_imp := (v_r->>'import_id')::uuid;
  v_r := admin_invoice_run_matching(v_key, v_imp);

  insert into _t values (23,'C1: 数字コード2026 vs「2026年度」→一致しない', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='C1'
      and match_status='未照合' and customer_id is null));
  insert into _t values (24,'C2: 「お客様番号：2026」→1.00確定', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='C2'
      and customer_id=n2026 and match_confidence=1.00 and match_status='確定' and match_method='code'));
  insert into _t values (25,'C3: 数字コードと同値のraw_phone→コードでなく電話照合(0.95)', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='C3'
      and customer_id=n0470 and match_confidence=0.95 and match_method='phone'));
  insert into _t values (26,'C4: 金額表記「1,000円」→一致しない', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='C4'
      and match_status='未照合' and customer_id is null));
  insert into _t values (27,'C5: ラベル付き数字コードが複数→確定しない', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='C5'
      and match_status <> '確定' and customer_id is null));
  insert into _t values (28,'C6: 「顧客コード 1000」→1.00確定（ラベル別表記）', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='C6'
      and customer_id=n1000 and match_confidence=1.00 and match_status='確定'));

  -- ═══════════ D. ハイフン表記の正規化 ═══════════
  insert into customers (code, name) values ('ZC-901','ハイフンコード店') returning id into hy901;
  insert into customers (code, name) values ('ZC77-','末尾ハイフン店') returning id into hy77;

  v_r := admin_invoice_stage_import(v_key, jsonb_build_object(
    'file_name','mock-hyphen-codes.xlsx','content_hash','testhash-' || md5(random()::text),
    'documents', jsonb_build_array(
      jsonb_build_object('page_from',1,'invoice_number','D1','note','お客様番号 ZC－901'),   -- U+FF0D
      jsonb_build_object('page_from',2,'invoice_number','D2','note','お客様番号 ZC–901'),   -- U+2013
      jsonb_build_object('page_from',3,'invoice_number','D3','note','お客様番号 ZC—901'),   -- U+2014
      jsonb_build_object('page_from',4,'invoice_number','D4','note','お客様番号 ZC−901'),   -- U+2212
      jsonb_build_object('page_from',5,'invoice_number','D5','note','コード ZC77- を参照'),
      jsonb_build_object('page_from',6,'invoice_number','D6','note','伝票 INV-ZC-901')
    )));
  v_imp := (v_r->>'import_id')::uuid;
  v_r := admin_invoice_run_matching(v_key, v_imp);

  insert into _t values (29,'D1: 全角ハイフン(U+FF0D)→ZC-901に一致', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='D1'
      and customer_id=hy901 and match_confidence=1.00 and match_status='確定'));
  insert into _t values (30,'D2: enダッシュ(U+2013)→ZC-901に一致', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='D2'
      and customer_id=hy901 and match_confidence=1.00));
  insert into _t values (31,'D3: emダッシュ(U+2014)→ZC-901に一致', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='D3'
      and customer_id=hy901 and match_confidence=1.00));
  insert into _t values (32,'D4: マイナス記号(U+2212)→ZC-901に一致', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='D4'
      and customer_id=hy901 and match_confidence=1.00));
  insert into _t values (33,'D5: 末尾ハイフンコード単独印字→一致', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='D5'
      and customer_id=hy77 and match_confidence=1.00 and match_status='確定'));
  insert into _t values (34,'D6: INV-ZC-901→ZC-901と一致しない', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='D6'
      and match_status='未照合' and customer_id is null));

  -- 正規表現へ入るコード文字の限定: 記号入りコードは1.00自動照合に使われない
  insert into customers (code, name) values ('ZC(9)','記号入りコード店');
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object(
    'file_name','mock-symbol-code.xlsx','content_hash','testhash-' || md5(random()::text),
    'documents', jsonb_build_array(
      jsonb_build_object('page_from',1,'invoice_number','D7','note','お客様番号 ZC(9)'))));
  v_imp := (v_r->>'import_id')::uuid;
  v_r := admin_invoice_run_matching(v_key, v_imp);
  insert into _t values (35,'D7: [A-Z0-9-]以外を含むコードは1.00自動照合に使わない', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='D7'
      and (match_status <> '確定' or coalesce(match_confidence,0) < 1.00)));

  -- ═══════════ E. 同時投入の冪等性（原子的なON CONFLICT経路） ═══════════
  -- E1: 「他セッションが先にINSERTした」状態を再現 → SELECTせず即INSERTするRPCが
  --     エラーなく skipped=true・既存id・1件のみ を返すこと（check-then-insertの競合窓が無い）
  v_hash := 'testhash-race-' || md5(random()::text);
  insert into invoice_imports (source, file_name, content_hash, status)
  values ('local','race-first.xlsx', v_hash, '抽出済') returning id into v_imp;
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object(
    'file_name','race-second.xlsx','content_hash', v_hash,
    'documents', jsonb_build_array(jsonb_build_object('page_from',1,'invoice_number','E1',
      'lines', jsonb_build_array(jsonb_build_object('raw_item_name','競合テスト品'))))));
  select count(*) into v_cnt from invoice_imports where content_hash = v_hash;
  insert into _t values (36,'E1: 先行INSERT済みハッシュへの投入→skipped=true・既存id・1件のみ',
    (v_r->>'ok')::boolean and (v_r->>'skipped')::boolean
    and (v_r->>'import_id')::uuid = v_imp and v_cnt = 1, v_r::text || ' / rows=' || v_cnt);
  insert into _t values (37,'E1b: skip時はdocuments/linesを登録しない', not exists (
    select 1 from invoice_documents where import_id = v_imp));

  -- E2: (source, source_file_id) 競合（同じDriveファイルIDで内容が変わった）→
  --     エラーなく skipped=true（自動上書きしない）
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object(
    'source','drive','source_file_id','drive-file-001',
    'file_name','drive-v1.xlsx','content_hash','testhash-' || md5(random()::text)));
  v_imp := (v_r->>'import_id')::uuid;
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object(
    'source','drive','source_file_id','drive-file-001',
    'file_name','drive-v2.xlsx','content_hash','testhash-' || md5(random()::text)));
  select count(*) into v_cnt from invoice_imports where source='drive' and source_file_id='drive-file-001';
  insert into _t values (38,'E2: 同一source_file_idで内容変更→skipped=true・既存id・1件のみ',
    (v_r->>'ok')::boolean and (v_r->>'skipped')::boolean
    and (v_r->>'import_id')::uuid = v_imp and v_cnt = 1
    and (v_r->>'reason') like '%取込元ファイルID%', v_r::text || ' / rows=' || v_cnt);

  -- ═══════════ F. RLS・認可 ═══════════
  -- F1: 5テーブルすべてで anon の SELECT / INSERT / UPDATE / DELETE が拒否される
  v_no := 39;
  foreach v_tbl in array array['invoice_imports','invoice_documents','invoice_lines',
                               'customer_purchase_facts','product_name_aliases'] loop
    foreach v_op in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      begin
        set local role anon;
        case v_op
          when 'SELECT' then execute format('select count(*) from %I', v_tbl);
          when 'INSERT' then execute format('insert into %I default values', v_tbl);
          when 'UPDATE' then execute format('update %I set id = id', v_tbl);
          when 'DELETE' then execute format('delete from %I', v_tbl);
        end case;
        reset role;
        insert into _t values (v_no, 'F1: anonは'||v_tbl||'を'||v_op||'できない', false, '実行できてしまった');
      exception when insufficient_privilege then
        reset role;
        insert into _t values (v_no, 'F1: anonは'||v_tbl||'を'||v_op||'できない', true, 'permission denied');
      when others then
        reset role;
        -- default values が無い等の別エラーは権限より先に権限エラーになるべきなので false
        insert into _t values (v_no, 'F1: anonは'||v_tbl||'を'||v_op||'できない', false, sqlerrm);
      end;
      v_no := v_no + 1;
    end loop;
  end loop;

  -- F2: admin_invoice_* は誤ったスタッフキーで拒否される（3関数すべて）
  begin
    perform admin_invoice_stage_import('wrong-key', jsonb_build_object('file_name','x','content_hash','x'));
    insert into _t values (59,'F2: stage_importは誤キーで拒否', false, '');
  exception when others then
    insert into _t values (59,'F2: stage_importは誤キーで拒否', sqlerrm like '%スタッフキー%', left(sqlerrm,40));
  end;
  begin
    perform admin_invoice_run_matching('wrong-key', null);
    insert into _t values (60,'F2: run_matchingは誤キーで拒否', false, '');
  exception when others then
    insert into _t values (60,'F2: run_matchingは誤キーで拒否', sqlerrm like '%スタッフキー%', left(sqlerrm,40));
  end;
  begin
    perform admin_invoice_list('wrong-key', null);
    insert into _t values (61,'F2: listは誤キーで拒否', false, '');
  exception when others then
    insert into _t values (61,'F2: listは誤キーで拒否', sqlerrm like '%スタッフキー%', left(sqlerrm,40));
  end;

  -- F3: helper関数はanonから直接実行できない
  -- F3: helper関数4本すべて、anon / authenticated から直接EXECUTEできない
  v_no := 62;
  foreach v_op in array array['anon','authenticated'] loop
    foreach v_tbl in array array['invoice_norm_code(''ZC901'')','invoice_name_similarity(''a'',''b'')',
                                 'invoice_norm_phone(''0470-1'')','invoice_norm_name(''テスト'')'] loop
      begin
        execute format('set local role %I', v_op);
        execute 'select ' || v_tbl;
        reset role;
        insert into _t values (v_no, 'F3: '||v_op||'は'||split_part(v_tbl,'(',1)||'を実行できない', false, '実行できてしまった');
      exception when insufficient_privilege then
        reset role;
        insert into _t values (v_no, 'F3: '||v_op||'は'||split_part(v_tbl,'(',1)||'を実行できない', true, 'permission denied');
      end;
      v_no := v_no + 1;
    end loop;
  end loop;
  -- F3b: 権限表の実測（PUBLIC(grantee=0)のEXECUTEエントリなし＋anon/authenticatedにEXECUTE権限なし）
  insert into _t values (74,'F3b: helper4本の権限表（PUBLIC/anon/authenticatedにEXECUTE無し）',
    4 = (select count(*) from pg_proc p
          where p.pronamespace = 'public'::regnamespace
            and p.proname in ('invoice_norm_code','invoice_norm_name','invoice_norm_phone','invoice_name_similarity')
            and p.proacl is not null
            and not exists (select 1 from aclexplode(p.proacl) a
                             where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
    and not has_function_privilege('anon','invoice_norm_code(text)','execute')
    and not has_function_privilege('anon','invoice_norm_name(text)','execute')
    and not has_function_privilege('anon','invoice_norm_phone(text)','execute')
    and not has_function_privilege('anon','invoice_name_similarity(text,text)','execute')
    and not has_function_privilege('authenticated','invoice_norm_code(text)','execute')
    and not has_function_privilege('authenticated','invoice_norm_name(text)','execute')
    and not has_function_privilege('authenticated','invoice_norm_phone(text)','execute')
    and not has_function_privilege('authenticated','invoice_name_similarity(text,text)','execute'), '');

  -- F4: anon/authenticated は public schema へ CREATE できない
  insert into _t values (70,'F4: anonはpublicへCREATE不可',
    not has_schema_privilege('anon','public','CREATE'), '');
  insert into _t values (71,'F4: authenticatedはpublicへCREATE不可',
    not has_schema_privilege('authenticated','public','CREATE'), '');

  -- F5: admin_invoice_* のEXECUTEはPUBLICに無く、anon/authenticatedにだけある
  --     （proaclを実測: grantee=0(PUBLIC)のEXECUTEエントリが無いこと＋anon/authenticatedに有ること）
  insert into _t values (72,'F5: EXECUTE権限（PUBLIC無し・anon/authenticated有り）',
    3 = (select count(*) from pg_proc p
          where p.pronamespace = 'public'::regnamespace
            and p.proname in ('admin_invoice_stage_import','admin_invoice_run_matching','admin_invoice_list')
            and p.proacl is not null
            and not exists (select 1 from aclexplode(p.proacl) a
                             where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
    and has_function_privilege('anon','admin_invoice_stage_import(text,jsonb)','execute')
    and has_function_privilege('anon','admin_invoice_run_matching(text,uuid)','execute')
    and has_function_privilege('anon','admin_invoice_list(text,text)','execute')
    and has_function_privilege('authenticated','admin_invoice_stage_import(text,jsonb)','execute')
    and has_function_privilege('authenticated','admin_invoice_run_matching(text,uuid)','execute')
    and has_function_privilege('authenticated','admin_invoice_list(text,text)','execute'), '');

  -- F6: SECURITY DEFINER関数のsearch_pathが固定されている
  insert into _t values (73,'F6: admin_invoice_*のsearch_path固定', 3 = (
    select count(*) from pg_proc p
    where p.proname in ('admin_invoice_stage_import','admin_invoice_run_matching','admin_invoice_list')
      and p.prosecdef
      and exists (select 1 from unnest(coalesce(p.proconfig,'{}')) cfg
                   where cfg like 'search_path=%')), '');

  -- ═══════════ G. ラベル付きコードの事前抽出（DB未登録コードの検出） ═══════════
  -- 2026-08-12 再レビュー対応: 「DBに存在する一致コードが1件」ではなく
  -- 「請求書に印字されたラベル付きコードが1種類」を確認してから照合する
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object(
    'file_name','mock-labeled-codes.xlsx','content_hash','testhash-' || md5(random()::text),
    'documents', jsonb_build_array(
      jsonb_build_object('page_from',1,'invoice_number','G1','note','顧客番号 ZC901 ／ 顧客番号 ZC999'),
      jsonb_build_object('page_from',2,'invoice_number','G2','note','顧客番号 ZC901 の件（再掲: 顧客番号 ZC901）'),
      jsonb_build_object('page_from',3,'invoice_number','G3','note','お客様番号 ZC999'),
      jsonb_build_object('page_from',4,'invoice_number','G4','note','お客様番号 ZC999 ／ 出荷分 ZC901'),
      jsonb_build_object('page_from',5,'invoice_number','G5','note','顧客番号 ｚｃ９０１ ／ 得意先コード ZC—999')
    )));
  v_imp := (v_r->>'import_id')::uuid;
  v_r := admin_invoice_run_matching(v_key, v_imp);

  insert into _t values (75,'G1: 既知ZC901+未登録ZC999が両方ラベル付き→自動確定しない', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='G1'
      and match_status <> '確定' and customer_id is null));
  insert into _t values (76,'G2: 同じZC901がラベル付きで2回→distinct後1種類として確定できる', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='G2'
      and customer_id=zc900 and match_confidence=1.00 and match_status='確定'));
  insert into _t values (77,'G3: 未登録コードZC999だけ→customer_id無しで未照合', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='G3'
      and match_status='未照合' and customer_id is null));
  insert into _t values (78,'G4: ラベル付きZC999+ラベルなし既知ZC901→ZC901へ自動確定しない', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='G4'
      and match_status <> '確定' and customer_id is null));
  insert into _t values (79,'G5: 表記揺れ(全角ｚｃ/EMダッシュ)を正規化後に複数コードとして検出', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='G5'
      and match_status <> '確定' and customer_id is null));

  -- ═══════════ H. 再照合で前回の候補情報を残さない ═══════════
  insert into customers (code, name) values ('ZC910','再照合テスト店') returning id into c001;   -- 変数を再利用
  insert into customers (code, name) values ('ZC911','再照合テスト店Ｂ号館') returning id into c0011;
  v_r := admin_invoice_stage_import(v_key, jsonb_build_object(
    'file_name','mock-rematch.xlsx','content_hash','testhash-' || md5(random()::text),
    'documents', jsonb_build_array(
      jsonb_build_object('page_from',1,'invoice_number','H1','raw_customer_name','再照合テスト店'))));
  v_imp := (v_r->>'import_id')::uuid;
  v_r := admin_invoice_run_matching(v_key, v_imp);
  insert into _t values (80,'H0: 名称一致で候補顧客Aが付く（前提）', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='H1'
      and match_status='候補あり' and customer_id=c001 and match_method='name'
      and matched_by is null and matched_at is null));

  -- 候補A→候補B（生データを変更して再照合）: 全列が今回の判定結果へ置き換わる
  update invoice_documents set raw_customer_name='再照合テスト店Ｂ号館'
   where import_id=v_imp and invoice_number='H1';
  v_r := admin_invoice_run_matching(v_key, v_imp);
  insert into _t values (81,'H1: 候補A→候補Bへ完全に置き換わる', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='H1'
      and match_status='候補あり' and customer_id=c0011 and match_method='name'
      and match_confidence > 0 and matched_by is null and matched_at is null));

  -- 候補→一致なし（生データを無関係な文字列へ）: customer_id等がすべてクリアされる
  update invoice_documents set raw_customer_name='qzv9x8w7unrelated'
   where import_id=v_imp and invoice_number='H1';
  v_r := admin_invoice_run_matching(v_key, v_imp);
  insert into _t values (82,'H2: 一致なしへ戻すと候補情報が完全クリア（未照合/null/0）', exists (
    select 1 from invoice_documents where import_id=v_imp and invoice_number='H1'
      and match_status='未照合' and customer_id is null and match_method is null
      and match_confidence=0 and matched_by is null and matched_at is null));
end $$;

-- 結果表（psql / SQL Editor で目視できる）
select * from _t order by no;

-- ok=false が1件でもあれば例外でSQL全体を失敗させる（終了ステータス／API応答で機械判定できる）
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
