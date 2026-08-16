-- 20260816_capture_photos_readonly.sql
-- Codex 4巡目 P0-5: private化が完了するまで、capture-photos への写真アップロードを
-- サーバー側で fail-closed に停止する（クライアント改変では解除できない）。
-- 現状ファイル0件・参照0件のため、書込を止めても現業に影響なし。
--
-- 変更: public に対する ALL(read/write/delete) ポリシーを廃止し、read(SELECT)のみ許可。
--       INSERT/UPDATE/DELETE はポリシー不在＝RLSで拒否（=アップロード不可）。
-- 後続(P0-1): バケットを private 化し、署名URL＋写真管理表へ移行する。

drop policy if exists capture_photos_all on storage.objects;

-- 読み取りのみ（表示用。バケットは当面 public のまま）
create policy capture_photos_read on storage.objects
  for select to public using (bucket_id = 'capture-photos');
-- 書込(INSERT/UPDATE/DELETE)は許可ポリシーを置かない＝拒否（private化まで写真アップロード停止）
