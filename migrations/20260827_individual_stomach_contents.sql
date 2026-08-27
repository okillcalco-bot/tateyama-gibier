-- 胃の内容物（何を食べて育ったか）を記録できるようにする。追加のみ。
--
-- 線の入口（生態データ）がほぼ空だった。緯度経度1件・推定年齢0件・体長0件・餌0件。
-- そのうち「餌」は、内臓摘出のときに現場で必ず目に入るのに、書く場所が無かった。
-- 選択式（複数可）＋書ききれない場合の自由記入にして、手間を増やさずに残せるようにする。
--
-- 選択肢は capture-form.html の STOMACH_OPTIONS が正。DBは制約を付けず自由に受ける
-- （選択肢を増やすたびにマイグレーションを打つ運用にしないため）。

alter table individuals add column if not exists stomach_contents text[];
alter table individuals add column if not exists stomach_note text;

comment on column individuals.stomach_contents is '胃の内容物（選択式・複数可）。内臓摘出時に見えたもの';
comment on column individuals.stomach_note     is '胃の内容物の補足（選択肢にないもの）';

-- individuals への書き込みRPCは列を明示ホワイトリストしている。
-- 新しい列を足しただけでは黙って捨てられるので、5本すべてに追記する。
-- （適用済み。二度流しても安全）
do $outer$
declare r record; d text;
begin
  for r in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in
      ('staff_individual_create','staff_individual_edit','staff_individual_update',
       'staff_capture_intake','public_capture_submit')
  loop
    d := pg_get_functiondef(r.oid);
    if d ~ 'stomach_contents' then continue; end if;
    d := replace(d, $q$'body_length_cm'$q$, $q$'body_length_cm','stomach_contents','stomach_note'$q$);
    execute d;
  end loop;

  if not (select bool_and(pg_get_functiondef(p.oid) ~ 'stomach_contents')
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname in
            ('staff_individual_create','staff_individual_edit','staff_individual_update',
             'staff_capture_intake','public_capture_submit')) then
    raise exception '胃の内容物を許可できていないRPCがあります';
  end if;
end $outer$;
