-- 出荷登録のときに、新しいお客さんをその場で顧客台帳に登録する（追加のみ）
--
-- きっかけ（2026-10-01）
--   直販出荷は出荷先の名前だけで登録できるが、顧客台帳に無い名前だと注文が顧客につながらず、
--   請求書作成で顧客を選んでも出てこなかった（直近30日で7件。京城苑・おてんとさん・Couche・
--   ウブリアカーレ・なきざかな 等、毎回あとから手で紐付けていた）。
--   顧客台帳はスタッフキーが無いと書けない（RLS）が、出荷登録はキー無しで行う運用のため、
--   既存の staff_lookup_customer_id と同じく SECURITY DEFINER の関数で登録だけ許す。
--
-- 決めたこと
--   - 同じ名前の顧客が1件あればその id を返す（新規作成しない）
--   - 同じ名前が2件以上あれば例外（どちらか分からないまま増やさない）
--   - 無ければ C#### を採番して作る。住所が無いときは notes 先頭に【住所未登録】を付け、
--     あとで送り状の写真や Google マップから住所を入れたら、この目印を外す
--   - 価格ランクは standard / local / startmember / premium / wholesale のどれか（それ以外は standard）

create or replace function public.staff_register_customer_on_ship(
  p_name text, p_address text default null, p_phone text default null, p_price_rank text default 'standard')
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_ids uuid[];
  v_code text;
  v_rank text := case when p_price_rank in ('standard','local','startmember','premium','wholesale') then p_price_rank else 'standard' end;
  v_addr text := nullif(btrim(coalesce(p_address, '')), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_id uuid;
begin
  if v_name = '' then raise exception '出荷先の名前がありません'; end if;
  perform pg_advisory_xact_lock(hashtext('tgc_customer_code'));
  select array_agg(c.id) into v_ids from customers c where c.name = v_name and c.is_active is not false;
  if coalesce(array_length(v_ids, 1), 0) = 1 then return v_ids[1]; end if;
  if coalesce(array_length(v_ids, 1), 0) > 1 then
    raise exception '顧客台帳に「%」が%件あります。どのお客さんか選べないため自動登録しません', v_name, array_length(v_ids, 1);
  end if;
  select 'C' || lpad((coalesce(max(substring(code from '^C([0-9]+)$')::int), 0) + 1)::text, 4, '0')
    into v_code from customers where code ~ '^C[0-9]+$';
  insert into customers(code, name, address, phone, price_rank, honorific, is_active, default_time_zone, notes)
  values (v_code, v_name, v_addr, v_phone, v_rank, '様', true, '0000',
    case when v_addr is null then '【住所未登録】' else '' end
    || '出荷登録の画面で登録（' || to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD') || '）'
    || case when v_addr is null then '。送り状の写真や Google マップから住所・電話を入れたら【住所未登録】を外す' else '' end)
  returning id into v_id;
  return v_id;
end $$;

-- 住所が未登録のまま出荷したお客さん（出荷画面に「あとで住所を」の一覧として出す）
create or replace function public.staff_pending_customers()
returns table(code text, name text, created_at timestamptz, last_order_code text, last_order_date date)
language sql
stable
security definer
set search_path to 'public'
as $$
  select c.code, c.name, c.created_at,
    (select o.order_code from orders o where o.customer_id = c.id order by o.created_at desc limit 1),
    (select o.order_date from orders o where o.customer_id = c.id order by o.created_at desc limit 1)
  from customers c
  where c.is_active is not false and c.notes like '【住所未登録】%' and coalesce(c.address, '') = ''
  order by c.created_at desc
$$;

grant execute on function public.staff_register_customer_on_ship(text, text, text, text) to anon, authenticated;
grant execute on function public.staff_pending_customers() to anon, authenticated;
