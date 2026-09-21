-- 料理・レシピ: 食品表示（一括表示）に要る項目をレシピごとに持つ（追加のみ）
--
-- 2026-09-21 「食品表示で必要なのは何？最低限揃えないといけないのを詰めて可能なら1枚にしたい。」
--   容器包装入り加工食品の義務表示（食品表示基準）: 名称／原材料名／添加物／原料原産地名／内容量／
--   期限（消費期限 or 賞味期限）／保存方法／製造者（名称・住所）／栄養成分表示（5項目）／アレルゲン、
--   冷凍食品はさらに「凍結前加熱の有無」「加熱調理の必要性」。
--   料理側で自動で出るもの（名称・原材料名・内容量・栄養成分表示・製造者）以外を label に持つ:
--   { expiry_days, storage, pre_heated, need_heating, additives, origin, allergens, product_type }
alter table public.recipes add column if not exists label jsonb;
