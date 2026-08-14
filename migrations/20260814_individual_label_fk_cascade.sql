-- 20260814_individual_label_fk_cascade.sql
-- 目的: 個体管理番号(individuals.label_id)を変更したとき、参照している
--   inventory / processing_log の individual_id が自動追従するよう ON UPDATE CASCADE 化する。
--   仮番号(仮-xxx)→正式番号(TGC-08-Txxx/Mxxx)への付番、および編集機能での番号修正で
--   在庫・加工履歴のリンクが切れないようにするため。
-- 方針: on delete は従来どおり NO ACTION（個体削除で在庫を消さない。個体は論理削除運用）。
--   非正規化列 inventory.individual_code は FK 対象外のためアプリ/データ更新側で別途同期する。

alter table public.inventory drop constraint if exists inventory_individual_id_fkey;
alter table public.inventory
  add constraint inventory_individual_id_fkey
  foreign key (individual_id) references public.individuals(label_id)
  on update cascade on delete no action;

alter table public.processing_log drop constraint if exists processing_log_individual_id_fkey;
alter table public.processing_log
  add constraint processing_log_individual_id_fkey
  foreign key (individual_id) references public.individuals(label_id)
  on update cascade on delete no action;
