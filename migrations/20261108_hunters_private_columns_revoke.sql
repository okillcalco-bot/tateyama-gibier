-- 捕獲者台帳の個人情報の列を、ブラウザ用の鍵（anon）から外す（2026-11-08）
--
-- ⚠️ 適用タイミングに注意 ⚠️
--   20261108_hunters_private_rpc.sql を適用し、index.html / capture-form.html / buyback.html が
--   staff_hunters_private / staff_hunter_private_save を使う版に本番反映され、
--   本番の画面で表示・保存を確かめてから流すこと。先に流すと台帳タブ・買取画面が読めなくなる。
--
-- 列単位の revoke は、表単位の権限が残っていると効かない。表単位の select/insert/update を外してから、
-- 公開してよい列だけを付け直す（今後 hunters に足す列は、明示的に付けない限り anon から見えない）。
--
-- これで塞がるもの: ブラウザ用の鍵による 郵便番号・住所・電話・口座（銀行・支店・種別・番号・名義・フリガナ）・支払先番号 の読み取り・書き換え
-- 残るもの: 氏名・メモ等の書き換え（捕獲票の仮登録・名前を出す設定で使うため）。センター側のログイン導入時に締める。
-- ALCO OS（ログイン済み authenticated）の権限は変えない。
-- ロールバック: migrations/rollback/20261108_hunters_private_columns_revoke_rollback.sql

revoke select, insert, update on public.hunters from anon;

grant select (id, name, furigana, city, trap_area, memo, registry_number, registered_on, document_type,
              has_gun, name_public, created_at, updated_at, deleted_at)
  on public.hunters to anon;
grant insert (name, furigana, city, trap_area, memo, registry_number, registered_on, document_type,
              has_gun, name_public)
  on public.hunters to anon;
grant update (name, furigana, city, trap_area, memo, registry_number, registered_on, document_type,
              has_gun, name_public, updated_at, deleted_at)
  on public.hunters to anon;

comment on table public.hunters is
  '捕獲者台帳。RLSは select/insert/update（delete不可）。郵便番号・住所・電話・口座・支払先番号は anon から見えない（2026-11-08）。スタッフキーの端末は staff_hunters_private / staff_hunter_private_save を使う';
