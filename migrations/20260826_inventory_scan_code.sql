-- 在庫に「読み取り専用の数字キー(scan_code)」を持たせる（追加のみ）
--
-- 背景: ラベルのバーコードには識別コード(TGC-08-M167-MU-2 等)をそのまま入れていたが、
--       Code128-B は1文字=1シンボルのため桁数が伸びるとバーが細くなり読めなくなる。
--       実測: 7文字=0.339mm(可) / 9文字=0.284mm / 加工品の19文字=0.156mm(不可)。
--       在庫722件のうち約7割が読み取り限界を割っていた。
-- 対策: 桁数が変わらない8桁の数字キーを別に持ち、バーコードにはこれを入れる。
--       Code128-C は2桁で1シンボルなので 8桁=0.48mm/バー と大きな余裕ができる。
--       人が読む識別コードは従来どおりラベルに文字で印字する（意味は失わない）。

alter table public.inventory add column if not exists scan_code text;

create sequence if not exists public.inventory_scan_code_seq as bigint start with 10000001;

-- 既存行に採番（NULLのみ・冪等）
update public.inventory
   set scan_code = lpad(nextval('public.inventory_scan_code_seq')::text, 8, '0')
 where scan_code is null;

create unique index if not exists inventory_scan_code_uniq
  on public.inventory (scan_code) where scan_code is not null;

-- 新規行に自動採番（クライアント側の実装漏れがあっても必ず入る）
create or replace function public.tgc_assign_scan_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.scan_code is null or btrim(new.scan_code) = '' then
    new.scan_code := lpad(nextval('public.inventory_scan_code_seq')::text, 8, '0');
  end if;
  return new;
end $$;

drop trigger if exists tgc_inventory_scan_code on public.inventory;
create trigger tgc_inventory_scan_code
  before insert on public.inventory
  for each row execute function public.tgc_assign_scan_code();
