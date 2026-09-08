-- ============================================================
-- P0-4: capture-photos バケットの非公開化
--
-- 監査/DB実測: バケット capture-photos は public=true。ただし現在オブジェクトは
-- 0件（storage.objects 実測）。よって「今なら」表示への実影響ゼロで非公開化できる。
--
-- 現状コードの確認（本実装で再確認）:
--   capture-form.html は公開URL(/object/public/…)を組み立てて individuals.image_url
--   に保存する経路(svPublicUrl :2688, :4026)を持つ。オブジェクトが0件のため現在は
--   未使用だが、**将来写真を表示する場合は署名URL(signed URL)へ切り替えが必要**。
--   → 本ファイルはバケットを private にするのみ。署名URL対応は client 追補(P1)で行う。
--     （写真の表示・アップロードを再開する前に対応すること。runbookに明記）
--
-- ★ production の Storage 設定は Claude Code から変更しない（runbook参照）。
--   バケット設定はダッシュボード or 下記SQLで人間が適用する。
--
-- 適用前確認: select id, public from storage.buckets where id='capture-photos';  -- public=t
--            select count(*) from storage.objects where bucket_id='capture-photos'; -- 0想定
-- 適用後確認: 上記 public=f になること。
-- rollback: rollback/20260901_p0_capture_photos_private_rollback.sql
-- ============================================================

begin;

update storage.buckets set public = false where id = 'capture-photos';

commit;
