-- 通販の注文の表から、公開キーでの削除権限を外す（2026-11-20 沖「3進めて」）
-- 本番適用: 2026-11-20（適用済み。適用後 anon / authenticated は SELECT・INSERT・UPDATE のみ）
-- 画面は行を消さない（取消は status='取消'、対応の解除は deleted_at）。
revoke delete, truncate, references, trigger on marketplace_orders from anon, authenticated;
revoke delete, truncate, references, trigger on marketplace_item_map from anon, authenticated;
