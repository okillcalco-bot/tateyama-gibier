-- 通し番号を「獣種ごと・年度ごと」に一意にする（追加のみ・適用済み）
--
-- 背景: シカの詳細を入れようとしたら登録できなかった。原因は通し番号ではなく、
-- 「先に用意した空枠に入れる」機能がイノシシ専用にハードコードされていたこと。
-- シカに空枠（TGC-08-シ010〜シ013）があると新規INSERTになり、label_id の
-- 一意制約で弾かれていた。クライアント側はそちらで直した。
--
-- ここでは「通し番号は獣種ごとに独立している」という前提を、DBでも壊せなくする。
--   ・獣種をまたぐ重複は正常（シカの10とキョンの10は別の個体）
--   ・年度が変わると番号は1に戻る運用なので、年度も鍵に含める
--
-- 適用前の実測: 同一獣種内の重複 0件 / 同一獣種・同一年度の重複 0件
create unique index if not exists individuals_species_year_serial_uidx
  on individuals (species, (substring(label_id from '^TGC-(\d\d)-')), serial_number)
  where deleted_at is null and serial_number is not null and label_id ~ '^TGC-\d\d-';
