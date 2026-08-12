-- フェーズ4: 請求書取込のステージング一式（計画書 §5-1〜5-2）2026-08-11
--
-- 方針:
--  * OCR・表抽出の結果は customer_purchase_facts に直接入れない。
--    必ず invoice_lines を経由し、人が「確認済」にしたものだけ「取込済」に進める
--  * 冪等: ファイル=content_hash一意 / 請求書=(import_id,page_from,invoice_number)一意 /
--    実績=(source_kind,source_id)一意 → 再取込しても二重計上しない
--  * ステージングは anon 直接アクセス不可。読み書きはスタッフキー必須の admin_invoice_* のみ
--  * 名寄せは候補提示のみ（自動確定は code一致=1.00 と 電話一意一致=0.95 だけ）
--
-- ロールバック: migrations/rollback/20260811_invoice_staging_rollback.sql

-- ── テーブル ──────────────────────────────────────────────────────
create table if not exists invoice_imports (
  id             uuid primary key default gen_random_uuid(),
  source         text not null default 'local',   -- 'drive' | 'local'
  source_file_id text,
  file_name      text not null,
  mime_type      text,
  content_hash   text not null,
  page_count     int,
  status         text not null default '未処理',
    -- 未処理 / 抽出済 / 顧客未照合 / 商品未照合 / 要確認 / 確認済 / 取込済 / 除外
  error_message  text,
  imported_by    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (content_hash)
);
create unique index if not exists invoice_imports_source_file_uq
  on invoice_imports (source, source_file_id) where source_file_id is not null;

create table if not exists invoice_documents (
  id               uuid primary key default gen_random_uuid(),
  import_id        uuid not null references invoice_imports(id) on delete cascade,
  page_from        int, page_to int,
  invoice_number   text,
  invoice_date     date,
  delivery_date    date,
  raw_customer_name text,
  raw_addressee    text,
  raw_address      text,
  raw_postal       text,
  raw_phone        text,
  total_amount     numeric,
  note             text,
  customer_id      uuid references customers(id),
  match_confidence numeric,
  match_method     text,       -- code / phone / postal+name / name / manual
  match_status     text not null default '未照合',  -- 未照合 / 候補あり / 確定 / 対象外
  matched_by       text, matched_at timestamptz,
  created_at       timestamptz not null default now()
);
create unique index if not exists invoice_documents_page_uq
  on invoice_documents (import_id, coalesce(page_from, 0), coalesce(invoice_number, ''));

create table if not exists invoice_lines (
  id               uuid primary key default gen_random_uuid(),
  document_id      uuid not null references invoice_documents(id) on delete cascade,
  line_no          int not null,
  raw_item_name    text not null,
  raw_species      text, raw_part text, raw_grade text,
  weight_kg        numeric, unit_price numeric, amount numeric,
  note             text,
  source_ref       text,
  confidence       numeric,
  product_id       uuid references portal_products(id),
  match_confidence numeric, match_method text,
  match_status     text not null default '未照合',
  created_at       timestamptz not null default now(),
  unique (document_id, line_no)
);

create table if not exists customer_purchase_facts (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id),
  product_id   uuid not null references portal_products(id),
  purchased_on date not null,
  weight_kg    numeric not null,
  unit_price   numeric,
  amount       numeric,
  source_kind  text not null,   -- 'invoice' | 'order'
  source_id    uuid not null,
  created_at   timestamptz not null default now(),
  unique (source_kind, source_id)
);

create table if not exists product_name_aliases (
  id          uuid primary key default gen_random_uuid(),
  raw_name    text not null,
  raw_species text, raw_grade text,
  product_id  uuid references portal_products(id),
  decision    text not null default '未判定',  -- 未判定 / 対応づけ / 別商品 / 対象外
  decided_by  text, decided_at timestamptz,
  note        text
);
create unique index if not exists product_name_aliases_uq
  on product_name_aliases (raw_name, coalesce(raw_species,''), coalesce(raw_grade,''));

alter table invoice_imports          enable row level security;
alter table invoice_documents        enable row level security;
alter table invoice_lines            enable row level security;
alter table customer_purchase_facts  enable row level security;
alter table product_name_aliases     enable row level security;
revoke all on invoice_imports, invoice_documents, invoice_lines,
              customer_purchase_facts, product_name_aliases from anon, authenticated;

-- ── 名寄せ用の正規化関数（内部専用） ─────────────────────────────
create or replace function invoice_norm_phone(p text)
returns text language sql immutable as $$
  select case when p is null then null
    else regexp_replace(regexp_replace(p, '^\+81', '0'), '\D', '', 'g') end
$$;
revoke all on function invoice_norm_phone(text) from public, anon, authenticated;

create or replace function invoice_norm_name(p text)
returns text language sql immutable as $$
  select case when p is null then null else
    replace(replace(replace(replace(replace(replace(replace(
      translate(lower(p),
        'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ０１２３４５６７８９　 ',
        'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz0123456789'),
      '株式会社',''), '(株)',''), '㈱',''),
      '有限会社',''), '(有)',''),
      '合同会社',''), '(同)','')
  end
$$;
revoke all on function invoice_norm_name(text) from public, anon, authenticated;

-- 顧客コードの正規化（大文字化・全角→半角・ハイフン類の統一・前後空白除去。内部専用）
-- ハイフン類は次の6種をASCIIの「-」へ正規化する:
--   － U+FF0D 全角ハイフンマイナス / ‐ U+2010 ハイフン / ‑ U+2011 改行しないハイフン /
--   – U+2013 enダッシュ / — U+2014 emダッシュ / − U+2212 マイナス記号
create or replace function invoice_norm_code(p text)
returns text language sql immutable as $$
  select case when p is null then null else
    upper(btrim(translate(p,
      'ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ０１２３４５６７８９－‐‑–—−　',
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789------ ')))
  end
$$;
revoke all on function invoice_norm_code(text) from public, anon, authenticated;

-- 文字bigramのJaccard類似度（内部専用）
create or replace function invoice_name_similarity(a text, b text)
returns numeric language plpgsql immutable as $$
declare sa text[]; sb text[]; i int; inter int := 0; uni int; na text := invoice_norm_name(a); nb text := invoice_norm_name(b);
begin
  if na is null or nb is null or length(na) < 2 or length(nb) < 2 then
    return case when na is not null and na = nb then 1 else 0 end;
  end if;
  sa := array(select distinct substr(na, g, 2) from generate_series(1, length(na)-1) g);
  sb := array(select distinct substr(nb, g, 2) from generate_series(1, length(nb)-1) g);
  for i in 1..coalesce(array_length(sa,1),0) loop
    if sa[i] = any(sb) then inter := inter + 1; end if;
  end loop;
  uni := coalesce(array_length(sa,1),0) + coalesce(array_length(sb,1),0) - inter;
  if uni = 0 then return 0; end if;
  return round(inter::numeric / uni, 2);
end;
$$;
revoke all on function invoice_name_similarity(text, text) from public, anon, authenticated;

-- ── RPC: ステージングへの投入（取込スクリプトが使う・冪等） ───────
create or replace function admin_invoice_stage_import(p_staff_key text, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_import_id uuid; v_existing uuid; v_doc jsonb; v_line jsonb; v_doc_id uuid;
        v_docs int := 0; v_lines int := 0; v_no int;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if coalesce(p->>'content_hash','') = '' or coalesce(p->>'file_name','') = '' then
    raise exception 'content_hash と file_name は必須です';
  end if;

  -- 同時投入でも1件だけ作られるよう、SELECT→INSERT ではなく INSERT ... ON CONFLICT DO NOTHING を使う（原子的）。
  -- ・content_hash 競合（同じ内容のファイル）→ DO NOTHING で INSERT されず、既存行の id を skipped=true で返す
  -- ・(source, source_file_id) の一意インデックス競合（同じ取込元ファイルIDで内容だけ変わった）→
  --   下の例外分岐で明示的に skipped=true として返す（自動では上書きしない。人が既存の取込を除外してから取り直す）
  begin
    insert into invoice_imports (source, source_file_id, file_name, mime_type, content_hash,
                                 page_count, status, imported_by)
    values (coalesce(nullif(p->>'source',''),'local'), nullif(p->>'source_file_id',''),
            p->>'file_name', nullif(p->>'mime_type',''), p->>'content_hash',
            nullif(p->>'page_count','')::int, '抽出済', nullif(p->>'imported_by',''))
    on conflict (content_hash) do nothing
    returning id into v_import_id;
  exception when unique_violation then
    -- content_hash は ON CONFLICT で処理されるため、ここへ来るのは (source, source_file_id) 側の競合のみ
    select id into v_existing from invoice_imports
     where source = coalesce(nullif(p->>'source',''),'local')
       and source_file_id = nullif(p->>'source_file_id','');
    return jsonb_build_object('ok', true, 'import_id', v_existing, 'skipped', true,
      'reason', '同じ取込元ファイルIDが登録済み（内容が変更されています。取り直す場合は既存の取込を除外してください）');
  end;

  if v_import_id is null then
    -- content_hash が既存（同時投入で先を越された場合もここに入る）。エラーにせず skipped=true で正常終了
    select id into v_existing from invoice_imports where content_hash = p->>'content_hash';
    return jsonb_build_object('ok', true, 'import_id', v_existing, 'skipped', true,
      'reason', '同じ内容のファイルが取込済み');
  end if;

  -- ここから下は「今回 INSERT できた場合」だけ実行される（documents / lines の登録）

  for v_doc in select * from jsonb_array_elements(coalesce(p->'documents','[]'::jsonb)) loop
    insert into invoice_documents (import_id, page_from, page_to, invoice_number, invoice_date,
      delivery_date, raw_customer_name, raw_addressee, raw_address, raw_postal, raw_phone,
      total_amount, note)
    values (v_import_id,
      nullif(v_doc->>'page_from','')::int, nullif(v_doc->>'page_to','')::int,
      nullif(v_doc->>'invoice_number',''), nullif(v_doc->>'invoice_date','')::date,
      nullif(v_doc->>'delivery_date','')::date, nullif(v_doc->>'raw_customer_name',''),
      nullif(v_doc->>'raw_addressee',''), nullif(v_doc->>'raw_address',''),
      nullif(v_doc->>'raw_postal',''), nullif(v_doc->>'raw_phone',''),
      nullif(v_doc->>'total_amount','')::numeric, nullif(v_doc->>'note',''))
    returning id into v_doc_id;
    v_docs := v_docs + 1;
    v_no := 0;
    for v_line in select * from jsonb_array_elements(coalesce(v_doc->'lines','[]'::jsonb)) loop
      v_no := v_no + 1;
      insert into invoice_lines (document_id, line_no, raw_item_name, raw_species, raw_part,
        raw_grade, weight_kg, unit_price, amount, note, source_ref, confidence)
      values (v_doc_id, coalesce(nullif(v_line->>'line_no','')::int, v_no),
        coalesce(nullif(v_line->>'raw_item_name',''), '（品名不明）'),
        nullif(v_line->>'raw_species',''), nullif(v_line->>'raw_part',''),
        nullif(v_line->>'raw_grade',''), nullif(v_line->>'weight_kg','')::numeric,
        nullif(v_line->>'unit_price','')::numeric, nullif(v_line->>'amount','')::numeric,
        nullif(v_line->>'note',''), nullif(v_line->>'source_ref',''),
        nullif(v_line->>'confidence','')::numeric);
      v_lines := v_lines + 1;
      -- 商品名の対応表に「未判定」で登録（既にあれば何もしない）
      insert into product_name_aliases (raw_name, raw_species, raw_grade)
      values (coalesce(nullif(v_line->>'raw_item_name',''), '（品名不明）'),
              nullif(v_line->>'raw_species',''), nullif(v_line->>'raw_grade',''))
      on conflict (raw_name, coalesce(raw_species,''), coalesce(raw_grade,'')) do nothing;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'import_id', v_import_id, 'skipped', false,
    'documents', v_docs, 'lines', v_lines);
end;
$$;
revoke all on function admin_invoice_stage_import(text, jsonb) from public;
grant execute on function admin_invoice_stage_import(text, jsonb) to anon, authenticated;

-- ── RPC: 顧客の名寄せ実行（候補提示。自動確定は code=1.00 / 電話一意=0.95 のみ） ──
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

    -- 1) 顧客コード: 完全一致のみ。
    --    「抽出されたコードが1種類」かつ「そのコードを持つ顧客が1件」のときだけ自動確定(1.00)。
    --    複数コード印字・同一コードの顧客が複数・埋め込み（C0011の中のC001等）は自動確定しない。
    --    * 照合に使うコードは正規化後 [A-Z0-9-] のみ・4文字以上（それ以外の文字を含むコードは
    --      正規表現に入れず、1.00の自動照合にも使わない）
    --    * 英字を1文字以上含むコード: 英数字・ハイフン境界付きの完全一致
    --    * 数字だけのコード: 「顧客コード」「顧客番号」「お客様番号」「得意先コード」等の
    --      ラベル直後に印字されている場合だけ一致（年度・金額・電話番号などの無関係な数字に
    --      同じ値があっても一致させない）
    declare
      v_hay text := invoice_norm_code(
        coalesce(v_doc.raw_customer_name,'') || ' ' ||
        coalesce(v_doc.raw_addressee,'')    || ' ' ||
        coalesce(v_doc.note,''));
      v_codes text[]; v_ids uuid[];
    begin
      select array_agg(distinct u.code_n), array_agg(distinct u.cid)
        into v_codes, v_ids
        from (
          select invoice_norm_code(c.code) as code_n, c.id as cid
            from customers c
           where c.code is not null
             and length(invoice_norm_code(c.code)) >= 4
             and invoice_norm_code(c.code) ~ '^[A-Z0-9][A-Z0-9-]*$'
             and (
               -- 英字を含むコード: 境界付き完全一致（前後が英数字・ハイフンでない）
               (invoice_norm_code(c.code) ~ '[A-Z]'
                 and v_hay ~ ('(^|[^A-Z0-9-])' || invoice_norm_code(c.code) || '($|[^A-Z0-9-])'))
               or
               -- 数字だけのコード: 明示的なラベルの直後のみ（ラベルなしの数字は一致させない）
               (invoice_norm_code(c.code) ~ '^[0-9]+$'
                 and v_hay ~ ('(顧客|お客様|得意先|客先)\s*(コード|番号|NO\.?|ID)[\s：:＃#]*'
                              || invoice_norm_code(c.code) || '($|[^A-Z0-9-])'))
             )
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
    end;

    -- 2) 電話の完全一致（候補が1件のときだけ自動確定 0.95）
    if invoice_norm_phone(v_doc.raw_phone) is not null and length(invoice_norm_phone(v_doc.raw_phone)) >= 10 then
      select count(*), (array_agg(c.id))[1] into v_cnt, v_cid from customers c
       where invoice_norm_phone(c.phone) = invoice_norm_phone(v_doc.raw_phone);
      if v_cnt = 1 then
        update invoice_documents set customer_id = v_cid, match_confidence = 0.95,
          match_method = 'phone', match_status = '確定', matched_by = 'auto', matched_at = now()
        where id = v_doc.id;
        v_auto := v_auto + 1; continue;
      elsif v_cnt > 1 and 0.70 > coalesce(v_best_score, 0) then
        v_best_score := 0.70; v_best_method := 'phone(複数)'; v_best := v_cid;
      end if;
    end if;

    -- 3) 郵便番号（住所欄の〒から抽出）一致＋名称類似 / 名称のみ。
    --    電話複数の候補(0.70)より高いスコアのときだけ置き換える
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
        match_method = v_best_method, match_status = '候補あり'
      where id = v_doc.id;
      v_cand := v_cand + 1;
    else
      update invoice_documents set match_status = '未照合', match_confidence = 0 where id = v_doc.id;
      v_none := v_none + 1;
    end if;
  end loop;

  -- 取込単位のステータス更新
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

-- ── RPC: 一覧（確認画面用） ──────────────────────────────────────
create or replace function admin_invoice_list(p_staff_key text, p_status text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'file_name', i.file_name, 'source', i.source, 'status', i.status,
      'created_at', i.created_at, 'error_message', i.error_message,
      'documents', (select count(*) from invoice_documents d where d.import_id = i.id),
      'lines', (select count(*) from invoice_lines l join invoice_documents d on d.id = l.document_id
                 where d.import_id = i.id),
      'unmatched_customers', (select count(*) from invoice_documents d
                               where d.import_id = i.id and d.match_status in ('未照合','候補あり')),
      'unmatched_products', (select count(*) from invoice_lines l
                              join invoice_documents d on d.id = l.document_id
                              where d.import_id = i.id and l.match_status <> '確定')
    ) order by i.created_at desc)
    from invoice_imports i
    where p_status is null or i.status = p_status), '[]'::jsonb);
end;
$$;
revoke all on function admin_invoice_list(text, text) from public;
grant execute on function admin_invoice_list(text, text) to anon, authenticated;
