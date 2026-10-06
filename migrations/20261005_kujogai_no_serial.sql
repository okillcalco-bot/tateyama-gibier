-- 駆除外（TGC-08-アコ### / ハコ###）の個体には通し番号を付けない（2026-10-05）
-- 捕獲票入力（capture-form.html）に「捕獲区分: 駆除外」を足し、AUTO-アコ / AUTO-ハコ で採番するようにした。
-- 採番トリガは AUTO- のとき serial_number に番号を入れるが、通し番号は市役所の駆除台帳の番号なので、
-- 駆除外（接頭辞が「コ」で終わる）には入れない。既存の TGC-08-アコ001/002 も serial_number は null。
-- 変更点は「v_prefix が コ で終わるときは serial_number := null」の1か所だけ（ほかは現行と同じ）。
create or replace function public.tgc_assign_individual_number()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_prefix   text;
  v_labelnum int;
  v_serial   int;
  v_holder   record;
begin
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
    elsif v_prefix ~ 'コ$' then
      NEW.serial_number := null;   -- 駆除外は市役所の通し番号を持たない
    else
      NEW.serial_number := v_labelnum;
    end if;
    NEW.label_id := 'TGC-08-' || v_prefix || lpad(v_labelnum::text, 3, '0');
  end if;

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

  if NEW.label_id ~ '^TGC-08-' and NEW.serial_number is not null and NEW.intake_status = '搬入待ち' then
    NEW.intake_status := null;
  end if;
  -- 駆除外は通し番号が無いので、上の条件では搬入待ちが外れない。本番号が付いたら外す
  if NEW.label_id ~ '^TGC-08-.コ[0-9]+$' and NEW.intake_status = '搬入待ち' then
    NEW.intake_status := null;
  end if;

  return NEW;
end $function$;
