-- 20261108_hunters_private_columns_revoke.sql を戻す（anon に表単位の select/insert/update を戻す）
-- ⚠ 戻すと、ブラウザ用の鍵で口座・住所・電話を再び読めるようになる。画面が動かないときの一時避難だけに使う。
grant select, insert, update on public.hunters to anon;
