-- ロールバック: 予約（入荷待ち）と掲示板
drop function if exists admin_delete_bulletin(text, uuid);
drop function if exists admin_upsert_bulletin(text, jsonb);
drop function if exists admin_list_bulletins(text);
drop function if exists admin_set_reservation_status(text, uuid, text);
drop function if exists admin_list_reservations(text, text);
drop function if exists portal_bulletins();
drop function if exists portal_cancel_reservation(text, uuid);
drop function if exists portal_my_reservations(text);
drop function if exists portal_place_reservation(text, jsonb, text, text);
drop function if exists portal_reservation_marks(text);
drop table if exists portal_bulletins;
drop table if exists portal_reservations;
