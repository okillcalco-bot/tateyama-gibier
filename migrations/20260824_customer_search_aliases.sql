-- 顧客の検索用エイリアス（複数の読み方・呼び名）。追加のみ・非破壊。
-- 例: 植山さん＝エフユーアイジャパン のように、別の呼び名でも検索・手入力注文で見つかるようにする。
alter table public.customers add column if not exists search_aliases text[];
