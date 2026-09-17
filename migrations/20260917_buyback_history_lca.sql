-- 買取金額通知・過年度データ・LCA（追加のみ）2026-09-17
--
--   1) hunters … 振込口座の補助列（口座名義フリガナ・支払No）。銀行名/支店/種類/口座番号は既存列を使う
--   2) individuals_history … 過年度（令和3〜7年度）の台帳「生データ」「イノシシ以外データ」を取り込む先
--      sales_history … 過年度の「出荷・販売台帳」
--      Google スプレッドシートは DB から直接 CSV で読める（extensions.http_get）ので、
--      tgc_import_ledger / tgc_import_sales を呼べばいつでも再取込できる（label_id で upsert）
--   3) buyback_runs … 半期ごとの買取金額の計算結果（通知・振込一覧の元）。確定したものを残す
--   4) app_settings buyback_rules … 買取価格の算出ルール（画面から変更できる。ハードコードしない）
--   5) lca_inputs / app_settings lca_coefficients … 猪肉のLCA（環境負荷）の年度別入力と係数（IDEA 3.2.0）
--   6) area_master.road_km_roundtrip … 地区ごとの「センターまでの往復走行距離」（LCA データ収集フォームの実績値）

alter table hunters add column if not exists account_furigana text;   -- 口座名義（半角カナ）
alter table hunters add column if not exists payee_no integer;         -- 振込一覧の No
alter table area_master add column if not exists road_km_roundtrip numeric;  -- 往復走行 km（実績）
alter table area_master add column if not exists road_km_source text;

-- ── 過年度の個体 ──
create table if not exists individuals_history (
  label_id       text primary key,
  fiscal_year    integer not null,          -- 令和の年（3〜7）
  half           text,                      -- 上半期 / 下半期
  species        text not null default 'イノシシ',
  serial_no      text,
  capture_date   date,
  capture_time   text,
  capture_method text,
  place          text,                      -- 台帳の「捕獲場所」（市名込み）
  city           text,
  area           text,
  hunter_name    text,
  kill_method    text,
  bleed_time     text,
  bleed_place    text,
  sex            text,
  weight         numeric,
  receive_time   text,
  process_at     text,
  recorder       text,
  pickup         text,                      -- 止めさし・引取 の記載
  payee          text,                      -- 買取料金支払い（捕獲者と異なる場合）
  weight_int     numeric,                   -- 価格計算用の体重（切り捨て）
  meat_rank      text,
  yield_rank     text,                      -- A/B/C/D
  price_base     numeric,
  price          numeric,
  image_url      text,
  status         text,
  source         text,
  raw            jsonb,
  imported_at    timestamptz not null default now()
);
create index if not exists individuals_history_fy_idx on individuals_history (fiscal_year, species, capture_date);
alter table individuals_history enable row level security;
do $$ begin
  if not exists (select 1 from pg_policy where polname='allow_all' and polrelid='individuals_history'::regclass) then
    create policy allow_all on individuals_history for all using (true) with check (true);
  end if; end $$;
grant select, insert, update, delete on individuals_history to anon, authenticated;

create table if not exists sales_history (
  id           bigserial primary key,
  fiscal_year  integer,
  half         text,
  label_id     text,
  part         text,
  form         text,
  qty_g        numeric,
  customer     text,
  sold_on      date,
  sold_on_text text,
  expiry_text  text,
  price        numeric,
  in_stock     text,
  shelf        text,
  note         text,
  organ        text,
  src_no       text,
  src_key      text unique,                 -- 取込元の年度+No（再取込で重複しない）
  imported_at  timestamptz not null default now()
);
create index if not exists sales_history_fy_idx on sales_history (fiscal_year, label_id);
alter table sales_history enable row level security;
do $$ begin
  if not exists (select 1 from pg_policy where polname='allow_all' and polrelid='sales_history'::regclass) then
    create policy allow_all on sales_history for all using (true) with check (true);
  end if; end $$;
grant select, insert, update, delete on sales_history to anon, authenticated;

-- ── 買取の計算結果（半期ごと） ──
create table if not exists buyback_runs (
  id           uuid primary key default gen_random_uuid(),
  period_key   text not null,               -- 例: R8H1
  fiscal_year  integer not null,
  half         text not null,
  from_date    date not null,
  to_date      date not null,
  status       text not null default '下書き',   -- 下書き / 確定
  created_by   text,
  note         text,
  data         jsonb not null,              -- 捕獲者ごとの明細・合計・振込先（計算時点のスナップショット）
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists buyback_runs_period_idx on buyback_runs (period_key, created_at desc);
alter table buyback_runs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policy where polname='allow_all' and polrelid='buyback_runs'::regclass) then
    create policy allow_all on buyback_runs for all using (true) with check (true);
  end if; end $$;
grant select, insert, update, delete on buyback_runs to anon, authenticated;

-- ── LCA の年度別入力 ──
create table if not exists lca_inputs (
  fiscal_year  integer primary key,         -- 令和の年
  data         jsonb not null,              -- 入力フォームの項目（受入頭数・肉生産量・電力・水・残渣・走行距離…）
  note         text,
  updated_at   timestamptz not null default now()
);
alter table lca_inputs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policy where polname='allow_all' and polrelid='lca_inputs'::regclass) then
    create policy allow_all on lca_inputs for all using (true) with check (true);
  end if; end $$;
grant select, insert, update, delete on lca_inputs to anon, authenticated;

-- ── 買取価格の算出ルール（告知 別紙3 の表をそのまま設定に） ──
insert into app_settings (key, value) values ('buyback_rules', '{
  "boar": {
    "female_rank_unit": {"並": 100, "上": 200, "極上": 300},
    "male_unit": 100,
    "rank_labels": {"並": "脂の厚み2cm未満", "上": "脂の厚み2cm以上3cm未満", "極上": "脂の厚み3cm以上"},
    "yield_ranks": [
      {"rank": "A", "min_pct": 30, "ratio": 1.0, "label": "3割以上"},
      {"rank": "B", "min_pct": 20, "ratio": 0.5, "label": "2割以上〜3割未満"},
      {"rank": "C", "min_pct": 10, "ratio": 0.3, "label": "1割以上〜2割未満"},
      {"rank": "D", "min_pct": 0,  "ratio": 0.0, "label": "1割未満（買取不可）"}
    ],
    "weight_floor": true,
    "min_weight_kg": 20
  },
  "deer": {"unit": 100, "use_yield": true},
  "small": {"price": 1000, "species": ["キョン", "アライグマ", "ハクビシン", "タヌキ", "ノウサギ"]},
  "pickup_fee": 3000,
  "pickup_note": "現場引取は1回3,000円（止めさし込み）。個体ごとに買取代金から天引き。差額の請求はしない（最終的に0円へ調整）",
  "source": "令和7年12月 TGC告知 別紙3「捕獲個体の買取価格について」",
  "updated_at": "2026-09-17"
}'::jsonb) on conflict (key) do nothing;

-- ── LCA 係数（猪肉のLCA_20241010.xlsx のインベントリデータ。出典 IDEA 3.2.0） ──
insert into app_settings (key, value) values ('lca_coefficients', '{
  "source": "猪肉のLCA_20241010.xlsx（IDEA 3.2.0）",
  "unit": "kg-CO2e/kg（肉1kgあたり）",
  "items": [
    {"key": "electricity", "name": "電力（日本平均 2018年度）", "value": 0.549, "unit": "kg-CO2e/kWh"},
    {"key": "water", "name": "上水道", "value": 0.336, "unit": "kg-CO2e/m3"},
    {"key": "sewage", "name": "下水道処理", "value": 0.517, "unit": "kg-CO2e/m3"},
    {"key": "residue", "name": "産廃処理（動植物性残渣）", "value": 0.218, "unit": "kg-CO2e/kg"},
    {"key": "truck10t", "name": "トラック輸送 10トン車 積載率平均", "value": 0.162, "unit": "kg-CO2e/tkm"},
    {"key": "keitora", "name": "トラック輸送 軽トラック 積載率平均", "value": 2.43, "unit": "kg-CO2e/tkm"},
    {"key": "gasoline", "name": "ガソリン燃焼", "value": 2.32, "unit": "kg-CO2e/L"},
    {"key": "stainless", "name": "ステンレス鋼（くくり罠）", "value": 4.84, "unit": "kg-CO2e/kg"},
    {"key": "steel", "name": "その他の鉄鋼品（箱罠）", "value": 0.00665, "unit": "kg-CO2e/kg"},
    {"key": "cardboard", "name": "段ボール", "value": 0.622, "unit": "kg-CO2e/m2"},
    {"key": "eps", "name": "発泡ポリスチレン（EPS）", "value": 3.72, "unit": "kg-CO2e/kg"},
    {"key": "metal_waste", "name": "産廃処理 金属くず", "value": 0.0429, "unit": "kg-CO2e/kg"},
    {"key": "cooking", "name": "調理・飲食（都市ガス・水・塩こしょう・食品ロス）", "value": 0.93, "unit": "kg-CO2e/kg", "note": "牛・豚・鶏・ジビエ共通の固定分（調理0.91＋飲食0.02）"}
  ],
  "reference": {
    "unit": "kg-CO2e/kg",
    "items": [
      {"name": "牛肉", "total": 19.70, "material": 18.70, "processing": 0.00, "cooking": 0.91, "eating": 0.02},
      {"name": "豚肉", "total": 5.31, "material": 4.39, "processing": 0.00, "cooking": 0.91, "eating": 0.02},
      {"name": "鶏肉", "total": 3.05, "material": 2.13, "processing": 0.00, "cooking": 0.91, "eating": 0.02},
      {"name": "ジビエ肉（館山・R5実績）", "total": 4.30, "material": 1.33, "processing": 2.05, "cooking": 0.91, "eating": 0.02},
      {"name": "ジビエ肉（罠除外）", "total": 3.01, "material": 0.04, "processing": 2.05, "cooking": 0.91, "eating": 0.02},
      {"name": "ジビエ肉（罠除外・再エネ）", "total": 1.59, "material": 0.04, "processing": 0.63, "cooking": 0.91, "eating": 0.02}
    ],
    "source": "猪肉のLCA_20241010.xlsx 試算結果"
  }
}'::jsonb) on conflict (key) do nothing;

-- 令和5年度（2023/4〜2024/3）の入力実績（【入力フォーム】猪肉のLCA_データ収集_20240913.xlsx より）
insert into lca_inputs (fiscal_year, data, note) values (5, '{
  "heads": 603, "heads_boar": 518, "meat_kg": 7802,
  "box_traps": 1, "rice_bran_kg": 10,
  "residue_kg": 12242, "residue_site": "杉田建材(株) 市原サーマルセンター（千葉県市原市万田野481-2）", "residue_km_roundtrip": 74.6,
  "electricity_kwh": 19546.4, "water_m3": 145.3,
  "trap_set_km": 25, "trap_set_times": 6, "patrol_km": 25, "patrol_times": 48,
  "haul_km_total": 7803, "fuel_km_per_l": 14, "gasoline_l": 557,
  "snare_stainless_kg_per_kg": 0.2667, "snare_life_times": 3,
  "packing_cardboard_m2_per_kg": 0.26, "packing_eps_kg_per_kg": 0.11, "distribution_tkm_per_kg": 0.31929
}'::jsonb, '入力フォームの値をそのまま転記（2024-09-13 時点）') on conflict (fiscal_year) do nothing;

-- ── CSV（Google スプレッドシートの gviz 出力）を行に分ける。引用符・カンマ・改行入りのセルに対応 ──
-- 文字を配列にしてから走査する（多バイト文字の substr は位置ごとに先頭から数え直すため、長文だと二乗時間になる）
create or replace function tgc_csv_rows(p text) returns setof text[]
language plpgsql immutable as $$
declare chars text[]; i int := 1; n int; c text; field text := ''; r text[] := '{}'; inq boolean := false;
begin
  if p is null then return; end if;
  chars := regexp_split_to_array(p, '');
  n := coalesce(array_length(chars, 1), 0);
  while i <= n loop
    c := chars[i];
    if inq then
      if c = '"' then
        if i < n and chars[i + 1] = '"' then field := field || '"'; i := i + 1;
        else inq := false; end if;
      else field := field || c; end if;
    else
      if c = '"' then inq := true;
      elsif c = ',' then r := r || field; field := '';
      elsif c = E'\n' then r := r || field; return next r; r := '{}'; field := '';
      elsif c = E'\r' then null;
      else field := field || c; end if;
    end if;
    i := i + 1;
  end loop;
  if field <> '' or coalesce(array_length(r, 1), 0) > 0 then r := r || field; return next r; end if;
end $$;

-- 「令和5年4月3日\n午前7時40分」「2023/4/3」などから日付を取る
create or replace function tgc_wareki_date(p text) returns date
language plpgsql immutable as $$
declare m text[];
begin
  if p is null or btrim(p) = '' then return null; end if;
  m := regexp_match(p, '令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日');
  if m is not null then return make_date(2018 + m[1]::int, m[2]::int, m[3]::int); end if;
  m := regexp_match(p, 'R\s*(\d+)[\./年](\d+)[\./月](\d+)');
  if m is not null then return make_date(2018 + m[1]::int, m[2]::int, m[3]::int); end if;
  m := regexp_match(p, '(20\d\d)[/\.\-年](\d{1,2})[/\.\-月](\d{1,2})');
  if m is not null then return make_date(m[1]::int, m[2]::int, m[3]::int); end if;
  return null;
exception when others then return null;
end $$;

create or replace function tgc_num(p text) returns numeric
language sql immutable as $$
  select case when p is null then null
              when regexp_replace(p, '[^0-9\.\-]', '', 'g') ~ '^-?\d+(\.\d+)?$' then regexp_replace(p, '[^0-9\.\-]', '', 'g')::numeric
              else null end
$$;

-- 台帳（1年度分）を取り込む。p_year=令和の年、p_sheet_id=スプレッドシートID。戻り値は取込件数
create or replace function tgc_import_ledger(p_year integer, p_sheet_id text, p_sheets text[] default array['生データ','イノシシ以外データ'])
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_sheet text; v_resp record; v_rows text[][]; v_hdr text[]; r text[]; v_n int := 0; v_total int := 0; v_report jsonb := '{}'::jsonb;
        ix_label int; ix_dt int; ix_method int; ix_place int; ix_hunter int; ix_kill int; ix_bleed_t int; ix_bleed_p int; ix_sex int;
        ix_w int; ix_w2 int; ix_recv int; ix_proc int; ix_rec int; ix_pickup int; ix_pickup2 int; ix_payee int; ix_rank int; ix_yield int;
        ix_base int; ix_price int; ix_species int; ix_half int; ix_serial int; ix_img int; ix_status int;
        v_label text; v_place text; v_city text; v_area text; v_species text; v_dt text; v_date date; v_time text; v_pickup text;
        v_first_w boolean;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '90000');
  foreach v_sheet in array p_sheets loop
    v_n := 0;
    select * into v_resp from extensions.http_get('https://docs.google.com/spreadsheets/d/' || p_sheet_id || '/gviz/tq?tqx=out:csv&sheet=' || extensions.urlencode(v_sheet));
    if v_resp.status <> 200 then
      v_report := v_report || jsonb_build_object(v_sheet, 'HTTP ' || v_resp.status);
      continue;
    end if;
    v_hdr := null;
    for r in select * from tgc_csv_rows(v_resp.content) loop
      if v_hdr is null then
        v_hdr := r;
        ix_label := array_position(v_hdr, '個体管理番号'); ix_dt := array_position(v_hdr, '捕獲日時'); ix_method := array_position(v_hdr, '捕獲方法');
        ix_place := array_position(v_hdr, '捕獲場所'); ix_hunter := array_position(v_hdr, '捕獲者'); ix_kill := array_position(v_hdr, '止め刺し方法');
        ix_bleed_t := array_position(v_hdr, '放血時刻'); ix_bleed_p := array_position(v_hdr, '放血場所'); ix_sex := array_position(v_hdr, '性別');
        ix_w := array_position(v_hdr, '体重'); ix_recv := array_position(v_hdr, '受入時刻'); ix_proc := array_position(v_hdr, '処理日時'); ix_rec := array_position(v_hdr, '記録者');
        ix_pickup := coalesce(array_position(v_hdr, '止めさし・引取'), array_position(v_hdr, '止めさし')); ix_pickup2 := array_position(v_hdr, '引取');
        ix_payee := array_position(v_hdr, '買取料金支払い（捕獲者と異なる場合）');
        ix_rank := coalesce(array_position(v_hdr, '肉ランク'), array_position(v_hdr, 'ランク')); ix_yield := array_position(v_hdr, '歩留まり');
        ix_base := array_position(v_hdr, '買取価格ベース'); ix_price := array_position(v_hdr, '買取価格'); ix_species := array_position(v_hdr, '種類');
        ix_half := array_position(v_hdr, '半期'); ix_serial := array_position(v_hdr, '通し番号'); ix_img := array_position(v_hdr, '画像URL'); ix_status := array_position(v_hdr, 'ステータス');
        -- 2つ目の「体重」（価格計算用）
        ix_w2 := null;
        if ix_w is not null then
          for i in ix_w + 1 .. coalesce(array_length(v_hdr, 1), 0) loop
            if v_hdr[i] = '体重' then ix_w2 := i; exit; end if;
          end loop;
        end if;
        continue;
      end if;
      v_label := btrim(coalesce(r[ix_label], ''));
      if v_label = '' or v_label !~ '^TGC-' then continue; end if;
      v_place := btrim(coalesce(r[ix_place], ''));
      v_city := (regexp_match(v_place, '^(館山市|南房総市|鴨川市|南房総|館山|鋸南町|富津市|木更津市|君津市)'))[1];
      if v_city = '南房総' then v_city := '南房総市'; elsif v_city = '館山' then v_city := '館山市'; end if;
      v_area := case when v_city is not null then btrim(substr(v_place, length(v_city) + 1)) else v_place end;
      v_species := case when ix_species is not null and btrim(coalesce(r[ix_species], '')) <> '' then btrim(r[ix_species]) else 'イノシシ' end;
      v_dt := coalesce(r[ix_dt], '');
      v_date := tgc_wareki_date(v_dt);
      v_time := (regexp_match(v_dt, '((?:午前|午後)?\s*\d{1,2}\s*時\s*\d{1,2}\s*分)'))[1];
      v_pickup := nullif(btrim(concat_ws(' ', nullif(btrim(coalesce(r[ix_pickup], '')), ''), case when ix_pickup2 is not null and btrim(coalesce(r[ix_pickup2], '')) <> '' then '引取' end)), '');
      insert into individuals_history (label_id, fiscal_year, half, species, serial_no, capture_date, capture_time, capture_method, place, city, area,
        hunter_name, kill_method, bleed_time, bleed_place, sex, weight, receive_time, process_at, recorder, pickup, payee, weight_int, meat_rank, yield_rank,
        price_base, price, image_url, status, source, raw, imported_at)
      values (v_label, p_year,
        coalesce(nullif(regexp_replace(coalesce(r[ix_half], ''), '^.*年度', ''), ''), case when v_date is null then null when extract(month from v_date) between 4 and 9 then '上半期' else '下半期' end),
        v_species, nullif(btrim(coalesce(r[ix_serial], '')), ''), v_date, v_time,
        nullif(btrim(coalesce(r[ix_method], '')), ''), nullif(v_place, ''), v_city, nullif(v_area, ''),
        nullif(btrim(coalesce(r[ix_hunter], '')), ''), nullif(btrim(coalesce(r[ix_kill], '')), ''), nullif(btrim(coalesce(r[ix_bleed_t], '')), ''), nullif(btrim(coalesce(r[ix_bleed_p], '')), ''),
        nullif(btrim(coalesce(r[ix_sex], '')), ''), tgc_num(r[ix_w]), nullif(btrim(coalesce(r[ix_recv], '')), ''), nullif(btrim(coalesce(r[ix_proc], '')), ''), nullif(btrim(coalesce(r[ix_rec], '')), ''),
        v_pickup, nullif(btrim(coalesce(r[ix_payee], '')), ''), case when ix_w2 is not null then tgc_num(r[ix_w2]) end,
        nullif(btrim(coalesce(r[ix_rank], '')), ''), nullif(btrim(coalesce(r[ix_yield], '')), ''), tgc_num(r[ix_base]), tgc_num(r[ix_price]),
        nullif(btrim(coalesce(r[ix_img], '')), ''), nullif(btrim(coalesce(r[ix_status], '')), ''),
        'sheet:' || p_sheet_id || '/' || v_sheet, to_jsonb(r), now())
      on conflict (label_id) do update set
        fiscal_year = excluded.fiscal_year, half = excluded.half, species = excluded.species, serial_no = excluded.serial_no,
        capture_date = excluded.capture_date, capture_time = excluded.capture_time, capture_method = excluded.capture_method,
        place = excluded.place, city = excluded.city, area = excluded.area, hunter_name = excluded.hunter_name, kill_method = excluded.kill_method,
        bleed_time = excluded.bleed_time, bleed_place = excluded.bleed_place, sex = excluded.sex, weight = excluded.weight,
        receive_time = excluded.receive_time, process_at = excluded.process_at, recorder = excluded.recorder, pickup = excluded.pickup, payee = excluded.payee,
        weight_int = excluded.weight_int, meat_rank = excluded.meat_rank, yield_rank = excluded.yield_rank, price_base = excluded.price_base, price = excluded.price,
        image_url = excluded.image_url, status = excluded.status, source = excluded.source, raw = excluded.raw, imported_at = now();
      v_n := v_n + 1;
    end loop;
    v_total := v_total + v_n;
    v_report := v_report || jsonb_build_object(v_sheet, v_n);
  end loop;
  return jsonb_build_object('year', p_year, 'imported', v_total, 'sheets', v_report);
end $$;

-- 出荷・販売台帳（1年度分）を取り込む
create or replace function tgc_import_sales(p_year integer, p_sheet_id text, p_sheet text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_resp record; v_hdr text[]; r text[]; v_n int := 0;
        ix_no int; ix_fy int; ix_half int; ix_label int; ix_part int; ix_form int; ix_qty int; ix_cust int; ix_date int; ix_exp int; ix_price int; ix_stock int; ix_shelf int; ix_note int; ix_organ int;
        v_no text; v_label text;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '120000');
  select * into v_resp from extensions.http_get('https://docs.google.com/spreadsheets/d/' || p_sheet_id || '/gviz/tq?tqx=out:csv' || coalesce('&sheet=' || extensions.urlencode(p_sheet), ''));
  if v_resp.status <> 200 then return jsonb_build_object('error', 'HTTP ' || v_resp.status); end if;
  v_hdr := null;
  for r in select * from tgc_csv_rows(v_resp.content) loop
    if v_hdr is null then
      v_hdr := r;
      ix_no := array_position(v_hdr, 'No.'); ix_fy := array_position(v_hdr, '年度'); ix_half := array_position(v_hdr, '半期'); ix_label := array_position(v_hdr, '個体管理番号');
      ix_part := array_position(v_hdr, '部位'); ix_form := array_position(v_hdr, '販売形態'); ix_qty := array_position(v_hdr, '販売量'); ix_cust := array_position(v_hdr, '販売先');
      ix_date := array_position(v_hdr, '販売日'); ix_exp := array_position(v_hdr, '消費期限'); ix_price := array_position(v_hdr, '売値'); ix_stock := array_position(v_hdr, '在庫あり');
      ix_shelf := array_position(v_hdr, '棚番号'); ix_note := array_position(v_hdr, '備考'); ix_organ := array_position(v_hdr, '内臓');
      continue;
    end if;
    v_no := btrim(coalesce(r[ix_no], '')); v_label := btrim(coalesce(r[ix_label], ''));
    if v_no = '' and v_label = '' then continue; end if;
    if v_label = '' and btrim(coalesce(r[ix_part], '')) = '' then continue; end if;
    insert into sales_history (fiscal_year, half, label_id, part, form, qty_g, customer, sold_on, sold_on_text, expiry_text, price, in_stock, shelf, note, organ, src_no, src_key)
    values (p_year, nullif(btrim(coalesce(r[ix_half], '')), ''), nullif(v_label, ''), nullif(btrim(coalesce(r[ix_part], '')), ''), nullif(btrim(coalesce(r[ix_form], '')), ''),
      tgc_num(r[ix_qty]), nullif(btrim(coalesce(r[ix_cust], '')), ''), tgc_wareki_date(r[ix_date]), nullif(btrim(coalesce(r[ix_date], '')), ''), nullif(btrim(coalesce(r[ix_exp], '')), ''),
      tgc_num(r[ix_price]), nullif(btrim(coalesce(r[ix_stock], '')), ''), nullif(btrim(coalesce(r[ix_shelf], '')), ''), nullif(btrim(coalesce(r[ix_note], '')), ''), nullif(btrim(coalesce(r[ix_organ], '')), ''),
      nullif(v_no, ''), 'R' || p_year || ':' || coalesce(nullif(v_no, ''), v_label || ':' || coalesce(r[ix_part], '') || ':' || v_n))
    on conflict (src_key) do update set half = excluded.half, label_id = excluded.label_id, part = excluded.part, form = excluded.form, qty_g = excluded.qty_g,
      customer = excluded.customer, sold_on = excluded.sold_on, sold_on_text = excluded.sold_on_text, expiry_text = excluded.expiry_text, price = excluded.price,
      in_stock = excluded.in_stock, shelf = excluded.shelf, note = excluded.note, organ = excluded.organ, imported_at = now();
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('year', p_year, 'imported', v_n);
end $$;

-- 現在年度（individuals）と過年度（individuals_history）を同じ形で見るビュー（過年度タブ・年度比較用）
create or replace view v_individuals_all as
select h.label_id, h.fiscal_year, h.half, h.species, h.capture_date, h.capture_method, h.city, h.area, h.hunter_name, h.sex, h.weight,
       h.meat_rank, h.yield_rank, null::numeric as yield_pct, h.price as buyback, h.pickup is not null and h.pickup ~ '引取' as pickup, 'history'::text as src
  from individuals_history h
union all
select i.label_id, (regexp_match(i.label_id, '^TGC-(\d{2})-'))[1]::int as fiscal_year,
       case when extract(month from i.capture_date) between 4 and 9 then '上半期' else '下半期' end as half,
       i.species, i.capture_date, i.capture_method, i.capture_city, i.capture_area, i.hunter_name, i.sex, i.weight_total,
       i.meat_rank, null::text, i.yield_rate, i.buyback_amount, coalesce(i.stopkill_pickup, false), 'current'::text
  from individuals i
 where i.deleted_at is null and i.label_id ~ '^TGC-\d{2}-' and i.label_id !~ '^TGC-TEST' and i.capture_date is not null
   and not exists (select 1 from individuals_history h where h.label_id = i.label_id);   -- 台帳から取り込んだ個体は重ねない
grant select on v_individuals_all to anon, authenticated;
