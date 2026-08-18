-- イノシシ内臓を常に注文可に（搬入があれば出せるため、在庫マークに関係なく在庫あり扱い）。
-- データ更新のみ（本番適用済み）。ロールバックは always_available を false に戻す。
update portal_products
   set always_available = true, updated_at = now()
 where species = 'イノシシ'
   and display_name in ('猪タン（舌）','猪ハツ（心臓）','猪レバ（肝臓）','猪フワ（肺）',
                        '猪マメ（腎臓）','猪チレ（脾臓）','猪赤つなぎセット');
