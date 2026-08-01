-- 20260801_price_master_tiers.sql
-- 価格マスタ 3パターン（スタンダード/ローカル/スタートメンバー）を R4.11 価格表から反映。
-- 決定事項:「Aはスタンダードで、並上極上はa（部位×グレードで3グレード分を保持）」
--   イノシシ: A表 = price_standard（既存の grade='上' に投入済）, B表 = price_local
--   スタートメンバー: 既定は price_local（=ローカル）に設定し、以後「さらに安く」を価格マスタ画面で入力
--   中型獣: フラット（スタンダード 3000 / ローカル 2500・キロ単価）
--   シカ: 1グレードのみ（standard=local=startmember）
-- 追加のみ・冪等。既存の grade='上'/'standard' 行は温存（在庫・注文カタログは grade='上'/barcode 参照）。

begin;

-- 1) イノシシ 精肉部位（grade='上'）に B表=ローカルを反映（price_standard は A表で投入済）
update price_master p set price_local = v.pl, price_startmember = v.pl
from (values
  ('ヒレ',4125),('ロース',4125),('肩ロース',3500),('バラ',3500),('モモ',3000),
  ('カタ（ウデ）',2625),('ネック',2250),('スネ',1875),('ミンチ用',1875),('ミンチ肉',2750)
) as v(part,pl)
where p.species='イノシシ' and p.grade='上' and p.part_name=v.part;

-- 1b) イノシシ 副産物（grade='上'）: ペットフード/骨は B表、内臓は共通1000
update price_master set price_local=700,  price_startmember=700  where species='イノシシ' and grade='上' and part_name='ペットフード用';
update price_master set price_local=150,  price_startmember=150  where species='イノシシ' and grade='上' and part_name='骨';
update price_master set price_local=1000, price_startmember=1000 where species='イノシシ' and grade='上'
  and part_name in ('赤つなぎセット','タン（舌）','ハツ（心臓）','レバ（肝臓）','フワ（肺）','マメ（腎臓）','チレ（脾臓）');

-- 2) イノシシ 並/極上 を追加（barcode なし・注文カタログ外／価格保持用）
insert into price_master (species, part_name, grade, price_standard, price_local, price_startmember)
values
  ('イノシシ','ヒレ','並',3800,3300,3300),        ('イノシシ','ヒレ','極上',5700,4950,4950),
  ('イノシシ','ロース','並',3800,3300,3300),      ('イノシシ','ロース','極上',5700,4950,4950),
  ('イノシシ','肩ロース','並',3100,2800,2800),    ('イノシシ','肩ロース','極上',4650,4200,4200),
  ('イノシシ','バラ','並',3100,2800,2800),        ('イノシシ','バラ','極上',4650,4200,4200),
  ('イノシシ','モモ','並',2600,2400,2400),        ('イノシシ','モモ','極上',3900,3600,3600),
  ('イノシシ','カタ（ウデ）','並',2200,2100,2100),('イノシシ','カタ（ウデ）','極上',3300,3150,3150),
  ('イノシシ','ネック','並',1800,1800,1800),      ('イノシシ','ネック','極上',2700,2700,2700),
  ('イノシシ','スネ','並',1600,1500,1500),        ('イノシシ','スネ','極上',2400,2250,2250),
  ('イノシシ','ミンチ用','並',1600,1500,1500),    ('イノシシ','ミンチ用','極上',2400,2250,2250),
  ('イノシシ','ミンチ肉','並',2500,2200,2200),    ('イノシシ','ミンチ肉','極上',3750,3300,3300);

-- 3) シカ 1グレード: local/startmember を standard に揃える
update price_master set price_local = price_standard, price_startmember = price_standard
where species='シカ' and grade='上';

-- 4) 中型獣 フラット（キロ単価 スタンダード3000 / ローカル2500）。副産物は据置。
update price_master set price_standard=3000, price_local=2500, price_startmember=2500
where species='中型獣' and grade='上'
  and part_name in ('ヒレ','ロース','肩ロース','バラ','モモ','カタ（ウデ）','ネック','スネ');
update price_master set price_local = price_standard, price_startmember = price_standard
where species='中型獣' and grade='上' and part_name in ('ペットフード用','骨');

commit;
