-- 採番トリガを拡張：本ラベル(TGC-08-…)＋通し番号が付いたら intake_status='搬入待ち' を自動解除する。
-- 背景: 引き取り個体を「編集」経路で採番すると intake_status='搬入待ち' が残り、番号は付いているのに
--       受入済みリストから隠れる不具合が発生した（受入=?receive= フロー以外では解除されなかった）。
--       採番=受入済みなので、どの入力経路でも DB 側で整合させる。

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
  -- AUTO センチネルのときだけ DB 側で採番する
  if NEW.label_id is not null and NEW.label_id ~ '^AUTO-' then
    v_prefix := substring(NEW.label_id from '^AUTO-(.+)$');
    if v_prefix is null or v_prefix = '' then
      raise exception 'invalid AUTO sentinel label_id: %', NEW.label_id;
    end if;
    perform pg_advisory_xact_lock(hashtext('tgc_individual_number:' || v_prefix));
    select coalesce(max((substring(label_id from '([0-9]+)$'))::int), 0) + 1
      into v_labelnum
    from public.individuals
    where deleted_at is null
      and label_id ~ ('^TGC-08-' || v_prefix || '[0-9]+$');
    if NEW.species = 'イノシシ' then
      perform pg_advisory_xact_lock(hashtext('tgc_boar_serial'));
      select coalesce(max(serial_number), 0) + 1 into v_serial
      from public.individuals
      where species = 'イノシシ' and deleted_at is null and serial_number is not null;
      NEW.serial_number := v_serial;
    else
      NEW.serial_number := v_labelnum;
    end if;
    NEW.label_id := 'TGC-08-' || v_prefix || lpad(v_labelnum::text, 3, '0');
  end if;

  -- 本ラベル＋通し番号が付いていれば「搬入待ち」を解除（採番=受入済みなので、どの経路でも整合させる）
  if NEW.label_id ~ '^TGC-08-' and NEW.serial_number is not null and NEW.intake_status = '搬入待ち' then
    NEW.intake_status := null;
  end if;

  return NEW;
end $$;

-- トリガ本体は既存（before insert or update on individuals）。関数の入れ替えのみ。
