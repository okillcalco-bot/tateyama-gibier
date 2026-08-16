-- ロールバック: migrations/20260812_invoice_confirm.sql
-- 2/3 で追加した RPC・内部関数・監査テーブル・追加列をすべて削除し、
-- 名寄せ RPC を 1/3（20260811_invoice_staging.sql）の定義へ完全復元する。

-- ── 2/3 で追加した RPC ──
drop function if exists admin_invoice_exclude_import(text, uuid, boolean, text);
drop function if exists admin_invoice_cancel(text, uuid, text, text);
drop function if exists admin_invoice_finalize(text, uuid, text);
drop function if exists admin_invoice_set_amount_reason(text, uuid, text, text, text);
drop function if exists admin_invoice_map_product(text, uuid, text, uuid, text);
drop function if exists admin_invoice_set_customer(text, uuid, text, uuid, text);
drop function if exists admin_invoice_products(text);
drop function if exists admin_invoice_customer_search(text, text, int);
drop function if exists admin_invoice_detail(text, uuid);

-- ── 内部関数 ──
drop function if exists _invoice_recompute_import_status(uuid);
drop function if exists _invoice_audit(uuid, uuid, uuid, text, text, text);

-- ── 監査テーブル ──
drop table if exists invoice_audit;

-- ── 追加列 ──
alter table customer_purchase_facts
  drop column if exists cancel_reason,
  drop column if exists canceled_by,
  drop column if exists canceled_at;
alter table invoice_imports
  drop column if exists cancel_reason,
  drop column if exists canceled_at,
  drop column if exists canceled_by,
  drop column if exists finalized_at,
  drop column if exists finalized_by,
  drop column if exists confirmed_at,
  drop column if exists confirmed_by;
alter table invoice_lines
  drop column if exists product_decided_at,
  drop column if exists product_decided_by;
alter table invoice_documents
  drop column if exists amount_diff_kind,
  drop column if exists amount_diff_reason,
  drop column if exists customer_confirmed_at,
  drop column if exists customer_confirmed_by,
  drop column if exists conflict_detail,
  drop column if exists match_conflict;

-- ── 名寄せ RPC を 1/3 の定義へ完全復元 ──
create or replace function admin_invoice_run_matching(p_staff_key text, p_import_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_doc record; v_cid uuid; v_cnt int; v_auto int := 0; v_cand int := 0; v_none int := 0;
        v_best uuid; v_best_score numeric; v_best_method text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  for v_doc in
    select d.* from invoice_documents d
     where d.match_status in ('未照合','候補あり')
       and (p_import_id is null or d.import_id = p_import_id)
  loop
    v_best := null; v_best_score := 0; v_best_method := null;

    declare
      v_hay text := invoice_norm_code(
        coalesce(v_doc.raw_customer_name,'') || ' ' ||
        coalesce(v_doc.raw_addressee,'')    || ' ' ||
        coalesce(v_doc.note,''));
      v_labeled text[]; v_codes text[]; v_ids uuid[];
      v_no_auto boolean := false;
    begin
      v_labeled := array(
        select distinct r[1]
          from regexp_matches(v_hay,
            '(?:顧客|お客様|得意先|客先)\s*(?:コード|番号|NO\.?|ID)[\s：:＃#]*([A-Z0-9-]{4,})', 'g') as r);

      if coalesce(array_length(v_labeled,1),0) > 1 then
        v_no_auto := true;
        v_best_score := 0.50; v_best_method := 'code(複数コード印字)'; v_best := null;
      elsif coalesce(array_length(v_labeled,1),0) = 1 then
        select array_agg(distinct c.id) into v_ids
          from customers c
         where c.code is not null and invoice_norm_code(c.code) = v_labeled[1];
        if coalesce(array_length(v_ids,1),0) = 1 then
          update invoice_documents set customer_id = v_ids[1], match_confidence = 1.00,
            match_method = 'code', match_status = '確定', matched_by = 'auto', matched_at = now()
          where id = v_doc.id;
          v_auto := v_auto + 1; continue;
        elsif coalesce(array_length(v_ids,1),0) = 0 then
          v_no_auto := true;
        else
          v_no_auto := true;
          v_best_score := 0.50; v_best_method := 'code(同一コードの顧客が複数)'; v_best := null;
        end if;
      else
        select array_agg(distinct u.code_n), array_agg(distinct u.cid)
          into v_codes, v_ids
          from (
            select invoice_norm_code(c.code) as code_n, c.id as cid
              from customers c
             where c.code is not null
               and length(invoice_norm_code(c.code)) >= 4
               and invoice_norm_code(c.code) ~ '^[A-Z0-9][A-Z0-9-]*$'
               and invoice_norm_code(c.code) ~ '[A-Z]'
               and v_hay ~ ('(^|[^A-Z0-9-])' || invoice_norm_code(c.code) || '($|[^A-Z0-9-])')
          ) u;
        if coalesce(array_length(v_codes,1),0) = 1 and coalesce(array_length(v_ids,1),0) = 1 then
          update invoice_documents set customer_id = v_ids[1], match_confidence = 1.00,
            match_method = 'code', match_status = '確定', matched_by = 'auto', matched_at = now()
          where id = v_doc.id;
          v_auto := v_auto + 1; continue;
        elsif coalesce(array_length(v_codes,1),0) > 1 then
          v_best_score := 0.50; v_best_method := 'code(複数コード印字)'; v_best := null;
        elsif coalesce(array_length(v_codes,1),0) = 1 and coalesce(array_length(v_ids,1),0) > 1 then
          v_best_score := 0.50; v_best_method := 'code(同一コードの顧客が複数)'; v_best := null;
        end if;
      end if;

      if invoice_norm_phone(v_doc.raw_phone) is not null and length(invoice_norm_phone(v_doc.raw_phone)) >= 10 then
        select count(*), (array_agg(c.id))[1] into v_cnt, v_cid from customers c
         where invoice_norm_phone(c.phone) = invoice_norm_phone(v_doc.raw_phone);
        if v_cnt = 1 and not v_no_auto then
          update invoice_documents set customer_id = v_cid, match_confidence = 0.95,
            match_method = 'phone', match_status = '確定', matched_by = 'auto', matched_at = now()
          where id = v_doc.id;
          v_auto := v_auto + 1; continue;
        elsif v_cnt = 1 and v_no_auto and 0.70 > coalesce(v_best_score, 0) then
          v_best_score := 0.70; v_best_method := 'phone(コード未解決のため要確認)'; v_best := v_cid;
        elsif v_cnt > 1 and 0.70 > coalesce(v_best_score, 0) then
          v_best_score := 0.70; v_best_method := 'phone(複数)'; v_best := v_cid;
        end if;
      end if;
    end;

    declare v_nm uuid; v_ns numeric; begin
      select c.id, s.score into v_nm, v_ns
        from customers c
        cross join lateral (
          select case
            when nullif(regexp_replace(coalesce(v_doc.raw_postal,''),'\D','','g'),'') is not null
             and regexp_replace(coalesce(substring(c.address from '〒?\s*(\d{3}[-‐]?\d{4})'),''),'\D','','g')
                 = regexp_replace(v_doc.raw_postal,'\D','','g')
             and invoice_name_similarity(c.name, v_doc.raw_customer_name) >= 0.8
            then 0.75
            when invoice_norm_name(c.name) is not null
             and invoice_norm_name(c.name) = invoice_norm_name(v_doc.raw_customer_name) then 0.50
            when invoice_name_similarity(c.name, v_doc.raw_customer_name) >= 0.6 then 0.30
            else 0 end as score) s
       where s.score > 0
       order by s.score desc limit 1;
      if v_ns is not null and v_ns > coalesce(v_best_score, 0) then
        v_best := v_nm; v_best_score := v_ns; v_best_method := 'name';
      end if;
    end;

    if coalesce(v_best_score,0) > 0 then
      update invoice_documents set customer_id = v_best, match_confidence = v_best_score,
        match_method = v_best_method, match_status = '候補あり',
        matched_by = null, matched_at = null
      where id = v_doc.id;
      v_cand := v_cand + 1;
    else
      update invoice_documents set customer_id = null, match_confidence = 0,
        match_method = null, match_status = '未照合',
        matched_by = null, matched_at = null
      where id = v_doc.id;
      v_none := v_none + 1;
    end if;
  end loop;

  update invoice_imports i set status =
    case
      when exists (select 1 from invoice_documents d where d.import_id = i.id and d.match_status in ('未照合','候補あり')) then '顧客未照合'
      when exists (select 1 from invoice_lines l join invoice_documents d on d.id = l.document_id
                    where d.import_id = i.id and l.match_status <> '確定') then '商品未照合'
      else '要確認' end,
    updated_at = now()
  where i.status in ('抽出済','顧客未照合','商品未照合')
    and (p_import_id is null or i.id = p_import_id);

  return jsonb_build_object('ok', true, 'auto', v_auto, 'candidates', v_cand, 'unmatched', v_none);
end;
$$;
revoke all on function admin_invoice_run_matching(text, uuid) from public;
grant execute on function admin_invoice_run_matching(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
