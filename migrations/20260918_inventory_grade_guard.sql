-- 肉ランクの後付け変更を防ぎ、変えたときは誰がいつ変えたか残す（追加のみ）2026-09-18
--
--   きっかけ: inventory.grade の列既定値が「上」だったため、加工登録（ミンチ・スライス）で等級を送らない行が
--   全部「上」になっていた（ミンチ肉99件・スライス66件。2026-09-18 に並へ訂正済み）。
--
--   方針（沖 2026-09-18）:
--     上・極上は個体に紐付く（受入時の肉ランク）。後付けでランクが変わることは無いようにする。
--     部位ごとにランクを変えることはある（ロースとバラだけ上 など）。その場合、買取計算は一番多いランク。
--     一度でも上に変えたら精肉した人が分かるように（押し間違えの可能性）。
--
--   1) inventory.grade の既定値「上」を外す（NULL で入ってきたら下のトリガが個体のランクで埋める）
--   2) inventory_grade_log … 受入ランクと違うランクで登録された／後から変更された記録（誰が・いつ・何を）
--   3) トリガ tgc_inventory_grade_guard（BEFORE INSERT OR UPDATE OF grade）
--        INSERT: grade が NULL → ミンチ肉は「並」、それ以外は個体の受入ランク（無ければ「並」）
--                grade が個体の受入ランクと違う → ログ（source='insert'）
--        UPDATE: grade が変わった → ログ（source='update'）
--      changed_by は processed_by → operator の順（精肉登録が入れている作業者名）

alter table inventory alter column grade drop default;

create table if not exists inventory_grade_log (
  id              uuid primary key default gen_random_uuid(),
  inventory_id    uuid,
  ident_code      text,
  individual_code text,            -- 個体（TGC-08-Txxx）または加工バッチ
  part_name       text,
  old_grade       text,
  new_grade       text,
  intake_rank     text,            -- 個体の受入時ランク（individuals.meat_rank）
  changed_by      text,
  changed_at      timestamptz not null default now(),
  source          text             -- insert / update
);
create index if not exists idx_inventory_grade_log_individual on inventory_grade_log(individual_code);
comment on table inventory_grade_log is '肉ランクが受入時と違って登録された／後から変更された記録。買取金額通知の注意欄と突合する';

create or replace function tgc_inventory_grade_guard() returns trigger language plpgsql as $$
declare
  v_ind  text := coalesce(new.individual_id, new.individual_code);
  v_rank text;
  v_who  text := coalesce(nullif(new.processed_by,''), nullif(new.operator,''));
begin
  select meat_rank into v_rank from individuals where label_id = v_ind and deleted_at is null limit 1;
  if tg_op = 'INSERT' then
    if new.grade is null or new.grade = '' then
      new.grade := case when new.part_name ilike 'ミンチ肉%' then '並' else coalesce(v_rank, '並') end;
    elsif new.grade is distinct from coalesce(v_rank, '並') and new.part_name not ilike 'ミンチ肉%' then
      insert into inventory_grade_log (inventory_id, ident_code, individual_code, part_name, old_grade, new_grade, intake_rank, changed_by, source)
      values (new.id, new.ident_code, v_ind, new.part_name, null, new.grade, v_rank, v_who, 'insert');
    end if;
  elsif old.grade is distinct from new.grade then
    insert into inventory_grade_log (inventory_id, ident_code, individual_code, part_name, old_grade, new_grade, intake_rank, changed_by, source)
    values (new.id, new.ident_code, v_ind, new.part_name, old.grade, new.grade, v_rank, v_who, 'update');
  end if;
  return new;
end $$;

drop trigger if exists trg_inventory_grade_guard on inventory;
create trigger trg_inventory_grade_guard
  before insert or update of grade on inventory
  for each row execute function tgc_inventory_grade_guard();
