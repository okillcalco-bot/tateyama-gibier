-- 捕獲票入力の採番の開始番号（全端末で共有）
-- 実際の採番は「DBの最大+1」「端末のカウンタ」「この設定値」の最大値を使う
-- 適用済み: 2026-08-05
insert into app_settings (key, value)
values ('capture_numbering', jsonb_build_object(
  'serial_start', 417, 'label_start_T', 252, 'label_start_M', 150,
  'note', '台帳の通し番号416／T251／M149まで入力済みの次から'))
on conflict (key) do update set value = excluded.value, updated_at = now();
