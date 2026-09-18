-- イノシシ以外（キョン・アライグマ・ハクビシン）の番号を紙の台帳（様式2）に合わせる（追記＋番号の付け替えのみ）
--
-- きっかけ（2026-09-18・市役所からの指摘）
--   「キョンの番号が重複していないか。8/19 石渡さんの個体が 053 だが、7/22 に 053 は使われている」
--   「アライグマもカウントが合わない」
--   → 紙の台帳（8/3・8/12 に撮った写真）のうち 8 頭がDBに入っておらず、その後アプリが
--     「DBの最大＋1」で同じ番号（キ053〜061・ア012〜018・ハ019〜021 の 19 頭）を振っていた。
--     市へ出す台帳の写しは紙が原本なので、紙の番号を正とする（沖 2026-09-18 決定）。
--
-- やること（1つのトランザクション）
--   1) アプリが振った 19 頭を空き番号へずらす（キ＋4・ア＋2・ハ＋2）。降順に1頭ずつ動かす。
--      inventory / processing_log の individual_id は FK（on update cascade）で追従。
--      ident_code / lot_code / individual_code（KI053-ED 等の文字列）は同じ番号に書き換える。
--      旧→新の対応は individual_audit（action='renumber'）と memo に残す。
--   2) 紙の台帳の 8 頭（キ053〜056・ア012〜013・ハ019〜020）を紙の番号で追加する。
--   3) シ011（8/11入力）の捕獲日 7/6 22:30 → 紙のとおり 8/6 10:30 に直す。
--   ※ ア001 は台帳シートで 2 行（村田・八橋）あったが、八橋分は誤りで村田分が正（DBは既に村田）→ 変更なし。
--
-- 出荷済みの枝肉ラベル（旧番号で印字）は対応表で追える:
--   キ053→057 054→058 055→059 056→060 057→061 058→062 059→063 060→064 061→065
--   ア012→014 013→015 014→016 015→017 016→018 017→019 018→020
--   ハ019→021 020→022 021→023

do $$
declare
  v_today   text := to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD');
  v_reason  text := '紙の台帳（様式2）に未入力の個体があり、アプリが同じ番号を振ったため、紙の番号を正として付け替え（2026-09-18 市役所指摘）';
  r         record;
  v_old     text; v_new text; v_old_code text; v_new_code text;
  v_id      uuid;
  v_n       int;
  -- 付け替え対象（降順で処理する。prefix / ローマ字 / 旧番号 / ずらす数）
  v_moves   jsonb := '[
    {"p":"キ","c":"KI","from":61,"add":4},{"p":"キ","c":"KI","from":60,"add":4},{"p":"キ","c":"KI","from":59,"add":4},
    {"p":"キ","c":"KI","from":58,"add":4},{"p":"キ","c":"KI","from":57,"add":4},{"p":"キ","c":"KI","from":56,"add":4},
    {"p":"キ","c":"KI","from":55,"add":4},{"p":"キ","c":"KI","from":54,"add":4},{"p":"キ","c":"KI","from":53,"add":4},
    {"p":"ア","c":"A","from":18,"add":2},{"p":"ア","c":"A","from":17,"add":2},{"p":"ア","c":"A","from":16,"add":2},
    {"p":"ア","c":"A","from":15,"add":2},{"p":"ア","c":"A","from":14,"add":2},{"p":"ア","c":"A","from":13,"add":2},
    {"p":"ア","c":"A","from":12,"add":2},
    {"p":"ハ","c":"HA","from":21,"add":2},{"p":"ハ","c":"HA","from":20,"add":2},{"p":"ハ","c":"HA","from":19,"add":2}
  ]'::jsonb;
  v_moved   int := 0; v_inv int := 0; v_plog int := 0;
begin
  -- 前提: 移動先の番号は誰も持っていない（削除済みも含む）／移動元は全部いる
  if exists (select 1 from public.individuals where label_id ~ '^TGC-08-(キ06[2-5]|ア0(19|20)|ハ02[2-3])') then
    raise exception '移動先の番号が既に使われています（先に確認してください）';
  end if;
  if (select count(*) from public.individuals where deleted_at is null
        and label_id ~ '^TGC-08-(キ0(5[3-9]|6[01])|ア01[2-8]|ハ0(19|2[01]))$') <> 19 then
    raise exception '付け替え対象が 19 頭ではありません（既に適用済み？）';
  end if;

  -- 1) 番号の付け替え（降順）
  for r in select * from jsonb_to_recordset(v_moves) as x(p text, c text, "from" int, "add" int) loop
    v_old      := 'TGC-08-' || r.p || lpad(r."from"::text, 3, '0');
    v_new      := 'TGC-08-' || r.p || lpad((r."from" + r."add")::text, 3, '0');
    v_old_code := r.c || lpad(r."from"::text, 3, '0');
    v_new_code := r.c || lpad((r."from" + r."add")::text, 3, '0');

    select id into v_id from public.individuals where label_id = v_old and deleted_at is null;
    if v_id is null then raise exception '% が見つかりません', v_old; end if;
    if exists (select 1 from public.individuals where label_id = v_new) then
      raise exception '% は既に存在します（順番の問題）', v_new;
    end if;

    insert into public.individual_audit(action, actor, actor_name, target_id, label_id, new_label_id, reason, before, after)
    select 'renumber', 'migration', '20260918_nonboar_paper_ledger_renumber', i.id, v_old, v_new, v_reason,
           jsonb_build_object('label_id', i.label_id, 'serial_number', i.serial_number, 'capture_date', i.capture_date, 'hunter_name', i.hunter_name,
                              'inventory', (select jsonb_agg(jsonb_build_object('id', v.id, 'ident_code', v.ident_code, 'lot_code', v.lot_code, 'scan_code', v.scan_code, 'status', v.status))
                                              from public.inventory v where v.individual_id = i.label_id)),
           jsonb_build_object('label_id', v_new, 'serial_number', r."from" + r."add")
      from public.individuals i where i.id = v_id;

    -- 本体（FK on update cascade で inventory.individual_id / processing_log.individual_id も追従）
    update public.individuals
       set label_id = v_new,
           serial_number = r."from" + r."add",
           memo = coalesce(memo, '') || E'\n[' || v_today || '] 番号 ' || v_old || ' → ' || v_new || ' に付け替え（' || v_reason || '）'
     where id = v_id;
    v_moved := v_moved + 1;

    -- 在庫の文字列コード（削除済みの行も含めて同じ番号に揃える）
    update public.inventory
       set individual_code = case when individual_code = v_old then v_new else individual_code end,
           ident_code = regexp_replace(ident_code, '(^|-)' || v_old_code || '(-|$)', '\1' || v_new_code || '\2', 'g'),
           lot_code   = regexp_replace(lot_code,   '(^|-)' || v_old_code || '(-|$)', '\1' || v_new_code || '\2', 'g')
     where individual_id = v_new;
    get diagnostics v_n = row_count; v_inv := v_inv + v_n;

    -- 加工ログ（individual_id が空の古い行は親コード＝個体番号で拾う）
    update public.processing_log
       set parent_ident_code = case when parent_ident_code = v_old then v_new
                                    else regexp_replace(parent_ident_code, '(^|-)' || v_old_code || '(-|$)', '\1' || v_new_code || '\2', 'g') end,
           child_ident_code  = regexp_replace(child_ident_code, '(^|-)' || v_old_code || '(-|$)', '\1' || v_new_code || '\2', 'g')
     where individual_id = v_new or parent_ident_code = v_old
        or parent_ident_code ~ ('(^|-)' || v_old_code || '(-|$)') or child_ident_code ~ ('(^|-)' || v_old_code || '(-|$)');
    get diagnostics v_n = row_count; v_plog := v_plog + v_n;
  end loop;

  -- 2) 紙の台帳の 8 頭を紙の番号で追加（写真: IMG_2867〜2871・3032 = 8/3 撮影、IMG_3491〜3496 = 8/12 撮影）
  insert into public.individuals
    (label_id, serial_number, species, capture_date, capture_time, hunter_name, capture_city, capture_area, capture_method,
     sex, weight_total, finishing_method, hit_location, trap_part, weather, bleed_time, bleed_location, transport_start, receive_time,
     intake_method, recorder, memo)
  values
    ('TGC-08-ハ019', 19, 'ハクビシン', '2026-07-22', '07:00', '川口哲雄', '館山市', '洲宮',       '箱罠',   'メス', 3.5,  'ナイフ', '胸部', null,     '晴', '07:40', '洲宮',       '08:15', '08:30', '持込', '今泉貴雄', '[' || v_today || '] 紙の台帳（様式2・8/3撮影 IMG_2867）から後入力。番号は台帳どおり'),
    ('TGC-08-キ053', 53, 'キョン',     '2026-07-22', '08:10', '渡邉利男', '館山市', '山本字川谷', 'くくり罠', 'メス', 7.7,  'ナイフ', '胸部', '左前肢', '晴', '08:20', '山本字川谷', '08:20', '09:05', '持込', '今泉貴雄', '[' || v_today || '] 紙の台帳（様式2・8/3撮影 IMG_2868）から後入力。番号は台帳どおり'),
    ('TGC-08-キ054', 54, 'キョン',     '2026-07-23', '08:30', '加藤茂',   '南房総市', '和田町黒岩', 'くくり罠', 'オス', 6.5,  'ナイフ', '胸部', '右前肢', '晴', '09:10', '和田町黒岩', '09:15', '09:50', '持込', '今泉貴雄', '[' || v_today || '] 紙の台帳（様式2・8/3撮影 IMG_2869）から後入力。番号は台帳どおり'),
    ('TGC-08-キ055', 55, 'キョン',     '2026-07-27', '10:06', '加藤茂',   '館山市', '神余',       'くくり罠', 'オス', 5.75, 'ナイフ', '胸部', '左前肢', '晴', '10:10', '神余',       '10:20', '10:50', '持込', '吉田友美', '[' || v_today || '] 紙の台帳（様式2・8/3撮影 IMG_2870）から後入力。番号は台帳どおり'),
    ('TGC-08-ア012', 12, 'アライグマ', '2026-07-29', '08:00', '石渡裕',   '館山市', '大網',       'くくり罠', 'オス', 3.5,  'ナイフ', '胸部', '右後肢', '晴', '08:30', '大網',       '08:50', '09:00', '持込', '沖浩志',   '[' || v_today || '] 紙の台帳（様式2・8/3撮影 IMG_2871）から後入力。番号は台帳どおり'),
    ('TGC-08-ア013', 13, 'アライグマ', '2026-08-05', '08:30', '渡邉利男', '館山市', '山本字川谷', 'くくり罠', 'オス', 2.85, 'ナイフ', '胸部', '右後肢', '晴', '08:45', '山本字川谷', '08:45', '09:05', '持込', '今泉貴雄', '[' || v_today || '] 紙の台帳（様式2・8/12撮影 IMG_3491）から後入力。番号は台帳どおり'),
    ('TGC-08-キ056', 56, 'キョン',     '2026-08-06', '08:30', '渡邉利男', '館山市', '山本字奈良松', 'くくり罠', 'オス', 9.5, 'ナイフ', '胸部', '左後肢', null, '08:55', '山本字奈良松', '08:55', '09:15', '持込', '沖浩志',   '[' || v_today || '] 紙の台帳（様式2・8/12撮影 IMG_3494）から後入力。番号は台帳どおり'),
    ('TGC-08-ハ020', 20, 'ハクビシン', '2026-08-12', '07:40', '片桐玄徳', '館山市', '安布里',     '箱罠',   'オス', 2.4,  'ナイフ', '胸部', null,     '晴', '09:30', '安布里',     '09:38', '09:55', '持込', '吉田友美', '[' || v_today || '] 紙の台帳（様式2・8/12撮影 IMG_3496）から後入力。番号は台帳どおり');

  insert into public.individual_audit(action, actor, actor_name, target_id, label_id, new_label_id, reason, after)
  select 'insert_from_paper', 'migration', '20260918_nonboar_paper_ledger_renumber', i.id, i.label_id, null,
         '紙の台帳（様式2）から後入力（8/3・8/12撮影分の未入力）', jsonb_build_object('capture_date', i.capture_date, 'hunter_name', i.hunter_name, 'weight_total', i.weight_total)
    from public.individuals i
   where i.label_id in ('TGC-08-ハ019','TGC-08-キ053','TGC-08-キ054','TGC-08-キ055','TGC-08-ア012','TGC-08-ア013','TGC-08-キ056','TGC-08-ハ020')
     and i.memo like '%紙の台帳（様式2%から後入力%';

  -- 3) シ011 の捕獲日時（紙: 令和8年8月6日 10時30分・鷲野瞬武・47.8kg）。DBは 7/6 22:30 で月を打ち違えていた
  insert into public.individual_audit(action, actor, actor_name, target_id, label_id, reason, before, after)
  select 'fix_capture_date', 'migration', '20260918_nonboar_paper_ledger_renumber', id, label_id,
         '紙の台帳（様式2・8/12撮影 IMG_3492）では 8/6 10:30。入力時に月を打ち違え',
         jsonb_build_object('capture_date', capture_date, 'capture_time', capture_time), jsonb_build_object('capture_date', '2026-08-06', 'capture_time', '10:30')
    from public.individuals where label_id = 'TGC-08-シ011' and capture_date = '2026-07-06';
  update public.individuals
     set capture_date = '2026-08-06', capture_time = '10:30',
         memo = coalesce(memo, '') || E'\n[' || v_today || '] 捕獲日時 7/6 22:30 → 8/6 10:30 に訂正（紙の台帳どおり）'
   where label_id = 'TGC-08-シ011' and capture_date = '2026-07-06';

  raise notice 'renumbered=% inventory=% processing_log=%', v_moved, v_inv, v_plog;
end $$;
