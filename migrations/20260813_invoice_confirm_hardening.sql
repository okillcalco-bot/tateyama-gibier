-- フェーズ4(2/3) ハードニング（Codexレビュー対応）2026-08-13
--
-- 前提: 20260811_invoice_staging.sql / 20260812_invoice_confirm.sql（本番適用済み）
--
-- 修正内容:
--  1. 反映済み(取込済)・除外の編集をサーバ側で拒否し、編集/再照合/反映/取消/除外を
--     同一 invoice_imports 行の FOR UPDATE で直列化する（状態チェックはロック取得後）
--  2. admin_invoice_customer_search: 数字桁ガード・80字上限・LIKEワイルドカードのエスケープ
--  3. admin_invoice_map_product: 別商品/対象外で product_id・alias の残存値を消す
--  4. 状態変更RPCは担当者名(p_by)を必須化（1〜80字・空白拒否・'staff'フォールバック廃止）
--
-- 担当者名はスタッフキー利用者による自己申告の操作名であり、Supabase Auth 移行までは
-- 認証済み本人を証明するものではない。移行後は actor を auth.uid() に結びつける前提を残す。
--
-- ロールバック: migrations/rollback/20260813_invoice_confirm_hardening_rollback.sql

-- ── 内部: 担当者名の検証（必須・1〜80字・前後空白除去） ──────────────
create or replace function _invoice_actor(p_by text)
returns text language plpgsql security definer set search_path = public as $$
declare v text := btrim(coalesce(p_by,''));
begin
  if length(v) = 0 then raise exception '担当者名を入力してください'; end if;
  if length(v) > 80 then raise exception '担当者名が長すぎます（80文字以内）'; end if;
  return v;
end;
$$;
revoke all on function _invoice_actor(text) from public, anon, authenticated;

-- ── 内部: 取込行をロックし、編集可能でなければ拒否する ────────────────
-- 取込済・除外は編集不可（取消して確認済へ戻してから編集する）。
-- 状態チェックは必ずロック取得後に行う。
create or replace function _invoice_lock_editable(p_import uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v text;
begin
  select status into v from invoice_imports where id = p_import for update;
  if v is null then raise exception '取込が見つかりません'; end if;
  if v in ('取込済','除外') then
    raise exception 'この取込は%のため編集できません。変更するには取消して確認済へ戻してください', v;
  end if;
end;
$$;
revoke all on function _invoice_lock_editable(uuid) from public, anon, authenticated;

-- ═══ 顧客の確定 / 対象外 / 未照合クリア（状態ゲート＋担当者必須） ═══
create or replace function admin_invoice_set_customer(p_staff_key text, p_document_id uuid,
  p_decision text, p_customer_id uuid default null, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_imp uuid; v_name text; v_code text; v_actor text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  v_actor := _invoice_actor(p_by);
  select import_id into v_imp from invoice_documents where id = p_document_id;
  if v_imp is null then raise exception '請求書が見つかりません'; end if;
  perform _invoice_lock_editable(v_imp);   -- 親行ロック＋取込済/除外を拒否（ロック後に判定）

  if p_decision = '確定' then
    if p_customer_id is null then raise exception '確定する顧客を指定してください'; end if;
    select name, code into v_name, v_code from customers where id = p_customer_id;
    if v_name is null then raise exception '指定の顧客が存在しません'; end if;
    update invoice_documents set customer_id = p_customer_id, match_status = '確定',
      match_method = 'manual', match_confidence = 1.00, match_conflict = false, conflict_detail = null,
      matched_by = v_actor, matched_at = now(),
      customer_confirmed_by = v_actor, customer_confirmed_at = now()
    where id = p_document_id;
    perform _invoice_audit(v_imp, p_document_id, null, 'customer_confirm', v_actor,
      '顧客を確定: '||coalesce(v_code,'')||' '||coalesce(v_name,''));
  elsif p_decision = '対象外' then
    update invoice_documents set customer_id = null, match_status = '対象外',
      match_method = 'manual', match_conflict = false, conflict_detail = null,
      matched_by = v_actor, matched_at = now(),
      customer_confirmed_by = v_actor, customer_confirmed_at = now()
    where id = p_document_id;
    perform _invoice_audit(v_imp, p_document_id, null, 'customer_exclude', v_actor, '顧客を対象外に指定');
  elsif p_decision = '未照合' then
    update invoice_documents set customer_id = null, match_status = '未照合',
      match_method = null, match_confidence = 0, match_conflict = false, conflict_detail = null,
      matched_by = null, matched_at = null, customer_confirmed_by = null, customer_confirmed_at = null
    where id = p_document_id;
    perform _invoice_audit(v_imp, p_document_id, null, 'customer_clear', v_actor, '顧客の確定を取消（未照合へ）');
  else
    raise exception '不正な操作です: %', p_decision;
  end if;

  return jsonb_build_object('ok', true, 'status', _invoice_recompute_import_status(v_imp));
end;
$$;
revoke all on function admin_invoice_set_customer(text, uuid, text, uuid, text) from public;
grant execute on function admin_invoice_set_customer(text, uuid, text, uuid, text) to anon, authenticated;

-- ═══ 明細の商品対応づけ / 保留 / 対象外（状態ゲート＋残存値クリア＋担当者必須） ═══
create or replace function admin_invoice_map_product(p_staff_key text, p_line_id uuid,
  p_decision text, p_product_id uuid default null, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_imp uuid; v_doc uuid; v_raw text; v_sp text; v_gr text; v_pname text; v_actor text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  v_actor := _invoice_actor(p_by);
  select l.document_id, d.import_id, l.raw_item_name, l.raw_species, l.raw_grade
    into v_doc, v_imp, v_raw, v_sp, v_gr
    from invoice_lines l join invoice_documents d on d.id = l.document_id
   where l.id = p_line_id;
  if v_imp is null then raise exception '明細が見つかりません'; end if;
  perform _invoice_lock_editable(v_imp);

  if p_decision = '対応づけ' then
    if p_product_id is null then raise exception '対応づける商品を指定してください'; end if;
    select display_name into v_pname from portal_products where id = p_product_id;
    if v_pname is null then raise exception '指定の商品が存在しません'; end if;
    update invoice_lines set product_id = p_product_id, match_status = '確定',
      match_method = 'manual', match_confidence = 1.00,
      product_decided_by = v_actor, product_decided_at = now()
    where id = p_line_id;
    insert into product_name_aliases (raw_name, raw_species, raw_grade, product_id, decision, decided_by, decided_at)
    values (v_raw, v_sp, v_gr, p_product_id, '対応づけ', v_actor, now())
    on conflict (raw_name, coalesce(raw_species,''), coalesce(raw_grade,''))
    do update set product_id = excluded.product_id, decision = '対応づけ',
                  decided_by = excluded.decided_by, decided_at = excluded.decided_at;
    perform _invoice_audit(v_imp, v_doc, p_line_id, 'product_map', v_actor, '商品を対応づけ: '||coalesce(v_pname,''));
  elsif p_decision = '別商品' then
    update invoice_lines set product_id = null, match_status = '保留', match_method = 'manual',
      product_decided_by = v_actor, product_decided_at = now()
    where id = p_line_id;
    insert into product_name_aliases (raw_name, raw_species, raw_grade, product_id, decision, decided_by, decided_at)
    values (v_raw, v_sp, v_gr, null, '別商品', v_actor, now())
    on conflict (raw_name, coalesce(raw_species,''), coalesce(raw_grade,''))
    do update set product_id = null, decision = '別商品', decided_by = excluded.decided_by, decided_at = excluded.decided_at;
    perform _invoice_audit(v_imp, v_doc, p_line_id, 'product_hold', v_actor, '別商品として保留');
  elsif p_decision = '対象外' then
    update invoice_lines set product_id = null, match_status = '対象外', match_method = 'manual',
      product_decided_by = v_actor, product_decided_at = now()
    where id = p_line_id;
    insert into product_name_aliases (raw_name, raw_species, raw_grade, product_id, decision, decided_by, decided_at)
    values (v_raw, v_sp, v_gr, null, '対象外', v_actor, now())
    on conflict (raw_name, coalesce(raw_species,''), coalesce(raw_grade,''))
    do update set product_id = null, decision = '対象外', decided_by = excluded.decided_by, decided_at = excluded.decided_at;
    perform _invoice_audit(v_imp, v_doc, p_line_id, 'product_exclude', v_actor, '注文サイト対象外に指定');
  elsif p_decision = '未照合' then
    update invoice_lines set product_id = null, match_status = '未照合', match_method = null,
      product_decided_by = null, product_decided_at = null
    where id = p_line_id;
    perform _invoice_audit(v_imp, v_doc, p_line_id, 'product_clear', v_actor, '商品の対応づけを取消');
  else
    raise exception '不正な操作です: %', p_decision;
  end if;

  return jsonb_build_object('ok', true, 'status', _invoice_recompute_import_status(v_imp));
end;
$$;
revoke all on function admin_invoice_map_product(text, uuid, text, uuid, text) from public;
grant execute on function admin_invoice_map_product(text, uuid, text, uuid, text) to anon, authenticated;

-- ═══ 金額差異の理由入力（状態ゲート＋担当者必須） ═══
create or replace function admin_invoice_set_amount_reason(p_staff_key text, p_document_id uuid,
  p_reason text, p_kind text default null, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_imp uuid; v_actor text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  v_actor := _invoice_actor(p_by);
  select import_id into v_imp from invoice_documents where id = p_document_id;
  if v_imp is null then raise exception '請求書が見つかりません'; end if;
  perform _invoice_lock_editable(v_imp);
  update invoice_documents set amount_diff_reason = nullif(btrim(coalesce(p_reason,'')),''),
    amount_diff_kind = nullif(btrim(coalesce(p_kind,'')),'')
  where id = p_document_id;
  perform _invoice_audit(v_imp, p_document_id, null, 'amount_reason', v_actor,
    '金額差異の理由: '||coalesce(nullif(p_kind,''),'')||' '||coalesce(left(p_reason,80),''));
  return jsonb_build_object('ok', true, 'status', _invoice_recompute_import_status(v_imp));
end;
$$;
revoke all on function admin_invoice_set_amount_reason(text, uuid, text, text, text) from public;
grant execute on function admin_invoice_set_amount_reason(text, uuid, text, text, text) to anon, authenticated;

-- ═══ 実績反映（担当者必須。既存の単一TX・親行ロックは維持） ═══
create or replace function admin_invoice_finalize(p_staff_key text, p_import_id uuid, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_status text; v_doc record; v_line record; v_facts int := 0; v_docs int := 0;
        v_on date; v_diff numeric; v_sum numeric; v_actor text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  v_actor := _invoice_actor(p_by);
  select status into v_status from invoice_imports where id = p_import_id for update;
  if v_status is null then raise exception '取込が見つかりません'; end if;
  if v_status = '除外' then raise exception 'この取込は除外されています'; end if;
  if v_status = '取込済' then
    return jsonb_build_object('ok', true, 'already', true, 'facts', 0);
  end if;
  for v_doc in select * from invoice_documents where import_id = p_import_id loop
    if v_doc.match_status not in ('確定','対象外') then
      raise exception '顧客が未確定の請求書があります（伝票 %）', coalesce(v_doc.invoice_number,'?');
    end if;
    if v_doc.match_status = '対象外' then continue; end if;
    if v_doc.customer_id is null then
      raise exception '確定済みなのに顧客が空です（伝票 %）', coalesce(v_doc.invoice_number,'?');
    end if;
    for v_line in select * from invoice_lines where document_id = v_doc.id loop
      if v_line.match_status not in ('確定','対象外') then
        raise exception '商品が未対応の明細があります（伝票 % 行 %）', coalesce(v_doc.invoice_number,'?'), v_line.line_no;
      end if;
      if v_line.match_status = '確定' then
        if v_line.product_id is null then
          raise exception '対応づけ済みなのに商品が空です（伝票 % 行 %）', coalesce(v_doc.invoice_number,'?'), v_line.line_no;
        end if;
        if v_line.weight_kg is null or v_line.amount is null then
          raise exception '重量・金額が未入力の明細があります（伝票 % 行 %）', coalesce(v_doc.invoice_number,'?'), v_line.line_no;
        end if;
      end if;
    end loop;
    if v_doc.total_amount is not null then
      select coalesce(sum(coalesce(amount,0)),0) into v_sum from invoice_lines where document_id = v_doc.id;
      v_diff := v_doc.total_amount - v_sum;
      if abs(v_diff) > 0.009 and coalesce(btrim(v_doc.amount_diff_reason),'') = '' then
        raise exception '金額差異（%円）の理由が未入力です（伝票 %）', v_diff, coalesce(v_doc.invoice_number,'?');
      end if;
    end if;
    v_on := coalesce(v_doc.delivery_date, v_doc.invoice_date);
    if v_on is null then
      raise exception '請求日または納品日が必要です（伝票 %）', coalesce(v_doc.invoice_number,'?');
    end if;
    for v_line in select * from invoice_lines where document_id = v_doc.id and match_status = '確定' loop
      insert into customer_purchase_facts (customer_id, product_id, purchased_on, weight_kg, unit_price, amount, source_kind, source_id)
      values (v_doc.customer_id, v_line.product_id, v_on, v_line.weight_kg, v_line.unit_price, v_line.amount, 'invoice', v_line.id)
      on conflict (source_kind, source_id) do update set
        customer_id = excluded.customer_id, product_id = excluded.product_id, purchased_on = excluded.purchased_on,
        weight_kg = excluded.weight_kg, unit_price = excluded.unit_price, amount = excluded.amount,
        canceled_at = null, canceled_by = null, cancel_reason = null;
      v_facts := v_facts + 1;
    end loop;
    v_docs := v_docs + 1;
  end loop;
  update invoice_imports set status = '取込済',
    confirmed_by = v_actor, confirmed_at = now(),
    finalized_by = v_actor, finalized_at = now(),
    canceled_by = null, canceled_at = null, cancel_reason = null, updated_at = now()
  where id = p_import_id;
  perform _invoice_audit(p_import_id, null, null, 'finalize', v_actor,
    '実績反映: 請求書'||v_docs||'枚・明細'||v_facts||'行');
  return jsonb_build_object('ok', true, 'already', false, 'facts', v_facts, 'documents', v_docs);
end;
$$;
revoke all on function admin_invoice_finalize(text, uuid, text) from public;
grant execute on function admin_invoice_finalize(text, uuid, text) to anon, authenticated;

-- ═══ 取消（担当者必須。既存の親行ロック・ソフト取消・二重取消拒否は維持） ═══
create or replace function admin_invoice_cancel(p_staff_key text, p_import_id uuid, p_reason text, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_status text; v_facts int := 0; v_actor text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  v_actor := _invoice_actor(p_by);
  if coalesce(btrim(p_reason),'') = '' then raise exception '取消理由を入力してください'; end if;
  select status into v_status from invoice_imports where id = p_import_id for update;
  if v_status is null then raise exception '取込が見つかりません'; end if;
  if v_status <> '取込済' then raise exception '反映済み（取込済）の取込のみ取消できます'; end if;
  update customer_purchase_facts f set canceled_at = now(),
    canceled_by = v_actor, cancel_reason = p_reason
  where f.source_kind = 'invoice' and f.canceled_at is null
    and f.source_id in (select l.id from invoice_lines l
                        join invoice_documents d on d.id = l.document_id
                        where d.import_id = p_import_id);
  get diagnostics v_facts = row_count;
  update invoice_imports set status = '確認済',
    canceled_by = v_actor, canceled_at = now(), cancel_reason = p_reason,
    finalized_by = null, finalized_at = null, updated_at = now()
  where id = p_import_id;
  perform _invoice_audit(p_import_id, null, null, 'cancel', v_actor,
    '実績取消: '||v_facts||'行 / 理由: '||left(p_reason,80));
  return jsonb_build_object('ok', true, 'canceled_facts', v_facts, 'status', '確認済');
end;
$$;
revoke all on function admin_invoice_cancel(text, uuid, text, text) from public;
grant execute on function admin_invoice_cancel(text, uuid, text, text) to anon, authenticated;

-- ═══ 除外 / 除外解除（担当者必須。既存の親行ロックは維持） ═══
create or replace function admin_invoice_exclude_import(p_staff_key text, p_import_id uuid, p_exclude boolean, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_status text; v_actor text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  v_actor := _invoice_actor(p_by);
  select status into v_status from invoice_imports where id = p_import_id for update;
  if v_status is null then raise exception '取込が見つかりません'; end if;
  if p_exclude then
    if v_status = '取込済' then raise exception '反映済みの取込は先に取消してください'; end if;
    update invoice_imports set status = '除外', updated_at = now() where id = p_import_id;
    perform _invoice_audit(p_import_id, null, null, 'exclude', v_actor, '取込を除外');
    return jsonb_build_object('ok', true, 'status', '除外');
  else
    if v_status <> '除外' then raise exception '除外中の取込のみ解除できます'; end if;
    update invoice_imports set status = '抽出済', updated_at = now() where id = p_import_id;
    perform _invoice_audit(p_import_id, null, null, 'unexclude', v_actor, '除外を解除');
    return jsonb_build_object('ok', true, 'status', _invoice_recompute_import_status(p_import_id));
  end if;
end;
$$;
revoke all on function admin_invoice_exclude_import(text, uuid, boolean, text) from public;
grant execute on function admin_invoice_exclude_import(text, uuid, boolean, text) to anon, authenticated;

-- ═══ 名寄せ（取込単位で親行ロック→取込済/除外はskip。finalize/編集と直列化） ═══
create or replace function admin_invoice_run_matching(p_staff_key text, p_import_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_imp record; v_doc record; v_cnt int; v_auto int := 0; v_cand int := 0; v_none int := 0; v_conflict int := 0;
        v_best uuid; v_best_score numeric; v_best_method text;
        v_phone_cnt int; v_phone_first uuid; v_phone_cid uuid;
        v_no_auto boolean; v_pmap int := 0; v_p int;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;

  -- 取込単位でロックしながら処理する（取込済・除外は対象にしない＝安全にskip）。
  -- FOR UPDATE により finalize/cancel/exclude/編集RPC と同じ親行で直列化される。
  for v_imp in
    select id from invoice_imports
     where (p_import_id is null or id = p_import_id)
       and status not in ('取込済','除外')
     order by id
     for update
  loop
    for v_doc in
      select d.* from invoice_documents d
       where d.import_id = v_imp.id and d.match_status in ('未照合','候補あり')
    loop
      v_best := null; v_best_score := 0; v_best_method := null; v_no_auto := false;
      v_phone_cnt := 0; v_phone_first := null; v_phone_cid := null;
      if invoice_norm_phone(v_doc.raw_phone) is not null and length(invoice_norm_phone(v_doc.raw_phone)) >= 10 then
        select count(*), (array_agg(c.id))[1] into v_phone_cnt, v_phone_first from customers c
         where invoice_norm_phone(c.phone) = invoice_norm_phone(v_doc.raw_phone);
        if v_phone_cnt = 1 then v_phone_cid := v_phone_first; end if;
      end if;

      declare
        v_hay text := invoice_norm_code(
          coalesce(v_doc.raw_customer_name,'') || ' ' ||
          coalesce(v_doc.raw_addressee,'')    || ' ' ||
          coalesce(v_doc.note,''));
        v_labeled text[]; v_codes text[]; v_ids uuid[];
        v_code_cid uuid := null;
      begin
        v_labeled := array(
          select distinct r[1]
            from regexp_matches(v_hay,
              '(?:顧客|お客様|得意先|客先)\s*(?:コード|番号|NO\.?|ID)[\s：:＃#]*([A-Z0-9-]{4,})', 'g') as r);
        if coalesce(array_length(v_labeled,1),0) > 1 then
          v_no_auto := true; v_best_score := 0.50; v_best_method := 'code(複数コード印字)';
        elsif coalesce(array_length(v_labeled,1),0) = 1 then
          select array_agg(distinct c.id) into v_ids
            from customers c where c.code is not null and invoice_norm_code(c.code) = v_labeled[1];
          if coalesce(array_length(v_ids,1),0) = 1 then v_code_cid := v_ids[1];
          elsif coalesce(array_length(v_ids,1),0) = 0 then v_no_auto := true;
          else v_no_auto := true; v_best_score := 0.50; v_best_method := 'code(同一コードの顧客が複数)'; end if;
        else
          select array_agg(distinct u.code_n), array_agg(distinct u.cid) into v_codes, v_ids
            from (select invoice_norm_code(c.code) as code_n, c.id as cid from customers c
               where c.code is not null and length(invoice_norm_code(c.code)) >= 4
                 and invoice_norm_code(c.code) ~ '^[A-Z0-9][A-Z0-9-]*$'
                 and invoice_norm_code(c.code) ~ '[A-Z]'
                 and v_hay ~ ('(^|[^A-Z0-9-])' || invoice_norm_code(c.code) || '($|[^A-Z0-9-])')) u;
          if coalesce(array_length(v_codes,1),0) = 1 and coalesce(array_length(v_ids,1),0) = 1 then v_code_cid := v_ids[1];
          elsif coalesce(array_length(v_codes,1),0) > 1 then v_best_score := 0.50; v_best_method := 'code(複数コード印字)';
          elsif coalesce(array_length(v_codes,1),0) = 1 and coalesce(array_length(v_ids,1),0) > 1 then v_best_score := 0.50; v_best_method := 'code(同一コードの顧客が複数)'; end if;
        end if;
        if v_code_cid is not null then
          if v_phone_cid is not null and v_phone_cid <> v_code_cid then
            update invoice_documents set customer_id = v_code_cid, match_confidence = 0.50,
              match_method = 'conflict', match_status = '候補あり', match_conflict = true,
              conflict_detail = '照合情報が矛盾しています（顧客コード: '
                || coalesce((select name from customers where id = v_code_cid),'?')
                || ' ／ 電話番号: ' || coalesce((select name from customers where id = v_phone_cid),'?')
                || '）。人が確認して確定してください',
              matched_by = null, matched_at = null where id = v_doc.id;
            v_conflict := v_conflict + 1; v_cand := v_cand + 1; continue;
          else
            update invoice_documents set customer_id = v_code_cid, match_confidence = 1.00,
              match_method = 'code', match_status = '確定', match_conflict = false, conflict_detail = null,
              matched_by = 'auto', matched_at = now() where id = v_doc.id;
            v_auto := v_auto + 1; continue;
          end if;
        end if;
      end;

      if v_phone_cid is not null then
        if not v_no_auto then
          update invoice_documents set customer_id = v_phone_cid, match_confidence = 0.95,
            match_method = 'phone', match_status = '確定', match_conflict = false, conflict_detail = null,
            matched_by = 'auto', matched_at = now() where id = v_doc.id;
          v_auto := v_auto + 1; continue;
        elsif 0.70 > coalesce(v_best_score,0) then
          v_best_score := 0.70; v_best_method := 'phone(コード未解決のため要確認)'; v_best := v_phone_cid;
        end if;
      elsif v_phone_cnt > 1 and 0.70 > coalesce(v_best_score,0) then
        v_best_score := 0.70; v_best_method := 'phone(複数)'; v_best := v_phone_first;
      end if;

      declare v_nm uuid; v_ns numeric; begin
        select c.id, s.score into v_nm, v_ns from customers c
          cross join lateral (select case
              when nullif(regexp_replace(coalesce(v_doc.raw_postal,''),'\D','','g'),'') is not null
               and regexp_replace(coalesce(substring(c.address from '〒?\s*(\d{3}[-‐]?\d{4})'),''),'\D','','g') = regexp_replace(v_doc.raw_postal,'\D','','g')
               and invoice_name_similarity(c.name, v_doc.raw_customer_name) >= 0.8 then 0.75
              when invoice_norm_name(c.name) is not null and invoice_norm_name(c.name) = invoice_norm_name(v_doc.raw_customer_name) then 0.50
              when invoice_name_similarity(c.name, v_doc.raw_customer_name) >= 0.6 then 0.30
              else 0 end as score) s
         where s.score > 0 order by s.score desc limit 1;
        if v_ns is not null and v_ns > coalesce(v_best_score, 0) then v_best := v_nm; v_best_score := v_ns; v_best_method := 'name'; end if;
      end;

      if coalesce(v_best_score,0) > 0 then
        update invoice_documents set customer_id = v_best, match_confidence = v_best_score,
          match_method = v_best_method, match_status = '候補あり', match_conflict = false, conflict_detail = null,
          matched_by = null, matched_at = null where id = v_doc.id;
        v_cand := v_cand + 1;
      else
        update invoice_documents set customer_id = null, match_confidence = 0,
          match_method = null, match_status = '未照合', match_conflict = false, conflict_detail = null,
          matched_by = null, matched_at = null where id = v_doc.id;
        v_none := v_none + 1;
      end if;
    end loop;

    -- 商品名 alias の前埋め（この取込ぶんだけ）
    update invoice_lines l set product_id = a.product_id, match_confidence = 0.90,
      match_method = 'alias', match_status = '確定'
    from product_name_aliases a
    where a.decision = '対応づけ' and a.product_id is not null
      and a.raw_name = l.raw_item_name
      and coalesce(a.raw_species,'') = coalesce(l.raw_species,'')
      and coalesce(a.raw_grade,'')   = coalesce(l.raw_grade,'')
      and l.match_status = '未照合'
      and l.document_id in (select d.id from invoice_documents d where d.import_id = v_imp.id);
    get diagnostics v_p = row_count;
    v_pmap := v_pmap + v_p;

    perform _invoice_recompute_import_status(v_imp.id);
  end loop;

  return jsonb_build_object('ok', true, 'auto', v_auto, 'candidates', v_cand,
    'unmatched', v_none, 'conflicts', v_conflict, 'products_prefilled', v_pmap);
end;
$$;
revoke all on function admin_invoice_run_matching(text, uuid) from public;
grant execute on function admin_invoice_run_matching(text, uuid) to anon, authenticated;

-- ═══ 顧客検索（数字桁ガード・80字上限・LIKEワイルドカードのエスケープ） ═══
create or replace function admin_invoice_customer_search(p_staff_key text, p_q text, p_limit int default 20)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; v_q text := btrim(coalesce(p_q,'')); v_qn text; v_digits text;
        v_like text; v_qn_like text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if length(v_q) = 0 then return '[]'::jsonb; end if;
  if length(v_q) > 80 then raise exception '検索語が長すぎます（80文字以内）'; end if;

  v_digits := regexp_replace(v_q, '\D', '', 'g');                     -- 数字だけ
  -- LIKE のワイルドカード（\ % _）を通常文字として扱う
  v_like := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  v_qn := invoice_norm_name(v_q);
  v_qn_like := case when v_qn is null then null
                    else replace(replace(replace(v_qn, '\', '\\'), '%', '\%'), '_', '\_') end;

  select coalesce(jsonb_agg(x order by x_code), '[]'::jsonb) into v from (
    select jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name,
             'phone_tail', case when c.phone is null then null
                                else right(regexp_replace(c.phone,'\D','','g'),4) end) as x,
           c.code as x_code
      from customers c
     where c.code ilike '%'||v_like||'%' escape '\'
        or c.name ilike '%'||v_like||'%' escape '\'
        or c.kana ilike '%'||v_like||'%' escape '\'
        or (v_qn_like is not null and length(v_qn_like) > 0
            and invoice_norm_name(c.name) like '%'||v_qn_like||'%' escape '\')
        or (length(v_digits) >= 4
            and regexp_replace(coalesce(c.phone,''),'\D','','g') like '%'||v_digits||'%')
     order by c.code
     limit greatest(1, least(p_limit, 50))
  ) t;
  return v;
end;
$$;
revoke all on function admin_invoice_customer_search(text, text, int) from public;
grant execute on function admin_invoice_customer_search(text, text, int) to anon, authenticated;

notify pgrst, 'reload schema';
