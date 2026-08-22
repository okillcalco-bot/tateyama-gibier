-- 個体番号 採番一本化（A案）
-- individuals への INSERT で label_id = 'AUTO-<接頭辞>' のときだけ、DB側で原子的に採番する。
-- センチネル以外（台帳同期の実ラベル・編集PATCH・仮-ラベル等）は一切変更しない＝影響範囲を限定。
-- 削除済み(deleted_at)は基準から除外＝欠番は繰り上げて再利用。

create or replace function public.tgc_assign_individual_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix   text;
  v_labelnum int;
  v_serial   int;
begin
  -- センチネル以外は触らない（同期・他ツール・実ラベルの挿入はそのまま通す）
  if NEW.label_id is null or NEW.label_id !~ '^AUTO-' then
    return NEW;
  end if;

  v_prefix := substring(NEW.label_id from '^AUTO-(.+)$');
  if v_prefix is null or v_prefix = '' then
    raise exception 'invalid AUTO sentinel label_id: %', NEW.label_id;
  end if;

  -- 当該接頭辞の採番を直列化（同時INSERTの競合防止）
  perform pg_advisory_xact_lock(hashtext('tgc_individual_number:' || v_prefix));

  -- 有効ラベルの最大番号+1（削除済み除外＝繰り上げ再利用）
  select coalesce(max((substring(label_id from '([0-9]+)$'))::int), 0) + 1
    into v_labelnum
  from public.individuals
  where deleted_at is null
    and label_id ~ ('^TGC-08-' || v_prefix || '[0-9]+$');

  if NEW.species = 'イノシシ' then
    -- 通し番号はT/M共通（イノシシ全体で連番）。別ロックで直列化。
    perform pg_advisory_xact_lock(hashtext('tgc_boar_serial'));
    select coalesce(max(serial_number), 0) + 1 into v_serial
    from public.individuals
    where species = 'イノシシ' and deleted_at is null and serial_number is not null;
    NEW.serial_number := v_serial;
  else
    -- 他種は 通し番号=管理番号
    NEW.serial_number := v_labelnum;
  end if;

  NEW.label_id := 'TGC-08-' || v_prefix || lpad(v_labelnum::text, 3, '0');
  return NEW;
end $$;

-- INSERT（新規登録）と UPDATE（搬入待ち→受入で 仮- から採番）の両方に適用。
-- どちらも label_id が 'AUTO-' センチネルのときだけ作用する。
drop trigger if exists trg_assign_individual_number on public.individuals;
create trigger trg_assign_individual_number
  before insert or update on public.individuals
  for each row execute function public.tgc_assign_individual_number();

-- 登録の冪等キー。AUTO採番では label_id が一意でなくなるため、
-- オフライン再送等の二重挿入を submit_ref の一意制約で防ぐ。
alter table public.individuals add column if not exists submit_ref uuid;
create unique index if not exists individuals_submit_ref_ukey
  on public.individuals(submit_ref) where submit_ref is not null;
