-- 注文ポータル: トレーサビリティ照会RPC
-- ログイン中のお客様が、パック（ラベル）の個体管理番号で「いつ・どこで獲れた、
-- どんな個体か」を確認できる。プライバシー配慮で捕獲者名・記録者・買取価格は返さない。
-- STABLE（読取のみ）なので read-only トランザクションで動く。

create or replace function public.portal_trace_individual(p_token text, p_label text)
 returns table(
   label_id text, species text, sex text, weight_total numeric,
   capture_date date, capture_time text, capture_place text,
   capture_method text, finishing_method text, processing_date date,
   radiation_result text, radiation_test_date date
 )
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_id  uuid := portal_session_customer(p_token);
  v_key text := upper(regexp_replace(coalesce(p_label,''), '\s', '', 'g'));
begin
  if v_id is null then return; end if;        -- ログイン必須
  if length(v_key) < 4 then return; end if;   -- 空・短すぎる入力は返さない
  return query
  select i.label_id, i.species, i.sex, i.weight_total,
         i.capture_date, i.capture_time,
         nullif(btrim(concat_ws(' ', i.capture_city, i.capture_area)), '') as capture_place,
         i.capture_method, i.finishing_method,
         i.processing_done_at::date as processing_date,
         i.radiation_result, i.radiation_test_date
    from individuals i
   where i.deleted_at is null
     and (
       upper(regexp_replace(i.label_id, '\s','','g')) = v_key
       or v_key like upper(regexp_replace(i.label_id, '\s','','g')) || '-%'  -- 在庫コード(…-KR-2)入力でも個体に当てる
     )
   order by i.label_id
   limit 1;
end;
$function$;

grant execute on function public.portal_trace_individual(text, text) to anon, authenticated;
