-- 削除済み個体が塞いでいる個体番号を、再利用時に自動で空ける（採番トリガの改訂・追加のみ）
--
-- きっかけ（2026-09-14）
--   9/9 に TGC-08-M191（通し532）を登録して同日削除。運用は「削除した番号は詰めて使う」。
--   9/14 に引き取りの仮個体（白石秀一・南房総市山名・44kg）をセンターで本入力すると、
--   採番トリガは生きている行だけを見て次を M191 とするが、individuals.label_id の一意制約は
--   削除済みの行も含むため 23505 で失敗。捕獲票アプリはこれを「オフライン」と誤判定して
--   端末キューに入れ、再送時に「重複＝登録済み」として黙って捨てていた（修正が消える）。
--
-- 対策
--   採番トリガ（BEFORE INSERT OR UPDATE）で、これから付ける label_id を削除済みの行が持っていたら
--   その行の label_id を「<番号>~削除<削除日>」に改名して番号を空ける（memo に経緯を追記）。
--   AUTO 採番でも手入力の番号でも同じ扱い。生きている行が持っていれば従来どおり一意制約で止まる。
--   削除済み行の label_id は変わるが、元の番号は文字列として残り、memo にも記録される。

create or replace function public.tgc_assign_individual_number()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_prefix   text;
  v_labelnum int;
  v_serial   int;
  v_holder   record;
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

  -- 2026-09-14: これから付ける番号を「削除済みの行」が持っていたら、その行の番号を改名して空ける
  if NEW.label_id is not null and NEW.label_id ~ '^TGC-' and NEW.label_id !~ '~削除' then
    for v_holder in
      select id, label_id, deleted_at from public.individuals
      where label_id = NEW.label_id and deleted_at is not null and id <> NEW.id
    loop
      update public.individuals
        set label_id = v_holder.label_id || '~削除' || to_char(v_holder.deleted_at at time zone 'Asia/Tokyo', 'YYYYMMDD'),
            memo = coalesce(memo, '') || E'\n[' || to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD') || '] 番号 '
                   || v_holder.label_id || ' は削除後に別個体で再利用されたため改名（削除した番号は詰めて使う運用）'
      where id = v_holder.id;
    end loop;
  end if;

  -- 本ラベル＋通し番号が付いていれば「搬入待ち」を解除（採番=受入済みなので、どの経路でも整合させる）
  if NEW.label_id ~ '^TGC-08-' and NEW.serial_number is not null and NEW.intake_status = '搬入待ち' then
    NEW.intake_status := null;
  end if;

  return NEW;
end $$;
