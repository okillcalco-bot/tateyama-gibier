-- 会計（カード明細・領収書・勘定科目・閲覧専用キー）のDB関数のテスト（手元の使い捨てDB・架空データのみ）。bash tests/db/run.sh tests/db/finance.test.sql
create temp table _t (n serial, name text, ok boolean, got text);
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_got text default null) returns void language sql as
$$ insert into _t (name, ok, got) values (p_name, coalesce(p_ok, false), p_got) $$;

do $t$
declare r jsonb; k text := 'TEST-staff-key'; vk text := 'TEST-viewer-key-0123456789'; e text; n int; ok boolean;
  v_c uuid := gen_random_uuid(); v_d1 uuid := gen_random_uuid(); tb uuid; tb2 uuid; tc uuid; tc2 uuid; rid uuid; rid2 uuid;
begin
  -- 管理者用回復コード（本番と同じ置き場 app_secrets.recovery_code）
  insert into app_secrets (key, hash) values ('recovery_code', extensions.crypt('TEST-recovery', extensions.gen_salt('bf', 4)));

  -- 1. 閲覧専用キー（税理士）の発行は回復コードが要る
  perform pg_temp.chk('回復コードが違えば閲覧専用キーを発行できない', admin_set_finance_viewer_key('wrong', vk) = false, null);
  begin perform admin_set_finance_viewer_key('TEST-recovery', 'short'); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('16文字未満の閲覧専用キーは拒否', e like '%16文字%', e);
  -- 関数の結果は先に変数に取る（式の中の副問い合わせは関数より先に評価されることがある）
  ok := admin_set_finance_viewer_key('TEST-recovery', vk);
  perform pg_temp.chk('回復コードが合えば発行できる（bcrypt と sha256 の両方を持つ）', ok
    and (select count(*) from app_secrets where key in ('finance_viewer_key','finance_viewer_key_sha256')) = 2, ok::text);

  -- 2. 役割の判定
  perform pg_temp.chk('スタッフキー → staff', finance_role(k) = 'staff', finance_role(k));
  perform pg_temp.chk('閲覧専用キー → viewer', finance_role(vk) = 'viewer', finance_role(vk));
  begin perform finance_role('nope'); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('違うキーは例外（キーが違います）', e = 'キーが違います', e);
  -- 注: 例外で終わる呼び出しでは auth_attempts への記録も巻き戻る（本番の staff_key_ok を RPC から呼ぶ場合と同じ）。
  --     失敗回数の制限が効くのは finance_role を直接呼んだときだけ。docs/finance/README.md に書いた

  -- 3. 勘定科目: 既定が入っている。閲覧専用でも読める。書けるのはスタッフだけ
  r := finance_titles(vk);
  perform pg_temp.chk('既定の勘定科目が入っている（28件・閲覧専用キーで読める）', jsonb_array_length(r) = 28, jsonb_array_length(r)::text);
  begin perform staff_titles_set(vk, '[{"code":"expense.x","name":"X","kind":"expense"}]'); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('閲覧専用キーでは勘定科目を変えられない', e = 'スタッフキーが違います', e);
  r := staff_titles_set(k, '[{"code":"expense.misc","name":"雑費（その他）","kind":"expense","tax_rate":10,"sort":240},
                            {"code":"expense.feed","name":"飼料費","kind":"expense","tax_rate":8,"sort":65},
                            {"code":"BAD CODE","name":"だめ","kind":"expense"}, {"code":"expense.noname","name":"","kind":"expense"}]', 'テスト');
  perform pg_temp.chk('名前の変更と新しい科目の追加（code が形に合わない・名前が空の行は入れない）', (r->>'count')::int = 2
    and (select name from account_titles where code = 'expense.misc') = '雑費（その他）' and exists (select 1 from account_titles where code = 'expense.feed')
    and not exists (select 1 from account_titles where code = 'BAD CODE'), r::text);

  -- 4. カード明細の取込（プレビュー → 確定 → 重複 → 読めない行）
  r := staff_card_import(k, 'テストカード', 'c.csv', '[{"row_no":2,"txn_date":"2026-10-03","description":"ガソリン","amount":5500},
       {"row_no":3,"txn_date":"2026-10-05","description":"ホームセンター","amount":3200},{"row_no":4,"txn_date":"2026-10-07","description":"返品","amount":-1200}]', false);
  perform pg_temp.chk('カード取込プレビュー: 新規3・重複0・まだ入れない', (r->>'preview')::boolean and (r->>'new_count')::int = 3 and (select count(*) from card_transactions) = 0, r::text);
  r := staff_card_import(k, 'テストカード', 'c.csv', '[{"row_no":2,"txn_date":"2026-10-03","description":"ガソリン","amount":5500},
       {"row_no":3,"txn_date":"2026-10-05","description":"ホームセンター","amount":3200},{"row_no":4,"txn_date":"2026-10-07","description":"返品","amount":-1200}]', true, 'テスト');
  perform pg_temp.chk('カード取込確定: 3件入る（返金のマイナスも）', (r->>'new_count')::int = 3 and (select count(*) from card_transactions where amount < 0) = 1, r::text);
  r := staff_card_import(k, 'テストカード', 'c.csv', '[{"row_no":2,"txn_date":"2026-10-03","description":"ガソリン","amount":5500},
       {"row_no":3,"txn_date":"2026-10-05","description":"ホームセンター","amount":3200},{"row_no":4,"txn_date":"2026-10-07","description":"返品","amount":-1200}]', true);
  perform pg_temp.chk('同じCSVを2回入れても増えない（重複3）', (r->>'new_count')::int = 0 and (r->>'dup_count')::int = 3 and (select count(*) from card_transactions) = 3, r::text);
  r := staff_card_import(k, '別カード', 'd.csv', '[{"row_no":2,"txn_date":"2026-10-03","description":"ガソリン","amount":5500}]', true);
  perform pg_temp.chk('別のカード名なら同じ内容でも別の明細として入る', (r->>'new_count')::int = 1, r::text);
  r := staff_card_import(k, 'テストカード', 'e.csv', '[{"row_no":2,"txn_date":"2026-10-03","description":"A","amount":100},{"row_no":3,"txn_date":"2026-13-01","description":"B","amount":100},{"row_no":4,"txn_date":"2026-10-04","description":"C","amount":0}]', true);
  perform pg_temp.chk('読めない行（13月・金額0）が1行でもあれば全体を入れない（fail-closed）', (r->>'ok')::boolean = false and r->'invalid_rows' = '[3,4]'::jsonb and (select count(*) from card_transactions) = 4, r::text);
  begin perform staff_card_import(vk, 'テストカード', 'c.csv', '[{"row_no":2,"txn_date":"2026-10-03","description":"X","amount":1}]', true); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('閲覧専用キーでは取り込めない', e = 'スタッフキーが違います', e);
  begin update card_transactions set amount = 1 where description = 'ガソリン'; e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('カード明細は取込後に変更できない', e like '%変更・削除できません%', e);

  -- 5. 銀行明細（消込と分類の両方を見るため1件ずつ用意）
  insert into customers (id, code, name, kana) values (v_c, 'CT001', '架空商店', 'ｶｸｳｼｮｳﾃﾝ');
  insert into documents (id, doc_type, doc_number, customer_id, issue_date, due_date, total_amount, tax_amount, status, billing_status)
    values (v_d1, '請求書', 'INV-T-1', v_c, '2026-10-06', '2026-11-30', 12000, 888, '発行済', '未入金');
  r := staff_bank_import(k, 'テスト銀行', 'b.csv', '[{"row_no":2,"txn_date":"2026-10-31","description":"ｶｸｳｼｮｳﾃﾝ","amount_in":12000,"amount_out":0,"balance":112000},
       {"row_no":3,"txn_date":"2026-10-31","description":"ガス","amount_in":0,"amount_out":3000,"balance":109000}]', true);
  select id into tb from bank_transactions where amount_in = 12000; select id into tb2 from bank_transactions where amount_out = 3000;
  select id into tc from card_transactions where description = 'ガソリン' and card_name = 'テストカード'; select id into tc2 from card_transactions where description = '返品';
  r := staff_recon_confirm(k, tb, jsonb_build_array(jsonb_build_object('document_id', v_d1, 'amount', 12000, 'fee', 0)), 'auto', 'amount_name', 1);
  perform pg_temp.chk('（前提）入金12,000を請求書に消込', (r->>'ok')::boolean, r::text);

  -- 6. 分類
  r := staff_classify(k, 'bank', tb2, 'expense.utilities', 'プロパン', 'gibier', 'テスト');
  perform pg_temp.chk('銀行の出金に科目・メモ・部門を付けられる', (r->>'ok')::boolean and (select category_code from finance_classifications where kind='bank' and txn_id=tb2) = 'expense.utilities', r::text);
  r := staff_classify(k, 'card', tc, 'expense.vehicle', null, null, 'テスト');
  begin perform staff_classify(k, 'card', tc, 'expense.nothing'); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('無い科目は付けられない', e like '%勘定科目がありません%', e);
  begin perform staff_classify(k, 'card', gen_random_uuid(), 'expense.vehicle'); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('無い明細には付けられない', e like '%見つかりません%', e);
  begin perform staff_classify(vk, 'card', tc, 'expense.vehicle'); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('閲覧専用キーでは分類できない', e = 'スタッフキーが違います', e);
  r := staff_classify(k, 'card', tc2, 'expense.supplies'); r := staff_classify(k, 'card', tc2, null, null, null);
  perform pg_temp.chk('科目・メモ・部門をすべて空にすると分類が消える', not exists (select 1 from finance_classifications where kind='card' and txn_id=tc2), null);

  -- 7. 領収書
  begin perform staff_receipt_add(k, '{"amount": 500}'); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('ファイルも店名も無い領収書は登録できない', e like '%どちらかは必要%', e);
  r := staff_receipt_add(k, '{"receipt_date":"2026-10-03","vendor":"ガソリンスタンド","amount":5500,"tax_rate":10,"category_code":"expense.vehicle","paid_by":"card","storage_path":"finance-receipts/2026/10/a.jpg","file_name":"a.jpg","mime":"image/jpeg","size_bytes":123}', 'テスト');
  rid := (r->>'id')::uuid;
  perform pg_temp.chk('領収書を登録できる（pending で入る）', (r->>'ok')::boolean and (select status from receipts where id = rid) = 'pending', r::text);
  r := staff_receipt_add(k, '{"receipt_date":"2026-10-09","vendor":"文具店","amount":880,"paid_by":"cash"}', 'テスト');
  rid2 := (r->>'id')::uuid;
  begin perform staff_receipt_add(vk, '{"vendor":"x"}'); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('閲覧専用キーでは領収書を登録できない', e = 'スタッフキーが違います', e);
  r := staff_receipt_update(k, rid, jsonb_build_object('card_transaction_id', tc, 'status', 'confirmed'), 'テスト');
  perform pg_temp.chk('カード明細に紐づけて確認済みにできる（確認日時・確認者が入る）', (r->>'ok')::boolean
    and (select card_transaction_id = tc and status = 'confirmed' and confirmed_at is not null and confirmed_by = 'テスト' from receipts where id = rid), r::text);
  begin perform staff_receipt_update(k, rid2, '{"status":"maybe"}'); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('状態は pending/confirmed/rejected 以外にできない', e like '%状態%', e);
  r := staff_receipt_update(k, rid2, '{"category_code":"expense.supplies","amount":990}', 'テスト');
  perform pg_temp.chk('渡した項目だけ変わる（店名はそのまま）', (select vendor = '文具店' and amount = 990 and category_code = 'expense.supplies' from receipts where id = rid2), null);
  -- ファイル本体（base64）は DB に置き、キー確認つきの関数だけで出し入れ
  r := staff_receipt_file_put(k, rid2, 'image/jpeg', encode('\xffd8ffe000104a46494600'::bytea, 'base64'), 'テスト');
  perform pg_temp.chk('領収書のファイルを入れられる（大きさ・sha256 が記録され、台帳に mime と置き場が入る）', (r->>'ok')::boolean
    and (select size_bytes = 11 and length(sha256) = 64 from receipt_files where receipt_id = rid2)
    and (select mime = 'image/jpeg' and storage_path like 'db:receipt_files/%' from receipts where id = rid2), r::text);
  r := finance_receipt_file(vk, rid2);
  perform pg_temp.chk('閲覧専用キーでファイルを取り出せる（base64 が元に戻る）', (r->>'ok')::boolean and decode(r->>'base64', 'base64') = '\xffd8ffe000104a46494600'::bytea, left(r::text, 120));
  begin perform staff_receipt_file_put(k, rid2, 'text/plain', encode('abc', 'base64')); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('画像・PDF 以外は入れられない', e like '%受け付けません%', e);
  begin perform staff_receipt_file_put(k, rid2, 'image/png', ''); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('空のファイルは入れられない', e like '%空%', e);
  begin perform staff_receipt_file_put(vk, rid2, 'image/png', encode('abc', 'base64')); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('閲覧専用キーではファイルを入れられない', e = 'スタッフキーが違います', e);
  r := finance_receipt_file(vk, rid);
  perform pg_temp.chk('ファイルの無い領収書は ok=false', (r->>'ok')::boolean = false, r::text);
  r := finance_receipts_list(vk, null, null, 'pending');
  perform pg_temp.chk('領収書一覧（未確認だけ）を閲覧専用キーで読める', jsonb_array_length(r) = 1 and r->0->>'vendor' = '文具店', r::text);

  -- 8. 一覧・ダッシュボード・月次
  r := finance_bank_list(vk, '2026-10-01', '2026-10-31');
  perform pg_temp.chk('銀行明細一覧: 消込済みの入金には請求書、分類した出金には科目が出る', jsonb_array_length(r) = 2
    and (select x->'matched_docs'->0->>'doc_number' from jsonb_array_elements(r) x where (x->>'amount_in')::int = 12000) = 'INV-T-1'
    and (select x->>'category_code' from jsonb_array_elements(r) x where (x->>'amount_out')::int = 3000) = 'expense.utilities', r::text);
  r := finance_card_list(vk, '2026-10-01', '2026-10-31');
  perform pg_temp.chk('カード明細一覧: 科目と紐づいた領収書が出る', jsonb_array_length(r) = 4
    and (select x->>'receipt_id' from jsonb_array_elements(r) x where x->>'id' = tc::text) = rid::text, r::text);
  r := finance_overview(vk);
  perform pg_temp.chk('ダッシュボード: 役割・直近残高・未処理件数（未分類カード3・未確認領収書1）', r->>'role' = 'viewer' and (r->'latest'->>'balance')::int = 109000
    and (r->'pending'->>'card_unclassified')::int = 3 and (r->'pending'->>'receipts_pending')::int = 1 and (r->'pending'->>'bank_in_unmatched')::int = 0
    and (r->'pending'->>'bank_out_unclassified')::int = 0, r::text);
  r := finance_month(vk, '2026-10');
  perform pg_temp.chk('月次: 銀行・カード・領収書・科目・請求書がまとめて返る', jsonb_array_length(r->'bank') = 2 and jsonb_array_length(r->'card') = 4
    and jsonb_array_length(r->'receipts') = 2 and jsonb_array_length(r->'titles') = 29 and jsonb_array_length(r->'invoices') = 1, r::text);
  begin perform finance_month(vk, '2026/10'); e := null; exception when others then e := sqlerrm; end;
  perform pg_temp.chk('月の形が違えば例外', e like '%YYYY-MM%', e);
end $t$;

-- 9. 公開キー（anon）からは新しい表を直接読めない（anon の間は一時表に書けないので、結果を変数に取ってから記録する）
do $t$
declare e1 text; e2 text; e3 text; e4 text; e5 text;
begin
  set local role anon;
  begin perform count(*) from card_transactions; e1 := null; exception when others then e1 := sqlerrm; end;
  begin perform count(*) from receipts; e2 := null; exception when others then e2 := sqlerrm; end;
  begin perform count(*) from account_titles; e3 := null; exception when others then e3 := sqlerrm; end;
  begin perform count(*) from finance_classifications; e4 := null; exception when others then e4 := sqlerrm; end;
  begin perform count(*) from receipt_files; e5 := null; exception when others then e5 := sqlerrm; end;
  reset role;
  perform pg_temp.chk('anon は receipt_files を読めない', e5 like '%permission denied%', e5);
  perform pg_temp.chk('anon は card_transactions を読めない', e1 like '%permission denied%', e1);
  perform pg_temp.chk('anon は receipts を読めない', e2 like '%permission denied%', e2);
  perform pg_temp.chk('anon は account_titles を読めない（関数経由だけ）', e3 like '%permission denied%', e3);
  perform pg_temp.chk('anon は finance_classifications を読めない', e4 like '%permission denied%', e4);
end $t$;

select (case when ok then 'PASS' else 'FAIL' end) || ' : ' || name || coalesce('  [' || left(got, 240) || ']', '') from _t where not ok order by n;
select count(*) filter (where ok) || '/' || count(*) || ' passed' from _t;
