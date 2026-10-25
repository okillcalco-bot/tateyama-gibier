-- 入金消込のDB関数のテスト（手元の使い捨てDB・架空データのみ）。bash tests/db/run.sh tests/db/recon.test.sql
create temp table _t (n serial, name text, ok boolean, got text);
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_got text default null) returns void language sql as
$$ insert into _t (name, ok, got) values (p_name, coalesce(p_ok, false), p_got) $$;

do $t$
declare r jsonb; k text := 'TEST-staff-key'; v_c uuid := gen_random_uuid(); v_c2 uuid := gen_random_uuid();
  v_d1 uuid := gen_random_uuid(); v_d2 uuid := gen_random_uuid(); v_d3 uuid := gen_random_uuid(); v_d4 uuid := gen_random_uuid();
  t1 uuid; t2 uuid; t3 uuid; t4 uuid; rows jsonb; n int; e text; acc1 uuid; acc2 uuid;
begin
  insert into customers (id, code, name, kana) values (v_c, 'CT001', '架空商店', 'ｶｸｳｼｮｳﾃﾝ'), (v_c2, 'CT002', '架空食堂', null);
  insert into documents (id, doc_type, doc_number, customer_id, issue_date, due_date, total_amount, tax_amount, status, billing_status) values
    (v_d1,'請求書','INV-T-1',v_c,'2026-10-06','2026-11-30',12000,888,'発行済','未入金'),
    (v_d2,'請求書','INV-T-2',v_c,'2026-10-06','2026-11-30',8000,592,'発行済','未入金'),
    (v_d3,'請求書','INV-T-3',v_c,'2026-09-06','2026-10-31',5000,370,'発行済','未入金'),
    (v_d4,'請求書','INV-T-4',v_c2,'2026-10-06','2026-11-30',3000,222,'取消','未入金');

  -- 1. 取込（口座を登録 → プレビュー → 確定 → 同じCSVをもう一度）
  acc1 := (staff_account_set(k, '{"bank_name":"テスト銀行","branch":"テスト支店","account_type":"普通","account_no":"0000001","label":"テスト口座","department":"gibier"}')->>'id')::uuid;
  acc2 := (staff_account_set(k, '{"bank_name":"残高なし銀行","account_no":"0000002","label":"残高なし口座","department":"alco"}')->>'id')::uuid;
  rows := '[{"row_no":2,"txn_date":"2026-10-31","description":"TA","amount_in":12000,"amount_out":0,"balance":112000},
            {"row_no":3,"txn_date":"2026-10-31","description":"TB","amount_in":7600,"amount_out":0,"balance":119600},
            {"row_no":4,"txn_date":"2026-10-31","description":"TC","amount_in":0,"amount_out":3000,"balance":116600},
            {"row_no":5,"txn_date":"2026-10-31","description":"TD","amount_in":5000,"amount_out":0,"balance":121600}]';
  r := staff_bank_import(k,acc1,'t.csv',rows,false);
  perform pg_temp.chk('取込プレビュー: 新規4・重複0・まだ入れない', (r->>'new_count')::int = 4 and (r->>'dup_count')::int = 0 and (select count(*) from bank_transactions) = 0, r::text);
  r := staff_bank_import(k,acc1,'t.csv',rows,true);
  perform pg_temp.chk('取込確定: 4件入る', (r->>'new_count')::int = 4 and (select count(*) from bank_transactions) = 4, r::text);
  r := staff_bank_import(k,acc1,'t.csv',rows,true);
  perform pg_temp.chk('同じCSVを2回入れても増えない（重複4）', (r->>'new_count')::int = 0 and (r->>'dup_count')::int = 4 and (select count(*) from bank_transactions) = 4, r::text);
  r := staff_bank_import(k,acc1,'t.csv','[{"row_no":2,"txn_date":"2026-02-30","amount_in":1},{"row_no":3,"txn_date":"2026-10-01","amount_in":"x"},{"row_no":4,"txn_date":"2026-10-01","amount_in":0,"amount_out":0},{"row_no":5,"txn_date":"2026-10-01","amount_in":5}]',true);
  perform pg_temp.chk('読めない行（2/30・金額x・入出金0）が1行でもあれば全体を入れない（fail-closed）', (r->>'ok')::boolean = false and r->'invalid_rows' = '[2,3,4]'::jsonb and (select count(*) from bank_transactions) = 4, r::text);
  rows := '[{"row_no":2,"txn_date":"2026-11-02","description":"SAME","amount_in":1000},{"row_no":3,"txn_date":"2026-11-02","description":"SAME","amount_in":1000}]';
  r := staff_bank_import(k,acc2,'u.csv',rows,true);
  perform pg_temp.chk('残高列がない銀行で同じ日・同じ名義・同じ金額が2件あっても両方入る（出現順で区別）', (r->>'new_count')::int = 2, r::text);
  r := staff_bank_import(k,acc2,'u.csv',rows,true);
  perform pg_temp.chk('…それを2回目に入れても増えない', (r->>'new_count')::int = 0, r::text);

  select id into t1 from bank_transactions where description='TA'; select id into t2 from bank_transactions where description='TB';
  select id into t3 from bank_transactions where description='TC'; select id into t4 from bank_transactions where description='TD';

  -- 2. 権限: 公開キー（anon）からは銀行明細・名義・督促記録を読めない
  begin set local role anon; perform count(*) from bank_transactions; perform pg_temp.chk('anon は銀行明細を読めない', false, 'read');
  exception when insufficient_privilege then perform pg_temp.chk('anon は銀行明細を読めない', true); end;
  reset role;
  begin set local role anon; perform count(*) from customer_aliases; perform pg_temp.chk('anon は振込名義を読めない', false, 'read');
  exception when insufficient_privilege then perform pg_temp.chk('anon は振込名義を読めない', true); end;
  reset role;
  begin perform staff_recon_snapshot('wrong'); perform pg_temp.chk('スタッフキーが違えば読めない', false);
  exception when others then perform pg_temp.chk('スタッフキーが違えば読めない', true); end;
  begin update bank_transactions set amount_in = 1 where id = t1; perform pg_temp.chk('銀行明細は取込後に変更できない', false);
  exception when others then perform pg_temp.chk('銀行明細は取込後に変更できない', true); end;

  -- 3. スナップショット: 未消込の入金（出金は除く）と未入金の請求書（取消は除く）
  r := staff_recon_snapshot(k);
  perform pg_temp.chk('スナップショット: 入金明細5件（出金1件は除く）・請求書3件（取消は除く）', jsonb_array_length(r->'txns') = 5 and jsonb_array_length(r->'invoices') = 3 and (r->>'fee_tolerance')::int = 1000, jsonb_array_length(r->'txns')||'/'||jsonb_array_length(r->'invoices'));

  -- 4. 確定
  r := staff_recon_confirm(k,t1,jsonb_build_array(jsonb_build_object('document_id',v_d1,'amount',12000)),'auto','amount_name',1);
  perform pg_temp.chk('自動確定 → 請求書が入金済', (r->>'ok')::boolean and (select billing_status from documents where id=v_d1) = '入金済', r::text);
  r := staff_recon_confirm(k,t1,jsonb_build_array(jsonb_build_object('document_id',v_d1,'amount',12000)),'auto','amount_name',1);
  perform pg_temp.chk('同じ入金明細をもう一度確定しても増えない（再送で1回限り）', (r->>'ok')::boolean = false and (select count(*) from payments where bank_transaction_id=t1) = 1, r::text);
  begin perform staff_recon_confirm(k,t2,jsonb_build_array(jsonb_build_object('document_id',v_d2,'amount',7600,'fee',400)),'auto','fee',0.8);
    perform pg_temp.chk('手数料差を含むものは自動確定できない', false);
  exception when others then perform pg_temp.chk('手数料差を含むものは自動確定できない', true); end;
  begin perform staff_recon_confirm(k,t2,jsonb_build_array(jsonb_build_object('document_id',v_d3,'amount',7600)),'manual','x',0.5);
    perform pg_temp.chk('残額を超えて充てられない（過入金）', false);
  exception when others then perform pg_temp.chk('残額を超えて充てられない（過入金）', true); end;
  begin perform staff_recon_confirm(k,t2,jsonb_build_array(jsonb_build_object('document_id',v_d2,'amount',5000)),'manual','x',0.5);
    perform pg_temp.chk('入金額と充てた額が一致しなければ確定しない', false);
  exception when others then perform pg_temp.chk('入金額と充てた額が一致しなければ確定しない', true); end;
  begin perform staff_recon_confirm(k,t2,jsonb_build_array(jsonb_build_object('document_id',v_d2,'amount',7600,'fee',1200)),'manual','x',0.5);
    perform pg_temp.chk('手数料差が許容範囲（1,000円）を超えたら確定しない', false);
  exception when others then perform pg_temp.chk('手数料差が許容範囲（1,000円）を超えたら確定しない', true); end;
  begin perform staff_recon_confirm(k,t4,jsonb_build_array(jsonb_build_object('document_id',v_d4,'amount',5000)),'manual','x',0.5);
    perform pg_temp.chk('取消済の請求書には充てられない', false);
  exception when others then perform pg_temp.chk('取消済の請求書には充てられない', true); end;
  begin perform staff_recon_confirm(k,t3,jsonb_build_array(jsonb_build_object('document_id',v_d3,'amount',3000)),'manual','x',0.5);
    perform pg_temp.chk('出金明細は消込に使えない', false);
  exception when others then perform pg_temp.chk('出金明細は消込に使えない', true); end;
  perform pg_temp.chk('失敗した確定は何も残さない（payments は1件のまま）', (select count(*) from payments) = 1, (select count(*) from payments)::text);
  r := staff_recon_confirm(k,t2,jsonb_build_array(jsonb_build_object('document_id',v_d2,'amount',7600,'fee',400)),'manual','fee',0.8,'スズキ','tester');
  perform pg_temp.chk('手動確定（手数料400円）→ 入金済・手数料を記録・名義を登録', (r->>'ok')::boolean and (select billing_status from documents where id=v_d2) = '入金済'
    and (select fee_amount from payments where bank_transaction_id=t2) = 400 and (select count(*) from customer_aliases where customer_id=v_c and normalized_name='スズキ') = 1, r::text);
  begin
    r := staff_recon_confirm(k,t4,jsonb_build_array(jsonb_build_object('document_id',v_d3,'amount',2000),jsonb_build_object('document_id',v_d1,'amount',3000)),'manual','x',0.5);
    perform pg_temp.chk('入金済の請求書（残0）には充てられない・途中まで書いた分も残らない', false, r::text);
  exception when others then
    get stacked diagnostics e = message_text;
    perform pg_temp.chk('入金済の請求書（残0）には充てられない・途中まで書いた分も残らない',
      e like '%残額を超えて%' and (select count(*) from payments where bank_transaction_id = t4) = 0, e);
  end;
end $t$;

do $t$
declare r jsonb; k text := 'TEST-staff-key'; v_c uuid; v_d1 uuid; v_d3 uuid; t1 uuid; t4 uuid; t5 uuid;
begin
  select id into v_c from customers where code='CT001';
  select id into v_d1 from documents where doc_number='INV-T-1'; select id into v_d3 from documents where doc_number='INV-T-3';
  select id into t1 from bank_transactions where description='TA'; select id into t4 from bank_transactions where description='TD';
  select id into t5 from bank_transactions where description='SAME' order by row_no limit 1;

  -- 5. 取消 → 再計算
  r := staff_recon_undo(k,t1,'tester');
  perform pg_temp.chk('取消: 入金の行が消え、請求書が未入金に戻る', (r->>'ok')::boolean and (select billing_status from documents where id=v_d1) = '未入金' and (select count(*) from payments where document_id=v_d1) = 0, r::text);
  r := staff_recon_undo(k,t1,'tester');
  perform pg_temp.chk('取消をもう一度しても何も起きない', (r->>'ok')::boolean = false, r::text);
  r := staff_recon_confirm(k,t4,jsonb_build_array(jsonb_build_object('document_id',v_d3,'amount',5000)),'manual','amount_only',0.3);
  r := staff_recon_confirm(k,t5,jsonb_build_array(jsonb_build_object('document_id',v_d1,'amount',1000)),'manual','partial',0.5);
  perform pg_temp.chk('一部入金 → 一部入金', (select billing_status from documents where id=v_d1) = '一部入金', (select billing_status from documents where id=v_d1));
  perform pg_temp.chk('操作履歴が残る（取込・確定・取消）', (select count(*) from recon_events where kind='import') >= 3 and (select count(*) from recon_events where kind='confirm') >= 3 and (select count(*) from recon_events where kind='undo') = 1,
    (select string_agg(kind||':'||c, ',') from (select kind, count(*) c from recon_events group by kind) x));

  -- 6. 未入金一覧（基準日）・督促の記録
  r := staff_unpaid_list(k,'2026-11-05');
  perform pg_temp.chk('未入金一覧: INV-T-1（残11,000）だけ・期日前なので経過0日',
    jsonb_array_length(r) = 1 and (r->0->>'doc_number') = 'INV-T-1' and (r->0->>'remain')::int = 11000 and (r->0->>'days_overdue')::int = 0, r::text);
  r := staff_unpaid_list(k,'2026-12-05');
  perform pg_temp.chk('基準日12/05: 期日11/30から5日経過', (r->0->>'days_overdue')::int = 5, r::text);
  r := staff_unpaid_list(k,'2026-10-30');
  perform pg_temp.chk('基準日10/30（入金前）: 3件が未入金に見える（取消は除く）', jsonb_array_length(r) = 3, jsonb_array_length(r)::text);
  r := staff_dunning_record(k, v_c, array[v_d1], 'line', 'tester');
  perform pg_temp.chk('督促1回目', (r->>'round')::int = 1, r::text);
  r := staff_dunning_record(k, v_c, array[v_d1], 'email', 'tester');
  perform pg_temp.chk('督促2回目（回数が数えられる）', (r->>'round')::int = 2 and (staff_unpaid_list(k,'2026-12-05')->0->>'dunning_count')::int = 2, r::text);

  -- 7. 月次（税理士向け）
  r := staff_recon_month(k,'2026-10');
  perform pg_temp.chk('月次10月: 10月中の入金2件（11/2分は入らない）・10月末の未入金1件・gibier 売上20,000／入金12,600／手数料400',
    jsonb_array_length(r->'paid') = 2 and jsonb_array_length(r->'unpaid') = 1 and (r->'summary'->0->>'sales')::int = 20000
    and (r->'summary'->0->>'received')::int = 12600 and (r->'summary'->0->>'fee')::int = 400,
    jsonb_array_length(r->'paid')||' '||jsonb_array_length(r->'unpaid')||' '||(r->'summary')::text);
end $t$;

select (case when ok then 'PASS' else 'FAIL' end) || ' : ' || name || coalesce('  [' || left(got, 200) || ']', '') from _t order by n;
select (select count(*) filter (where ok) from _t) || '/' || (select count(*) from _t) || ' passed';
