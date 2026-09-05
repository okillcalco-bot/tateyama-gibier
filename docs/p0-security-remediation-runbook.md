# P0-A セキュリティ是正 本番反映ランブック

- 対象: 館山ジビエ在庫管理システム（本番 Supabase `clpdyrehdgzgiidbfucj` / Vercel `tateyama-gibier.vercel.app`）
- 位置づけ: **本PRは production へ未適用**。DB migration・Storage変更・deploy・mergeは行っていない。本書は人間が反映する際の手順書。
- スコープ: 監査 `docs/security-privacy-ip-premeeting.md` の **P0-A（現行システムでも即対応推奨）** のみ。横展開/マルチテナント/認証基盤再設計は含まない。
- 検証状況: DB側は本番に対しロールバック安全なトランザクションで実測検証済み（`tests/db/p0_security.test.sql` = ALL PASS）。client側はE2E（`p0-pii-client` 12/12、既存回帰に新規failなし）で確認済み。

---

## 1. 変更内容

### DB（migrations/・すべて追加ファイル。適用は人間）
| ファイル | 種別 | 内容 |
|---|---|---|
| `20260901_p0a_staff_hunters_views_rpcs.sql` | 追加のみ | `staff_public`/`hunters_public` VIEW、`admin_staff_list`/`admin_hunters_list`/`staff_set_break_default`/`public_hunter_provisional` RPC |
| `20260901_p0b_staff_hunters_rls.sql` | 制限 | staff/hunters 本体の anon 直読み/直書きを `staff_key_header_ok()` 必須に |
| `20260901_p0_rpc_least_privilege.sql` | 制限 | 状態変更RPC5本に staff-key ガード（リネーム+ラッパー）＋ 未使用RPCの anon EXECUTE 剥奪 |
| `20260901_p0_write_least_privilege.sql` | 制限 | 未使用テーブル(customer_prices/public_holidays/staff_fixed_schedule)の anon 書き込み剥奪 |
| `20260901_p0_portal_password_purge.sql` | データ | `customers.portal_password` 平文718件をNULL化（列は残す） |
| `20260901_p0_capture_photos_private.sql` | Storage | `capture-photos` バケットを public=false に |

各ファイルに対の rollback を `migrations/rollback/` に用意。

### client（HTML）
- `punch.html` `outlet.html` `capture-form.html`: 氏名等の最小列は `staff_public`/`hunters_public` を読む。**punch は staff テーブルへ一切書き込まない**（休憩既定の変更は管理アプリ=スタッフ台帳側のみ。Codexレビュー反映で無認証write を廃止）。capture-form の仮登録は `public_hunter_provisional` RPC 経由（入力制約＋重複排除＋レート制限つき）。capture-form の市役所調査票の**電話欄は空になる**（電話は公開VIEWに含めない）。
- **公開VIEWの列（Codexレビュー反映）**: `hunters_public` は id/name/furigana/is_retired のみ（**city/trap_area は含めない**＝氏名＋活動地域を anon に出さない）。`staff_public` は id/name/color/is_active/default_break_min のみ。氏名が anon 公開VIEWに残るのは、認証を持たない現場端末（punch/outlet/capture-form）の名前ピッカー/氏名補完に必要なため。これを無くすには punch/outlet/capture-form へキオスク/スタッフキー認可を入れる必要があり、**P1**（§8x）。
- `index.html`: 名前ボタン系は公開VIEW。給与台帳・捕獲者台帳・市役所様式・賃金台帳など**全列が要る画面と保存**の前に `staffKeyEnsure()` を呼ぶ（初回だけスタッフキー入力を促す）。状態変更RPC（sale_event_*/voice）呼び出し前にも `staffKeyEnsure()`。ソース直書きの実名（捕獲者90名の地区対応表・datalist192名・スタッフ12名配列）を除去。

## 2. 修正対象 finding（監査 §C との対応）
- **C1/C10 hunters/staff の anon 全件読み取り** → p0a+p0b（VIEW+RLS）
- **C2 anon の任意行 UPDATE/DELETE（mass assignment）** → p0b（staff/hunters の write を staff-key 必須に）＋ p0_write（未使用テーブル）
- **C6 portal_password 平文718件** → p0_portal_password_purge
- **C7 無認証の状態変更RPC（sale_event_*/voice）** → p0_rpc_least_privilege
- **C8 capture-photos public** → p0_capture_photos_private
- **P0-5 ソース内個人情報** → client（実名除去）
- **未使用RPC/テーブルの過剰 anon 権限** → p0_rpc_least_privilege / p0_write_least_privilege

（下記は本P0スコープ外＝§8「未修正」参照: individuals本体・base_*・tgc_reserve・staff_lookup・IDOR全般・record-list旧キー）

## 3. migration 適用順（無停止のための順序）

**重要: この順序を守ること。** 追加→client→制限、の順で切れ目が出ない。

1. **DB 追加のみ**を先に適用（既存挙動は変わらない）:
   - `20260901_p0a_staff_hunters_views_rpcs.sql`
2. **client を配信**（PRをマージ→Vercel自動デプロイ 約6分）。旧DBのままでも新clientは動く（base はまだ開いている）。
3. **反映確認後**、**DB 制限**を適用:
   - `20260901_p0b_staff_hunters_rls.sql`
   - `20260901_p0_rpc_least_privilege.sql`
   - `20260901_p0_write_least_privilege.sql`
   - `20260901_p0_portal_password_purge.sql`
4. **Storage**（別系統・任意のタイミングで可）:
   - `20260901_p0_capture_photos_private.sql`（バケット設定。§8参照）

## 4. production 適用前の確認（現状スナップショット取得）
```sql
-- 影響件数
select count(*) as portal_pw_nonnull from customers where portal_password is not null;      -- 想定 718
select count(*) as photos from storage.objects where bucket_id='capture-photos';            -- 想定 0
select id, public from storage.buckets where id='capture-photos';                            -- public=t
-- 現状の anon 可視（適用後に0/減になることの前後比較用）
-- ※ psql の anon ロールで: set role anon; select count(*) from staff; select count(*) from hunters; reset role;
```

## 5. backup 確認
- Supabase の自動バックアップ / PITR が有効であることをダッシュボードで確認。
- portal_password のNULL化は**平文を復元しない**方針（設計上不要）。平文の別テーブル退避は行わない（平文の複製を増やさない）。万一戻す必要が出た場合のみ PITR。
- migration 群はDDL/DMLとも PostgreSQL のトランザクショナルDDLで、各ファイル内 `begin;…commit;` 単位。

## 6. maintenance window
- **原則不要**（無停止順序で移行できる）。ただし念のため利用の少ない時間帯（例: 早朝/夜間）に step 3 を実施推奨。
- step 3 の各制限migrationは数秒で完了（テーブルロックは短時間）。捕獲・搬入・出荷の同時実行が少ない時間が望ましい。

## 7. migration 実行
- Supabase ダッシュボードの SQL Editor もしくは MCP `apply_migration` で、§3の順に1ファイルずつ適用。
- 各ファイル適用後に §9 の該当確認SQLを流す。

## 8. Storage 変更手順（capture-photos）
- 現在オブジェクト0件のため表示影響なし。`20260901_p0_capture_photos_private.sql`（`update storage.buckets set public=false ...`）を適用、またはダッシュボード Storage → capture-photos → Make private。
- **注意（将来対応=P1）**: capture-form.html は公開URL(`/object/public/...`)を組む経路を持つ。**写真のアップロード/表示を再開する前に、署名URL(signed URL)対応へ切り替えること**。0件の今は影響なし。

## 9. 適用後 verification SQL
```sql
-- p0a: VIEW/RPC が存在
select count(*) from information_schema.views where table_name in ('staff_public','hunters_public');   -- 2
-- p0b: anon で 0 行（psql: set role anon; ... reset role;）
set role anon; select count(*) staff_anon from staff; select count(*) hunters_anon from hunters;
              select count(*) sp from staff_public; select count(*) hp from hunters_public; reset role;
--   期待: staff_anon=0, hunters_anon=0, sp>0, hp>0
-- p0_rpc: ガード関数が42501（psql: set role anon; select sale_event_settle('...uuid...'); → ERROR 42501）
-- p0_rpc: anon は *_impl を直接呼べない（PUBLICバイパス封鎖の確認）
select proname, has_function_privilege('anon', oid, 'EXECUTE') as anon_exec
 from pg_proc where pronamespace='public'::regnamespace and proname like '%\_impl' escape '\'
   and proname in ('sale_event_settle_impl','sale_event_reopen_impl','sale_event_takeout_impl','staff_voice_moderate_impl','staff_voices_list_impl');
--   期待: 全て anon_exec=false
-- p0_write: anon の書き込み権限が消えている
select table_name, privilege_type from information_schema.role_table_grants
 where grantee='anon' and table_name in ('customer_prices','public_holidays','staff_fixed_schedule')
   and privilege_type in ('INSERT','UPDATE','DELETE');   -- 0行
-- p0_portal: 平文0件
select count(*) from customers where portal_password is not null;   -- 0
-- capture-photos: 非公開
select public from storage.buckets where id='capture-photos';       -- f
```
※ 本番に無害な統合テストとして `tests/db/p0_security.test.sql` をそのまま流してもよい（末尾で例外を投げて全ロールバックするので副作用なし。"TESTRESULT: ALL PASS" を確認）。

## 10. frontend smoke test（client配信後・step3適用後の両方で）
スタッフキーを1回入力した端末で:
1. **punch.html**: 名前ボタンが出る（staff_public）／出退勤できる。※休憩初期値の変更はこの端末からはできない（管理アプリのスタッフ台帳で行う）ことを確認。
2. **capture-form.html**: 捕獲者名の予測候補が出る（hunters_public）／新規名の仮登録ができる（public_hunter_provisional）／捕獲票を保存できる。
3. **index.html 精肉モード**: 作業者名が出る／精肉登録・出荷ができる。
4. **index.html スタッフ台帳/捕獲者台帳/賃金台帳/市役所様式**: 初回にスタッフキーを聞かれ、入力後に全項目が表示される。
5. **index.html 出店イベント**: 持ち出し/精算/取消（sale_event_*）がスタッフキーで実行できる。
6. **index.html 声モデレーション**: 一覧・公開/却下がスタッフキーで実行できる。
7. **outlet.html**: 納品作業者の選択肢が出る（staff_public）。
8. **order.html（顧客ポータル）**: ログイン・注文が通る（portal_password NULL化の影響なし＝customer_secrets運用）。

## 11. rollback 条件
- 現場から「スタッフ名が出ない／台帳が空／保存できない」等が上がり、スタッフキー入力でも回復しない。
- 出店精算・声モデレーションがスタッフキーを入れても 42501 になる（ラッパー不整合）。
- 顧客ポータルのログインに影響が出た（想定外）。

## 12. rollback 手順（適用の逆順）
1. `rollback/20260901_p0_portal_password_purge_rollback.sql`（列コメントのみ。値は戻さない）
2. `rollback/20260901_p0_write_least_privilege_rollback.sql`
3. `rollback/20260901_p0_rpc_least_privilege_rollback.sql`（ラッパーを外し impl を元名へ・anon grant復旧）
4. `rollback/20260901_p0b_staff_hunters_rls_rollback.sql`（allow-all に戻す）
5. 必要なら client を1つ前のデプロイに戻す（Vercel の Rollback）。※ client は公開VIEW/RPCを使うが、rollback後も p0a のVIEW/RPCは残す（害がない）ので、client を戻さなくても base が開放されれば動く。
6. `rollback/20260901_p0_capture_photos_private_rollback.sql`（public=true に戻す・写真表示が公開URL前提の場合）
7. 最後まで戻すなら `rollback/20260901_p0a_staff_hunters_views_rpcs_rollback.sql`（VIEW/RPC削除。ただし client がまだVIEW/RPCを参照するなら残すこと）。

---

## 8x. このP0で「未修正」のまま残すもの（意図的・要別Issue）
- **individuals 本体の anon 遮断**（GPS・捕獲者名・買取金額）: 認証を持たない捕獲/搬入/台帳アプリ（capture-form/capture-report/record-list）が読み書き両方で全面依存。認証基盤の導入（P1）が前提のため本P0では触らない。買取金額のみ列単位で守る案も、staff-keyでも読めなくなる副作用があり見送り。
- **base_* RPC（EC在庫操作）の認可**: 定義が本リポ外（本番直適用）＋認証なしの outlet.html が使用。本番定義の取得と outlet 認証設計が要るためP1。
- **tgc_reserve_scan_codes の認可**: 認証なし相当の精肉モードが採番先取りに使用。実害は採番消費のみ（トリガが必ず採番）。P1。
- **staff_lookup_customer_id の認可**: 直接出荷（日次）で氏名→顧客ID解決に使用。読み取り・単一IDのみ。customersは既にstaff-key保護のため優先度低。P1。
- **IDOR/mass assignment 全般（write CHECK=true のテーブル群）**: 認証なし公開画面の直接テーブル書き込み（individuals/attendance/cleaning_logs/products/product_movements 等）をRPC化する必要があり、これは書き込み経路の作り直し（P1）。
- **record-list.html の旧 anon キー**: 棚卸し対象（P1）。role=anon のため秘密漏洩ではないが、個体台帳が認証なしで編集可能な導線ごとP1で扱う。
- **エラー本文の素通し / OS通知の顧客名**: 本P0では未対応（別途）。
- **公開VIEWに残る氏名（staff_public の氏名/id、hunters_public の氏名/ふりがな）**: 認証を持たない現場端末（punch/outlet/capture-form）の名前ピッカー・氏名補完に必要なため anon に残す。完全に無くすには punch/outlet/capture-form へキオスク認可（施設のスタッフキーを各端末に配布し、公開VIEWを廃止して staff-key RPC 経由に寄せる）を入れる必要があり P1。あわせて、捕獲者名の一括列挙を避けるための前方一致サジェストRPC（rate-limit つき）化も P1 候補。※本改修で city/trap_area は既に hunters_public から除去済み（氏名＋活動地域は出さない）。

## 自動CI / テスト状況
- **本リポジトリに GitHub Actions 等の自動CIは存在しない**（`.github/workflows/` なし）。よって PR #243 の head では workflow run が0件であり、「CI green」ではない。
- 検証は**手動**で実施した: ① DBテスト `tests/db/p0_security.test.sql` を本番に対しロールバック安全に実行（ALL PASS。副作用なし）② E2E（`p0-pii-client` 12/12、既存回帰は新規failなし）③ 権限の実測（proacl・`has_function_privilege`）。
- 本番反映時は runbook §9/§10 のSQL・smoke test を人間が手動で流して確認すること。

## 9x. Codexレビュー（PR #243）反映メモ
### 2巡目（PUBLIC EXECUTE バイパス）
- **`*_impl` の PUBLIC 剥奪**: PostgreSQLは関数作成時に既定でPUBLICへEXECUTEを付与する（実測: proaclに `=X/postgres`）。`revoke ... from anon, authenticated` だけでは anon が **PUBLIC 経由で `*_impl` を直接呼べ**、ラッパーのstaff-keyガードをバイパスできた。対策として5関数すべての impl を `revoke all ... from public, anon, authenticated` に変更。未使用RPCの剥奪も `from anon, public` に統一（PUBLIC付きは `from anon` だけでは無効だった）。authenticated は明示付与が残るため alco-os への影響なし。
- **negative test 追加**: `tests/db/p0_security.test.sql` に、sale_event_settle/reopen/takeout・staff_voice_moderate・staff_voices_list の**5 impl すべてについて anon が EXECUTE 権限を持たない**こと、および anon ロールで impl を直接呼ぶと insufficient_privilege になることを固定（ALL PASS 実測）。
- 仮登録の「施設全体20件/時」は、攻撃者が20件消費すると正規利用も一時的に止まるDoS余地が残るが、機密漏洩・改ざんほど重大でないため **P1**（per-端末/IPのレート制限やキオスク認可で解消）。

### 1巡目
- **#1 staff_set_break_default（無認証write）を撤去**: 休憩初期値の変更は管理アプリ（スタッフ台帳・staff-key保護）のみに。punch は staff へ書き込まない。
- **#2 public_hunter_provisional のハードニング**: 入力制約（長さ2〜30・文字必須・制御文字拒否・空白正規化）＋重複排除＋施設全体レート制限（`_rl_hit('hunter_provisional',3600,20)`）。仮登録は memo='仮登録' で識別でき管理者が是正可能（正式な承認待ちキュー分離は P1）。
- **#3 hunters_public から city/trap_area を削除**（氏名＋活動地域を anon に出さない）。残る氏名は §8x のとおり P1 でキオスク認可へ。
- **DB内部依存の再確認**: rename+wrapper 化した5関数（sale_event_settle/reopen/takeout・staff_voice_moderate・staff_voices_list）を **DB内部の function / trigger / cron が旧名で呼んでいないことを実測確認済み**（該当0件）。内部呼び出しが wrapper 経由になって staff-key を要求する事故はない。
