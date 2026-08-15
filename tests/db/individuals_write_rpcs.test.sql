-- tests/db/individuals_write_rpcs.test.sql
-- 個体書込RPC(v2)のDBテスト。読み取り/巻き戻しのみ・非破壊・再実行可。
-- 期待と違えば raise exception。psql または MCP execute_sql で実行。
--
-- 検証: ACL（SECURITY DEFINER/search_path/PUBLIC不可/内部helperはanon不可/公開・staffは可）、
--   公開登録の仮番号固定・許可外エラー・受入情報不可、冪等（同異）、staff受入の正式番号、
--   submission_tokenの本人限定、統合編集+relabel単一tx、削除済み番号の再利用禁止、理由必須。

-- ── ACL ─────────────────────────────────────────────────────────────
do $$
declare bad text;
begin
  -- 全対象関数は SECURITY DEFINER かつ search_path 固定、PUBLIC EXECUTE なし
  select string_agg(proname, ',') into bad from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in
    ('public_capture_submit','staff_capture_intake','public_capture_update_survey','public_attach_capture_photo',
     'staff_individual_edit','staff_individual_update','staff_individual_create','staff_individual_soft_delete',
     'staff_individual_restore','_ind_apply','_ind_require_staff','_idem_begin','_idem_store','_capture_validate',
     '_reject_unknown_keys','_issue_submission_token','staff_token_resolve','staff_devices_revoke_all')
     and (not prosecdef or proconfig::text not like '%search_path%' or has_function_privilege('public', p.oid,'EXECUTE'));
  if bad is not null then raise exception 'ACL不備(sec_definer/search_path/public): %', bad; end if;

  -- 内部ヘルパは anon/authenticated から実行不可
  select string_agg(proname, ',') into bad from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in
    ('_ind_apply','_ind_require_staff','_idem_begin','_idem_store','_capture_validate','_reject_unknown_keys',
     '_issue_submission_token','staff_token_resolve','staff_devices_revoke_all')
     and (has_function_privilege('anon', p.oid,'EXECUTE') or has_function_privilege('authenticated', p.oid,'EXECUTE'));
  if bad is not null then raise exception '内部ヘルパがanon/authenticatedから実行可能: %', bad; end if;

  -- 公開/スタッフRPCは anon から実行可
  select string_agg(proname, ',') into bad from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('public_capture_submit','staff_capture_intake')
     and not has_function_privilege('anon', p.oid,'EXECUTE');
  if bad is not null then raise exception '公開/staff RPCがanonから実行不可: %', bad; end if;

  -- 監査/冪等/トークン表はRLS有効（anonポリシー無し＝直接DML不可）
  if not (select relrowsecurity from pg_class where oid='public.individual_audit'::regclass)
     or not (select relrowsecurity from pg_class where oid='public.request_log'::regclass)
     or not (select relrowsecurity from pg_class where oid='public.submission_tokens'::regclass)
     or not (select relrowsecurity from pg_class where oid='public.staff_device_tokens'::regclass)
  then raise exception '監査/冪等/トークン表のRLSが無効'; end if;
  raise notice 'ACL OK';
end $$;

-- ── 振る舞い（巻き戻し） ──────────────────────────────────────────────
do $$
declare tok text; toke text; r jsonb; r2 jsonb; iid uuid; e text; stok text; ed jsonb; delid uuid;
begin
  tok := 'dt_' || encode(extensions.gen_random_bytes(16),'hex');
  insert into staff_device_tokens(token_sha256, expires_at) values (encode(extensions.digest(tok,'sha256'),'hex'), now()+interval '30 days');
  toke := 'dt_' || encode(extensions.gen_random_bytes(16),'hex');
  insert into staff_device_tokens(token_sha256, expires_at) values (encode(extensions.digest(toke,'sha256'),'hex'), now()-interval '1 day');

  r := public_capture_submit('{"species":"シカ","sex":"オス","capture_city":"館山市","hunter_name":"検証"}'::jsonb, 'reqpub0000001');
  iid := (r->>'id')::uuid; stok := r->>'submission_token';
  if (r->>'label_id') not like '仮-%' then raise exception '公開が仮番号でない'; end if;
  if (r->>'serial_number') is not null then raise exception '公開でserialが付いた'; end if;
  if stok not like 'st\_%' then raise exception 'submission_token未発行'; end if;
  select intake_status into e from individuals where id=iid; if e <> '搬入待ち' then raise exception 'intake_status固定されず'; end if;

  begin perform public_capture_submit('{"species":"シカ","label_id":"TGC-08-T999"}'::jsonb,'reqpub0000002'); raise exception '公開でlabel_idが通った';
  exception when others then if sqlerrm not like '%許可されていない%' then raise; end if; end;
  begin perform public_capture_submit('{"species":"シカ","quality":"良"}'::jsonb,'reqpub0000003'); raise exception '公開でqualityが通った';
  exception when others then if sqlerrm not like '%許可されていない%' then raise; end if; end;

  r  := public_capture_submit('{"species":"シカ","hunter_name":"冪等"}'::jsonb,'reqidem000001');
  r2 := public_capture_submit('{"species":"シカ","hunter_name":"冪等"}'::jsonb,'reqidem000001');
  if (r->>'id') <> (r2->>'id') then raise exception '冪等でない'; end if;
  begin perform public_capture_submit('{"species":"イノシシ"}'::jsonb,'reqidem000001'); raise exception '同ID別payloadが通った';
  exception when others then if sqlerrm not like '%内容が異なります%' then raise; end if; end;

  r := staff_capture_intake(tok, '{"species":"イノシシ","label_id":"TGC-08-T950","serial_number":950,"capture_date":"2026-08-16","capture_city":"館山市","receive_time":"09:00","quality":"良"}'::jsonb, 'reqintk000001');
  if (r->>'label_id') <> 'TGC-08-T950' then raise exception 'staff intakeで正式番号が付かない'; end if;
  begin perform staff_capture_intake('garbage','{"species":"シカ"}'::jsonb,'reqintk000002'); raise exception 'intakeが無認証で通った';
  exception when others then if sqlstate<>'28000' then raise; end if; end;
  begin perform staff_capture_intake(toke,'{"species":"シカ"}'::jsonb,'reqintk000003'); raise exception '期限切れトークンが通った(生キーfallback)';
  exception when others then if sqlstate<>'28000' then raise; end if; end;

  perform public_capture_update_survey(stok, '{"submitter_name":"提出者X"}'::jsonb, 'reqsurv000001');
  begin perform public_capture_update_survey('st_bad','{"submitter_name":"Y"}'::jsonb,'reqsurv000002'); raise exception '無効トークンで調査票更新できた';
  exception when others then if sqlerrm not like '%トークン%' then raise; end if; end;

  insert into individuals(label_id, species, deleted_at) values ('TGC-08-DELETED1','シカ', now()) returning id into delid;
  ed := staff_individual_edit(tok, iid, '{"weight_total":22}'::jsonb, 'TGC-08-EDIT1', '検証編集');
  if (ed->>'relabeled')::boolean <> true then raise exception '統合編集で番号変更されず'; end if;
  begin perform staff_individual_edit(tok, iid, '{}'::jsonb, 'TGC-08-DELETED1', '再利用テスト'); raise exception '削除済み番号を再利用できた';
  exception when others then if sqlerrm not like '%既に使われています%' then raise; end if; end;

  begin perform staff_individual_soft_delete(tok, iid, ''); raise exception '理由なし削除が通った';
  exception when others then if sqlerrm not like '%理由%' then raise; end if; end;

  raise notice 'BEHAVIOR OK';
  raise exception 'ROLLBACK_OK';
exception when others then
  if sqlerrm='ROLLBACK_OK' then raise notice 'individuals_write_rpcs.test: ALL OK (rolled back)'; else raise; end if;
end $$;
