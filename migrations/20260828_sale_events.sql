-- 出店（イベント販売）を記録として残す（追加のみ）
--
-- これまで出店は「その日かぎり」で、どこに何を持って行っていくら売れたかが残らなかった。
-- 売上報告・出店概要報告を出せるようにし、会場ごと・部位ごとの傾向を貯める。
--
--   event_venues      … 出店先のマスタ（毎回選べるように）
--   sale_events       … 1回の出店（日付・会場・天候・客数・出店料・入金）
--   sale_event_items  … その出店に持って行ったもの／売れたもの
--
-- 在庫との関係（1個体の一生を切らさないための線）
--   準備中     … 在庫はそのまま
--   持ち出し済 … 選んだパックを「引当済」にする（他所へ二重に出さないため）
--   実績確定   … 売れたパックは「出荷済」、売れ残りは「在庫」へ戻す
--   取り消すと全部「在庫」へ戻る
--
-- 金額は generated column で必ず計算する（手で入れた合計がずれないように）。

begin;

create table if not exists event_venues (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text,                       -- マルシェ / 直売所 / 施設 など
  address     text,
  organizer   text,
  memo        text,
  is_active   boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index if not exists event_venues_name_uidx
  on event_venues (name) where deleted_at is null;

create table if not exists sale_events (
  id          uuid primary key default gen_random_uuid(),
  event_date  date not null,
  end_date    date,                       -- 2日間の出店なら最終日
  venue_id    uuid references event_venues(id),
  venue_name  text not null,              -- そのときの名前を残す（マスタを直しても報告は変わらない）
  title       text,
  start_time  text,
  end_time    text,
  weather     text,
  staff_names text,
  visitors    integer,                    -- 立ち寄ってくれた人数（分かる範囲で）
  booth_fee   integer,                    -- 出店料
  other_cost  integer,                    -- 交通費・資材など
  cash_total  integer,                    -- 実際の入金合計（明細との突き合わせ用）
  note        text,
  status      text not null default '準備中',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint sale_events_status_ck check (status in ('準備中', '持ち出し済', '実績確定')),
  constraint sale_events_dates_ck  check (end_date is null or end_date >= event_date)
);
create index if not exists sale_events_date_idx on sale_events (event_date desc) where deleted_at is null;

create table if not exists sale_event_items (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references sale_events(id) on delete cascade,
  kind             text not null default 'inventory',   -- inventory=在庫のパック / other=その他の品
  inventory_id     uuid,
  ident_code       text,
  individual_label text,
  species          text,
  part_name        text,
  item_name        text,                                -- kind='other' のときの品名
  weight_kg        numeric,
  qty_taken        numeric not null default 1,
  qty_sold         numeric not null default 0,
  price_basis      text not null default 'kg',          -- kg=円/kg / unit=円/個
  unit_price       integer not null default 0,
  amount           integer generated always as (
                     (case when price_basis = 'kg'
                           then round(coalesce(unit_price, 0)::numeric * coalesce(weight_kg, 0) * coalesce(qty_sold, 0))
                           else round(coalesce(unit_price, 0)::numeric * coalesce(qty_sold, 0)) end)::integer
                   ) stored,
  note             text,
  created_at       timestamptz not null default now(),
  constraint sale_event_items_kind_ck  check (kind in ('inventory', 'other')),
  constraint sale_event_items_basis_ck check (price_basis in ('kg', 'unit')),
  constraint sale_event_items_qty_ck   check (qty_taken >= 0 and qty_sold >= 0 and qty_sold <= qty_taken)
);
create index if not exists sale_event_items_event_idx on sale_event_items (event_id);
-- 同じパックを同じ出店に二重に積まない
create unique index if not exists sale_event_items_inv_uidx
  on sale_event_items (event_id, inventory_id) where inventory_id is not null;

alter table event_venues     enable row level security;
alter table sale_events      enable row level security;
alter table sale_event_items enable row level security;

do $$
begin
  if not exists (select 1 from pg_policy where polname = 'allow_all' and polrelid = 'event_venues'::regclass) then
    create policy allow_all on event_venues for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policy where polname = 'allow_all' and polrelid = 'sale_events'::regclass) then
    create policy allow_all on sale_events for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policy where polname = 'allow_all' and polrelid = 'sale_event_items'::regclass) then
    create policy allow_all on sale_event_items for all using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on event_venues, sale_events, sale_event_items to anon, authenticated;

-- ── 持ち出しを確定する: 選んだパックを「引当済」にして二重出荷を防ぐ ──
create or replace function public.sale_event_takeout(p_event_id uuid, p_by text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_ev record; v_moved int := 0; v_busy jsonb;
begin
  select * into v_ev from sale_events where id = p_event_id and deleted_at is null for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'この出店が見つかりません'); end if;
  if v_ev.status <> '準備中' then
    return jsonb_build_object('ok', false, 'error', '「準備中」の出店だけ持ち出しできます（今は' || v_ev.status || '）');
  end if;

  -- 他所へ出てしまったパックはここで止める（黙って飛ばさない）
  select coalesce(jsonb_agg(jsonb_build_object('ident', i.ident_code, 'status', inv.status)), '[]'::jsonb)
    into v_busy
  from sale_event_items i join inventory inv on inv.id = i.inventory_id
  where i.event_id = p_event_id and i.inventory_id is not null
    and (inv.deleted_at is not null or inv.status <> '在庫');
  if jsonb_array_length(v_busy) > 0 then
    return jsonb_build_object('ok', false, 'error', '在庫でなくなったパックがあります', 'blocked', v_busy);
  end if;

  update inventory inv set status = '引当済', updated_at = now()
  from sale_event_items i
  where i.event_id = p_event_id and i.inventory_id = inv.id and inv.status = '在庫' and inv.deleted_at is null;
  get diagnostics v_moved = row_count;

  insert into product_movements (product_name, movement_type, qty, staff_name, note, destination)
  values ('出店持ち出し', '引当', v_moved, p_by,
          v_ev.venue_name || ' ' || to_char(v_ev.event_date, 'YYYY/MM/DD'), v_ev.venue_name);

  update sale_events set status = '持ち出し済', updated_at = now() where id = p_event_id;
  return jsonb_build_object('ok', true, 'moved', v_moved, 'status', '持ち出し済');
end $function$;

-- ── 売上を確定する: 売れたパックは出荷済、売れ残りは在庫へ戻す ──
create or replace function public.sale_event_settle(p_event_id uuid, p_by text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_ev record; v_sold int := 0; v_back int := 0; v_total int; v_bad jsonb;
begin
  select * into v_ev from sale_events where id = p_event_id and deleted_at is null for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'この出店が見つかりません'); end if;
  if v_ev.status <> '持ち出し済' then
    return jsonb_build_object('ok', false, 'error', '「持ち出し済」の出店だけ確定できます（今は' || v_ev.status || '）');
  end if;

  -- パック単位のものは「全部売れた/全部残った」のどちらか。中途半端な数量は受け付けない
  select coalesce(jsonb_agg(jsonb_build_object('ident', ident_code, 'sold', qty_sold, 'taken', qty_taken)), '[]'::jsonb)
    into v_bad
  from sale_event_items
  where event_id = p_event_id and inventory_id is not null and qty_sold not in (0, qty_taken);
  if jsonb_array_length(v_bad) > 0 then
    return jsonb_build_object('ok', false, 'error', 'パックは売れたか残ったかのどちらかで入れてください', 'blocked', v_bad);
  end if;

  update inventory inv set status = '出荷済', updated_at = now()
  from sale_event_items i
  where i.event_id = p_event_id and i.inventory_id = inv.id and i.qty_sold > 0
    and inv.deleted_at is null and inv.status in ('在庫', '引当済');
  get diagnostics v_sold = row_count;

  update inventory inv set status = '在庫', updated_at = now()
  from sale_event_items i
  where i.event_id = p_event_id and i.inventory_id = inv.id and i.qty_sold = 0
    and inv.deleted_at is null and inv.status = '引当済';
  get diagnostics v_back = row_count;

  select coalesce(sum(amount), 0) into v_total from sale_event_items where event_id = p_event_id;

  insert into product_movements (product_name, movement_type, qty, staff_name, note, destination)
  values ('出店売上', '出荷', v_sold, p_by,
          v_ev.venue_name || ' ' || to_char(v_ev.event_date, 'YYYY/MM/DD') || ' 売上 ' || v_total || '円',
          v_ev.venue_name);

  update sale_events set status = '実績確定', updated_at = now() where id = p_event_id;
  return jsonb_build_object('ok', true, 'sold', v_sold, 'returned', v_back, 'total', v_total, 'status', '実績確定');
end $function$;

-- ── 確定を取り消す: 在庫を全部「在庫」へ戻して準備中に戻す ──
create or replace function public.sale_event_reopen(p_event_id uuid, p_by text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_ev record; v_back int := 0;
begin
  select * into v_ev from sale_events where id = p_event_id and deleted_at is null for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'この出店が見つかりません'); end if;
  if v_ev.status = '準備中' then
    return jsonb_build_object('ok', false, 'error', 'この出店はまだ持ち出していません');
  end if;

  update inventory inv set status = '在庫', updated_at = now()
  from sale_event_items i
  where i.event_id = p_event_id and i.inventory_id = inv.id
    and inv.deleted_at is null and inv.status in ('引当済', '出荷済');
  get diagnostics v_back = row_count;

  insert into product_movements (product_name, movement_type, qty, staff_name, note, destination)
  values ('出店取消', '戻し', v_back, p_by,
          v_ev.venue_name || ' ' || to_char(v_ev.event_date, 'YYYY/MM/DD') || ' の確定を取り消し', v_ev.venue_name);

  update sale_events set status = '準備中', updated_at = now() where id = p_event_id;
  return jsonb_build_object('ok', true, 'returned', v_back, 'status', '準備中');
end $function$;

grant execute on function public.sale_event_takeout(uuid, text) to anon, authenticated;
grant execute on function public.sale_event_settle(uuid, text)  to anon, authenticated;
grant execute on function public.sale_event_reopen(uuid, text)  to anon, authenticated;

commit;
