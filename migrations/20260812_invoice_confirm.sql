-- フェーズ4(2/3): 請求書取込の確認画面まわり（監査列・確定/対象外・商品対応づけ・
--                 金額検算・実績反映・取消）2026-08-12
--
-- 前提: migrations/20260811_invoice_staging.sql（フェーズ4 1/3・Codex承認済み c395bda）
--
-- 方針:
--  * ステージングは引き続き anon 直接アクセス不可。読み書きは admin_invoice_* RPC のみ
--  * すべての RPC は先頭で staff_key_ok を実行。SECURITY DEFINER + search_path 固定。
--    PUBLIC から EXECUTE を剥奪し、必要な RPC だけ anon/authenticated へ GRANT
--  * 住所・電話番号・スタッフキーは監査・conflict_detail に一切書かない（顧客名・コードのみ）
--  * 実績反映は「単一 SECURITY DEFINER RPC・単一トランザクション」。取込行を FOR UPDATE で
--    ロックして連打・再送しても二重計上しない。一部明細だけ反映される状態を作らない
--  * 取消は物理削除しない（canceled_* 列でソフト取消）。二重取消は拒否。再反映は可能
--
-- ロールバック: migrations/rollback/20260812_invoice_confirm_rollback.sql

-- ── 監査・確定用の追加列（すべて「追加のみ」・IF NOT EXISTS） ─────────
alter table invoice_documents
  add column if not exists match_conflict        boolean not null default false,
  add column if not exists conflict_detail       text,
  add column if not exists customer_confirmed_by text,
  add column if not exists customer_confirmed_at timestamptz,
  add column if not exists amount_diff_reason    text,
  add column if not exists amount_diff_kind      text;   -- 税 / 送料 / 値引き / その他

alter table invoice_lines
  add column if not exists product_decided_by text,
  add column if not exists product_decided_at timestamptz;

alter table invoice_imports
  add column if not exists confirmed_by  text,
  add column if not exists confirmed_at  timestamptz,
  add column if not exists finalized_by  text,
  add column if not exists finalized_at  timestamptz,
  add column if not exists canceled_by   text,
  add column if not exists canceled_at   timestamptz,
  add column if not exists cancel_reason text;

alter table customer_purchase_facts
  add column if not exists canceled_at   timestamptz,
  add column if not exists canceled_by   text,
  add column if not exists cancel_reason text;

-- ── 監査ログ（追記専用・人が読む履歴） ───────────────────────────────
-- 顧客の確定/変更・商品の対応づけ・最終確認・実績反映・取消を、いつ誰が行ったか残す。
-- 個人情報（住所・電話・スタッフキー）は detail に入れない。
create table if not exists invoice_audit (
  id          uuid primary key default gen_random_uuid(),
  import_id   uuid references invoice_imports(id)   on delete cascade,
  document_id uuid references invoice_documents(id) on delete set null,
  line_id     uuid references invoice_lines(id)     on delete set null,
  action      text not null,   -- customer_confirm / customer_exclude / customer_clear /
                               -- product_map / product_hold / product_exclude /
                               -- amount_reason / rematch / finalize / cancel
  actor       text,
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists invoice_audit_import_idx on invoice_audit (import_id, created_at);

alter table invoice_audit enable row level security;
revoke all on invoice_audit from anon, authenticated;

-- ── 内部: 監査行を1件書く（RPC からのみ呼ぶ） ──────────────────────
create or replace function _invoice_audit(p_import uuid, p_doc uuid, p_line uuid,
                                          p_action text, p_actor text, p_detail text)
returns void language sql security definer set search_path = public as $$
  insert into invoice_audit (import_id, document_id, line_id, action, actor, detail)
  values (p_import, p_doc, p_line, p_action, nullif(p_actor,''), nullif(p_detail,''));
$$;
revoke all on function _invoice_audit(uuid,uuid,uuid,text,text,text) from public, anon, authenticated;

-- ── 内部: 取込のステータスを現在の状態から再計算する ────────────────
-- 未処理/抽出済 → 顧客未照合 → 商品未照合 → 要確認 → 確認済 の順に「準備完了」へ寄せる。
-- 取込済 / 除外 は下げない（確定済み・除外済みを巻き戻さない）。
create or replace function _invoice_recompute_import_status(p_import uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_cur text; v_new text;
begin
  select status into v_cur from invoice_imports where id = p_import;
  if v_cur is null or v_cur in ('取込済','除外') then return v_cur; end if;

  if exists (select 1 from invoice_documents d
              where d.import_id = p_import and d.match_status not in ('確定','対象外')) then
    v_new := '顧客未照合';
  elsif exists (select 1 from invoice_lines l
                 join invoice_documents d on d.id = l.document_id
                where d.import_id = p_import and d.match_status = '確定'
                  and l.match_status not in ('確定','対象外')) then
    v_new := '商品未照合';
  elsif exists (select 1 from invoice_documents d
                where d.import_id = p_import and d.match_status = '確定'
                  and d.total_amount is not null
                  and abs(d.total_amount - coalesce(
                        (select sum(coalesce(l.amount,0)) from invoice_lines l where l.document_id = d.id),0)) > 0.009
                  and coalesce(btrim(d.amount_diff_reason),'') = '') then
    v_new := '要確認';
  else
    v_new := '確認済';
  end if;

  update invoice_imports set status = v_new, updated_at = now() where id = p_import;
  return v_new;
end;
$$;
revoke all on function _invoice_recompute_import_status(uuid) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════
--  名寄せ RPC を差し替え（1/3 の挙動を保ちつつ §5 の矛盾検出を追加）
--  変更点だけ:
--   * 電話の一意候補を「コード確定より前」に求めておく
--   * ラベル付きコードが1顧客に確定でき、かつ電話が別の1顧客に一意一致する場合は
--     自動確定せず match_conflict=true・候補ありにする（人が選ぶまで確定しない）
--   * 商品名 alias（decision='対応づけ'）が既にある明細は match_method='alias' で
--     '確定' に前埋めする（候補として利用。ただし実績反映は最終確認必須）
-- ═══════════════════════════════════════════════════════════════════
create or replace function admin_invoice_run_matching(p_staff_key text, p_import_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_doc record; v_cnt int; v_auto int := 0; v_cand int := 0; v_none int := 0; v_conflict int := 0;
        v_best uuid; v_best_score numeric; v_best_method text;
        v_phone_cnt int; v_phone_first uuid; v_phone_cid uuid;
        v_no_auto boolean; v_pmap int := 0;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  for v_doc in
    select d.* from invoice_documents d
     where d.match_status in ('未照合','候補あり')
       and (p_import_id is null or d.import_id = p_import_id)
  loop
    v_best := null; v_best_score := 0; v_best_method := null; v_no_auto := false;

    -- 電話の一意候補を先に求める（コード確定より前。矛盾検出に使う）
    v_phone_cnt := 0; v_phone_first := null; v_phone_cid := null;
    if invoice_norm_phone(v_doc.raw_phone) is not null and length(invoice_norm_phone(v_doc.raw_phone)) >= 10 then
      select count(*), (array_agg(c.id))[1] into v_phone_cnt, v_phone_first from customers c
       where invoice_norm_phone(c.phone) = invoice_norm_phone(v_doc.raw_phone);
      if v_phone_cnt = 1 then v_phone_cid := v_phone_first; end if;
    end if;

    -- 1) 顧客コード（ラベル付きの事前抽出 → 完全一致。挙動は 1/3 と同じ）
    declare
      v_hay text := invoice_norm_code(
        coalesce(v_doc.raw_customer_name,'') || ' ' ||
        coalesce(v_doc.raw_addressee,'')    || ' ' ||
        coalesce(v_doc.note,''));
      v_labeled text[]; v_codes text[]; v_ids uuid[];
      v_code_cid uuid := null;   -- コードで一意に確定できた顧客（自動確定候補）
    begin
      v_labeled := array(
        select distinct r[1]
          from regexp_matches(v_hay,
            '(?:顧客|お客様|得意先|客先)\s*(?:コード|番号|NO\.?|ID)[\s：:＃#]*([A-Z0-9-]{4,})', 'g') as r);

      if coalesce(array_length(v_labeled,1),0) > 1 then
        v_no_auto := true; v_best_score := 0.50; v_best_method := 'code(複数コード印字)';
      elsif coalesce(array_length(v_labeled,1),0) = 1 then
        select array_agg(distinct c.id) into v_ids
          from customers c
         where c.code is not null and invoice_norm_code(c.code) = v_labeled[1];
        if coalesce(array_length(v_ids,1),0) = 1 then
          v_code_cid := v_ids[1];
        elsif coalesce(array_length(v_ids,1),0) = 0 then
          v_no_auto := true;   -- 未登録コード（またはOCR誤読）→ 推測確定しない
        else
          v_no_auto := true; v_best_score := 0.50; v_best_method := 'code(同一コードの顧客が複数)';
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
          v_code_cid := v_ids[1];
        elsif coalesce(array_length(v_codes,1),0) > 1 then
          v_best_score := 0.50; v_best_method := 'code(複数コード印字)';
        elsif coalesce(array_length(v_codes,1),0) = 1 and coalesce(array_length(v_ids,1),0) > 1 then
          v_best_score := 0.50; v_best_method := 'code(同一コードの顧客が複数)';
        end if;
      end if;

      -- コードで一意に確定できた場合の分岐
      if v_code_cid is not null then
        if v_phone_cid is not null and v_phone_cid <> v_code_cid then
          -- §5 矛盾: コードは顧客A・電話は顧客B → 自動確定せず要確認（人が選ぶ）
          update invoice_documents set customer_id = v_code_cid, match_confidence = 0.50,
            match_method = 'conflict', match_status = '候補あり', match_conflict = true,
            conflict_detail = '照合情報が矛盾しています（顧客コード: '
              || coalesce((select name from customers where id = v_code_cid),'?')
              || ' ／ 電話番号: '
              || coalesce((select name from customers where id = v_phone_cid),'?')
              || '）。人が確認して確定してください',
            matched_by = null, matched_at = null
          where id = v_doc.id;
          v_conflict := v_conflict + 1; v_cand := v_cand + 1; continue;
        else
          update invoice_documents set customer_id = v_code_cid, match_confidence = 1.00,
            match_method = 'code', match_status = '確定', match_conflict = false, conflict_detail = null,
            matched_by = 'auto', matched_at = now()
          where id = v_doc.id;
          v_auto := v_auto + 1; continue;
        end if;
      end if;
    end;

    -- 2) 電話の完全一致（コード未解決でないときだけ 0.95 自動確定）
    if v_phone_cid is not null then
      if not v_no_auto then
        update invoice_documents set customer_id = v_phone_cid, match_confidence = 0.95,
          match_method = 'phone', match_status = '確定', match_conflict = false, conflict_detail = null,
          matched_by = 'auto', matched_at = now()
        where id = v_doc.id;
        v_auto := v_auto + 1; continue;
      elsif 0.70 > coalesce(v_best_score,0) then
        v_best_score := 0.70; v_best_method := 'phone(コード未解決のため要確認)'; v_best := v_phone_cid;
      end if;
    elsif v_phone_cnt > 1 and 0.70 > coalesce(v_best_score,0) then
      v_best_score := 0.70; v_best_method := 'phone(複数)'; v_best := v_phone_first;
    end if;

    -- 3) 郵便番号一致＋名称類似 / 名称のみ
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

    -- 候補あり → 全列を今回の判定で置き換え。未照合 → すべてクリア（1/3 と同じ）
    if coalesce(v_best_score,0) > 0 then
      update invoice_documents set customer_id = v_best, match_confidence = v_best_score,
        match_method = v_best_method, match_status = '候補あり', match_conflict = false, conflict_detail = null,
        matched_by = null, matched_at = null
      where id = v_doc.id;
      v_cand := v_cand + 1;
    else
      update invoice_documents set customer_id = null, match_confidence = 0,
        match_method = null, match_status = '未照合', match_conflict = false, conflict_detail = null,
        matched_by = null, matched_at = null
      where id = v_doc.id;
      v_none := v_none + 1;
    end if;
  end loop;

  -- 商品名 alias の前埋め（decision='対応づけ' の raw_name は match_method='alias' で確定に）
  update invoice_lines l set product_id = a.product_id, match_confidence = 0.90,
    match_method = 'alias', match_status = '確定'
  from product_name_aliases a
  where a.decision = '対応づけ' and a.product_id is not null
    and a.raw_name = l.raw_item_name
    and coalesce(a.raw_species,'') = coalesce(l.raw_species,'')
    and coalesce(a.raw_grade,'')   = coalesce(l.raw_grade,'')
    and l.match_status = '未照合'
    and (p_import_id is null
         or l.document_id in (select d.id from invoice_documents d where d.import_id = p_import_id));
  get diagnostics v_pmap = row_count;

  -- 取込ステータスを再計算
  if p_import_id is not null then
    perform _invoice_recompute_import_status(p_import_id);
  else
    perform _invoice_recompute_import_status(i.id) from invoice_imports i
     where i.status in ('抽出済','顧客未照合','商品未照合','要確認');
  end if;

  return jsonb_build_object('ok', true, 'auto', v_auto, 'candidates', v_cand,
    'unmatched', v_none, 'conflicts', v_conflict, 'products_prefilled', v_pmap);
end;
$$;
revoke all on function admin_invoice_run_matching(text, uuid) from public;
grant execute on function admin_invoice_run_matching(text, uuid) to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════
--  確認画面用 RPC
-- ═══════════════════════════════════════════════════════════════════

-- ── 詳細取得（1取込ぶんの請求書・明細・照合状況・金額検算） ──────────
create or replace function admin_invoice_detail(p_staff_key text, p_import_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select jsonb_build_object(
    'import', jsonb_build_object(
      'id', i.id, 'file_name', i.file_name, 'source', i.source, 'status', i.status,
      'created_at', i.created_at, 'error_message', i.error_message,
      'confirmed_by', i.confirmed_by, 'confirmed_at', i.confirmed_at,
      'finalized_by', i.finalized_by, 'finalized_at', i.finalized_at,
      'canceled_by', i.canceled_by, 'canceled_at', i.canceled_at, 'cancel_reason', i.cancel_reason),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'page_from', d.page_from, 'page_to', d.page_to,
        'invoice_number', d.invoice_number, 'invoice_date', d.invoice_date, 'delivery_date', d.delivery_date,
        'raw_customer_name', d.raw_customer_name, 'raw_addressee', d.raw_addressee,
        'raw_phone', d.raw_phone, 'raw_postal', d.raw_postal, 'raw_address', d.raw_address,
        'total_amount', d.total_amount, 'note', d.note,
        'match_status', d.match_status, 'match_method', d.match_method, 'match_confidence', d.match_confidence,
        'match_conflict', d.match_conflict, 'conflict_detail', d.conflict_detail,
        'customer_id', d.customer_id,
        'customer', case when d.customer_id is null then null else
          (select jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name) from customers c where c.id = d.customer_id) end,
        'customer_confirmed_by', d.customer_confirmed_by, 'customer_confirmed_at', d.customer_confirmed_at,
        'amount_diff_reason', d.amount_diff_reason, 'amount_diff_kind', d.amount_diff_kind,
        'lines_amount_sum', coalesce((select sum(coalesce(l.amount,0)) from invoice_lines l where l.document_id = d.id),0),
        'amount_diff', case when d.total_amount is null then null else
          d.total_amount - coalesce((select sum(coalesce(l.amount,0)) from invoice_lines l where l.document_id = d.id),0) end,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', l.id, 'line_no', l.line_no, 'raw_item_name', l.raw_item_name,
            'raw_species', l.raw_species, 'raw_part', l.raw_part, 'raw_grade', l.raw_grade,
            'weight_kg', l.weight_kg, 'unit_price', l.unit_price, 'amount', l.amount,
            'source_ref', l.source_ref, 'confidence', l.confidence, 'note', l.note,
            'match_status', l.match_status, 'match_method', l.match_method,
            'product_id', l.product_id,
            'product', case when l.product_id is null then null else
              (select jsonb_build_object('id', p.id, 'species', p.species, 'display_name', p.display_name, 'grade_label', p.grade_label)
                 from portal_products p where p.id = l.product_id) end,
            'product_decided_by', l.product_decided_by, 'product_decided_at', l.product_decided_at,
            'alias', (select jsonb_build_object('decision', a.decision, 'product_id', a.product_id)
                        from product_name_aliases a
                       where a.raw_name = l.raw_item_name
                         and coalesce(a.raw_species,'') = coalesce(l.raw_species,'')
                         and coalesce(a.raw_grade,'')   = coalesce(l.raw_grade,'')
                       limit 1)
          ) order by l.line_no) from invoice_lines l where l.document_id = d.id), '[]'::jsonb)
      ) order by d.page_from, d.invoice_number) from invoice_documents d where d.import_id = i.id), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(jsonb_build_object('action', a.action, 'actor', a.actor,
        'detail', a.detail, 'created_at', a.created_at) order by a.created_at desc)
      from invoice_audit a where a.import_id = i.id), '[]'::jsonb)
  ) into v
  from invoice_imports i where i.id = p_import_id;
  if v is null then raise exception '取込が見つかりません'; end if;
  return v;
end;
$$;
revoke all on function admin_invoice_detail(text, uuid) from public;
grant execute on function admin_invoice_detail(text, uuid) to anon, authenticated;

-- ── 顧客検索（確定画面のピッカー用。最小限の列のみ返す） ──────────────
create or replace function admin_invoice_customer_search(p_staff_key text, p_q text, p_limit int default 20)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; v_q text := btrim(coalesce(p_q,'')); v_qn text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if length(v_q) = 0 then return '[]'::jsonb; end if;
  v_qn := invoice_norm_name(v_q);
  select coalesce(jsonb_agg(x order by x_code), '[]'::jsonb) into v from (
    select jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name,
             'phone_tail', case when c.phone is null then null
                                else right(regexp_replace(c.phone,'\D','','g'),4) end) as x,
           c.code as x_code
      from customers c
     where c.code ilike '%'||v_q||'%'
        or c.name ilike '%'||v_q||'%'
        or c.kana ilike '%'||v_q||'%'
        or (v_qn is not null and invoice_norm_name(c.name) like '%'||v_qn||'%')
        or regexp_replace(coalesce(c.phone,''),'\D','','g') like '%'||regexp_replace(v_q,'\D','','g')||'%'
     order by c.code
     limit greatest(1, least(p_limit, 50))
  ) t;
  return v;
end;
$$;
revoke all on function admin_invoice_customer_search(text, text, int) from public;
grant execute on function admin_invoice_customer_search(text, text, int) to anon, authenticated;

-- ── ポータル商品の一覧（明細の対応づけ用） ──────────────────────────
create or replace function admin_invoice_products(p_staff_key text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'species', p.species,
           'display_name', p.display_name, 'grade_label', p.grade_label) order by p.sort_order, p.species), '[]'::jsonb)
    into v from portal_products p where coalesce(p.is_active, true);
  return v;
end;
$$;
revoke all on function admin_invoice_products(text) from public;
grant execute on function admin_invoice_products(text) to anon, authenticated;

-- ── 顧客の確定 / 対象外 / 未照合クリア ───────────────────────────────
create or replace function admin_invoice_set_customer(p_staff_key text, p_document_id uuid,
  p_decision text, p_customer_id uuid default null, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_imp uuid; v_name text; v_code text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select import_id into v_imp from invoice_documents where id = p_document_id;
  if v_imp is null then raise exception '請求書が見つかりません'; end if;

  if p_decision = '確定' then
    if p_customer_id is null then raise exception '確定する顧客を指定してください'; end if;
    select name, code into v_name, v_code from customers where id = p_customer_id;
    if v_name is null then raise exception '指定の顧客が存在しません'; end if;
    update invoice_documents set customer_id = p_customer_id, match_status = '確定',
      match_method = 'manual', match_confidence = 1.00, match_conflict = false, conflict_detail = null,
      matched_by = coalesce(nullif(p_by,''),'staff'), matched_at = now(),
      customer_confirmed_by = coalesce(nullif(p_by,''),'staff'), customer_confirmed_at = now()
    where id = p_document_id;
    perform _invoice_audit(v_imp, p_document_id, null, 'customer_confirm', p_by,
      '顧客を確定: '||coalesce(v_code,'')||' '||coalesce(v_name,''));
  elsif p_decision = '対象外' then
    update invoice_documents set customer_id = null, match_status = '対象外',
      match_method = 'manual', match_conflict = false, conflict_detail = null,
      matched_by = coalesce(nullif(p_by,''),'staff'), matched_at = now(),
      customer_confirmed_by = coalesce(nullif(p_by,''),'staff'), customer_confirmed_at = now()
    where id = p_document_id;
    perform _invoice_audit(v_imp, p_document_id, null, 'customer_exclude', p_by, '顧客を対象外に指定');
  elsif p_decision = '未照合' then
    update invoice_documents set customer_id = null, match_status = '未照合',
      match_method = null, match_confidence = 0, match_conflict = false, conflict_detail = null,
      matched_by = null, matched_at = null, customer_confirmed_by = null, customer_confirmed_at = null
    where id = p_document_id;
    perform _invoice_audit(v_imp, p_document_id, null, 'customer_clear', p_by, '顧客の確定を取消（未照合へ）');
  else
    raise exception '不正な操作です: %', p_decision;
  end if;

  return jsonb_build_object('ok', true, 'status', _invoice_recompute_import_status(v_imp));
end;
$$;
revoke all on function admin_invoice_set_customer(text, uuid, text, uuid, text) from public;
grant execute on function admin_invoice_set_customer(text, uuid, text, uuid, text) to anon, authenticated;

-- ── 明細の商品対応づけ / 保留 / 対象外 ───────────────────────────────
create or replace function admin_invoice_map_product(p_staff_key text, p_line_id uuid,
  p_decision text, p_product_id uuid default null, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_imp uuid; v_doc uuid; v_raw text; v_sp text; v_gr text; v_pname text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select l.document_id, d.import_id, l.raw_item_name, l.raw_species, l.raw_grade
    into v_doc, v_imp, v_raw, v_sp, v_gr
    from invoice_lines l join invoice_documents d on d.id = l.document_id
   where l.id = p_line_id;
  if v_imp is null then raise exception '明細が見つかりません'; end if;

  if p_decision = '対応づけ' then
    if p_product_id is null then raise exception '対応づける商品を指定してください'; end if;
    select display_name into v_pname from portal_products where id = p_product_id;
    if v_pname is null then raise exception '指定の商品が存在しません'; end if;
    update invoice_lines set product_id = p_product_id, match_status = '確定',
      match_method = 'manual', match_confidence = 1.00,
      product_decided_by = coalesce(nullif(p_by,''),'staff'), product_decided_at = now()
    where id = p_line_id;
    -- 商品名 alias を確定（次回以降の候補として利用）
    insert into product_name_aliases (raw_name, raw_species, raw_grade, product_id, decision, decided_by, decided_at)
    values (v_raw, v_sp, v_gr, p_product_id, '対応づけ', coalesce(nullif(p_by,''),'staff'), now())
    on conflict (raw_name, coalesce(raw_species,''), coalesce(raw_grade,''))
    do update set product_id = excluded.product_id, decision = '対応づけ',
                  decided_by = excluded.decided_by, decided_at = excluded.decided_at;
    perform _invoice_audit(v_imp, v_doc, p_line_id, 'product_map', p_by, '商品を対応づけ: '||coalesce(v_pname,''));
  elsif p_decision = '別商品' then
    update invoice_lines set product_id = null, match_status = '保留', match_method = 'manual'
    where id = p_line_id;
    insert into product_name_aliases (raw_name, raw_species, raw_grade, decision, decided_by, decided_at)
    values (v_raw, v_sp, v_gr, '別商品', coalesce(nullif(p_by,''),'staff'), now())
    on conflict (raw_name, coalesce(raw_species,''), coalesce(raw_grade,''))
    do update set decision = '別商品', decided_by = excluded.decided_by, decided_at = excluded.decided_at;
    perform _invoice_audit(v_imp, v_doc, p_line_id, 'product_hold', p_by, '別商品として保留');
  elsif p_decision = '対象外' then
    update invoice_lines set product_id = null, match_status = '対象外', match_method = 'manual',
      product_decided_by = coalesce(nullif(p_by,''),'staff'), product_decided_at = now()
    where id = p_line_id;
    insert into product_name_aliases (raw_name, raw_species, raw_grade, decision, decided_by, decided_at)
    values (v_raw, v_sp, v_gr, '対象外', coalesce(nullif(p_by,''),'staff'), now())
    on conflict (raw_name, coalesce(raw_species,''), coalesce(raw_grade,''))
    do update set decision = '対象外', decided_by = excluded.decided_by, decided_at = excluded.decided_at;
    perform _invoice_audit(v_imp, v_doc, p_line_id, 'product_exclude', p_by, '注文サイト対象外に指定');
  elsif p_decision = '未照合' then
    update invoice_lines set product_id = null, match_status = '未照合', match_method = null,
      product_decided_by = null, product_decided_at = null
    where id = p_line_id;
    perform _invoice_audit(v_imp, v_doc, p_line_id, 'product_clear', p_by, '商品の対応づけを取消');
  else
    raise exception '不正な操作です: %', p_decision;
  end if;

  return jsonb_build_object('ok', true, 'status', _invoice_recompute_import_status(v_imp));
end;
$$;
revoke all on function admin_invoice_map_product(text, uuid, text, uuid, text) from public;
grant execute on function admin_invoice_map_product(text, uuid, text, uuid, text) to anon, authenticated;

-- ── 金額差異の理由入力 ───────────────────────────────────────────────
create or replace function admin_invoice_set_amount_reason(p_staff_key text, p_document_id uuid,
  p_reason text, p_kind text default null, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_imp uuid;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select import_id into v_imp from invoice_documents where id = p_document_id;
  if v_imp is null then raise exception '請求書が見つかりません'; end if;
  update invoice_documents set amount_diff_reason = nullif(btrim(coalesce(p_reason,'')),''),
    amount_diff_kind = nullif(btrim(coalesce(p_kind,'')),'')
  where id = p_document_id;
  perform _invoice_audit(v_imp, p_document_id, null, 'amount_reason', p_by,
    '金額差異の理由: '||coalesce(nullif(p_kind,''),'')||' '||coalesce(left(p_reason,80),''));
  return jsonb_build_object('ok', true, 'status', _invoice_recompute_import_status(v_imp));
end;
$$;
revoke all on function admin_invoice_set_amount_reason(text, uuid, text, text, text) from public;
grant execute on function admin_invoice_set_amount_reason(text, uuid, text, text, text) to anon, authenticated;

-- ── 実績反映（最終確認＋反映を単一トランザクションで。連打・再送しても増えない） ──
create or replace function admin_invoice_finalize(p_staff_key text, p_import_id uuid, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_status text; v_doc record; v_line record; v_facts int := 0; v_docs int := 0;
        v_on date; v_diff numeric; v_sum numeric;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;

  -- 取込行をロック（同時確定・連打を直列化）
  select status into v_status from invoice_imports where id = p_import_id for update;
  if v_status is null then raise exception '取込が見つかりません'; end if;
  if v_status = '除外' then raise exception 'この取込は除外されています'; end if;
  if v_status = '取込済' then
    return jsonb_build_object('ok', true, 'already', true, 'facts', 0);
  end if;

  -- 反映の前提チェック（すべて満たさなければ例外＝1件も反映しない）
  for v_doc in select * from invoice_documents where import_id = p_import_id loop
    if v_doc.match_status not in ('確定','対象外') then
      raise exception '顧客が未確定の請求書があります（伝票 %）', coalesce(v_doc.invoice_number,'?');
    end if;
    if v_doc.match_status = '対象外' then continue; end if;
    if v_doc.customer_id is null then
      raise exception '確定済みなのに顧客が空です（伝票 %）', coalesce(v_doc.invoice_number,'?');
    end if;

    -- 明細の対応づけ
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

    -- 金額検算: 明細合計 vs 請求書合計。差額があれば理由必須
    if v_doc.total_amount is not null then
      select coalesce(sum(coalesce(amount,0)),0) into v_sum from invoice_lines where document_id = v_doc.id;
      v_diff := v_doc.total_amount - v_sum;
      if abs(v_diff) > 0.009 and coalesce(btrim(v_doc.amount_diff_reason),'') = '' then
        raise exception '金額差異（%円）の理由が未入力です（伝票 %）', v_diff, coalesce(v_doc.invoice_number,'?');
      end if;
    end if;

    -- 反映日（納品日 → 請求日の順）
    v_on := coalesce(v_doc.delivery_date, v_doc.invoice_date);
    if v_on is null then
      raise exception '請求日または納品日が必要です（伝票 %）', coalesce(v_doc.invoice_number,'?');
    end if;

    -- 実績へ反映（source_id=明細id で一意。再送しても増えない。取消済みは復活）
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
    confirmed_by = coalesce(nullif(p_by,''),'staff'), confirmed_at = now(),
    finalized_by = coalesce(nullif(p_by,''),'staff'), finalized_at = now(),
    canceled_by = null, canceled_at = null, cancel_reason = null, updated_at = now()
  where id = p_import_id;
  perform _invoice_audit(p_import_id, null, null, 'finalize', p_by,
    '実績反映: 請求書'||v_docs||'枚・明細'||v_facts||'行');

  return jsonb_build_object('ok', true, 'already', false, 'facts', v_facts, 'documents', v_docs);
end;
$$;
revoke all on function admin_invoice_finalize(text, uuid, text) from public;
grant execute on function admin_invoice_finalize(text, uuid, text) to anon, authenticated;

-- ── 取消（物理削除しない。二重取消は拒否。再反映は可能） ─────────────
create or replace function admin_invoice_cancel(p_staff_key text, p_import_id uuid, p_reason text, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_status text; v_facts int := 0;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if coalesce(btrim(p_reason),'') = '' then raise exception '取消理由を入力してください'; end if;

  select status into v_status from invoice_imports where id = p_import_id for update;
  if v_status is null then raise exception '取込が見つかりません'; end if;
  if v_status <> '取込済' then raise exception '反映済み（取込済）の取込のみ取消できます'; end if;

  update customer_purchase_facts f set canceled_at = now(),
    canceled_by = coalesce(nullif(p_by,''),'staff'), cancel_reason = p_reason
  where f.source_kind = 'invoice' and f.canceled_at is null
    and f.source_id in (select l.id from invoice_lines l
                        join invoice_documents d on d.id = l.document_id
                        where d.import_id = p_import_id);
  get diagnostics v_facts = row_count;

  update invoice_imports set status = '確認済',
    canceled_by = coalesce(nullif(p_by,''),'staff'), canceled_at = now(), cancel_reason = p_reason,
    finalized_by = null, finalized_at = null, updated_at = now()
  where id = p_import_id;
  perform _invoice_audit(p_import_id, null, null, 'cancel', p_by,
    '実績取消: '||v_facts||'行 / 理由: '||left(p_reason,80));

  return jsonb_build_object('ok', true, 'canceled_facts', v_facts, 'status', '確認済');
end;
$$;
revoke all on function admin_invoice_cancel(text, uuid, text, text) from public;
grant execute on function admin_invoice_cancel(text, uuid, text, text) to anon, authenticated;

-- ── 取込全体の除外 / 除外解除 ────────────────────────────────────────
create or replace function admin_invoice_exclude_import(p_staff_key text, p_import_id uuid, p_exclude boolean, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select status into v_status from invoice_imports where id = p_import_id for update;
  if v_status is null then raise exception '取込が見つかりません'; end if;
  if p_exclude then
    if v_status = '取込済' then raise exception '反映済みの取込は先に取消してください'; end if;
    update invoice_imports set status = '除外', updated_at = now() where id = p_import_id;
    perform _invoice_audit(p_import_id, null, null, 'exclude', p_by, '取込を除外');
    return jsonb_build_object('ok', true, 'status', '除外');
  else
    update invoice_imports set status = '抽出済', updated_at = now() where id = p_import_id;
    perform _invoice_audit(p_import_id, null, null, 'unexclude', p_by, '除外を解除');
    return jsonb_build_object('ok', true, 'status', _invoice_recompute_import_status(p_import_id));
  end if;
end;
$$;
revoke all on function admin_invoice_exclude_import(text, uuid, boolean, text) from public;
grant execute on function admin_invoice_exclude_import(text, uuid, boolean, text) to anon, authenticated;

notify pgrst, 'reload schema';
