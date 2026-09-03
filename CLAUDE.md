# CLAUDE.md（リポジトリルート）

## 進め方の約束（2026-08-26 合意）

**軸は「1個体の一生が1本の線で繋がっていること」。**
生態 → 個体 → 精肉 → 加工 → 販売 → 食べた人の声。この線を太く・切れなくすることが
すべての改善の判断基準。迷ったら「この変更は線を通すか」で決める。

1. **品質上の欠陥は判断を仰がずに直す。** 折り返しの乱れ・重なり・読めないラベルなど、
   見て分かる不具合は「直すか聞く」のではなく直してから報告する。
   相談するのは業務のやり方が変わるとき、またはどちらが良いか判断できないときだけ。
2. **勘で直さず、まず測る。** 症状が繰り返すときは局所修正を疑い、全件を数える。
   （例: バーコードが読めない → 在庫722件の桁数を実測 → 7割が限界割れと判明 →
   ラベル余白ではなく「何を印字するか」を変えた）
3. **局所最適より全体最適。** 同じ症状が3回出たら、対症療法をやめて構造を変える。
4. **サイレント失敗を作らない。** 書き込みの失敗を握り潰さない。失敗は必ず画面に出す。
   （加工ログが1件も保存されていなかった事故の再発防止）
5. **直したら、測り方をテストに残す。** 目視で分かる不具合こそ実測テストにする
   （実寸で描画して位置を測る等）。`tests/e2e/` に追加し、回帰も毎回流す。

### 定期ループ（Routine）

平日19:00 JSTに1周だけPDCAを回す。1回の実行で扱う改善は1件に絞る。
測って何も見つからなければ何も変えない（無理に変更を作らない）。

### 現状の実測値（2026-09-03 時点・次に測るときの基準）

- 個体634頭 → 精肉まで402頭 → 加工19頭 → 販売まで到達65頭（注文経由64・出店経由11、出店だけ1）
  （**精肉→販売の断絶が最大の課題**。2026-08-26: 600→235→49）
- 出荷35件中、送料が入っているのは0件（08-26以降の9件も0件。**住所が分からない出荷先で
  自動計算を諦めて空欄のまま保存していた**のが原因 → 2026-09-03 に「届け先の地域」から必ず出す構造に変更）
- 生態データ: 捕獲地区/方法/性別/体重は633〜634件。緯度経度1・推定年齢0・体長8・餌0・胃内容物0
  （体長・胃内容物は入力欄ができたが、まだほぼ使われていない）
- 食べた人の声: 0件（仕組みは完成: ラベルQR→物語ページ→承認→公開。一生ビューにも表示するようにした）

測り方は `docs/codex-review-line-freight-voice.md` の「実測SQL」に残してある。

---

このリポジトリには2つの世代のシステムが共存している。

## 1. ジビエ基幹システム（本番稼働中・ルート直下）

`index.html` / `capture-form.html` / `order-portal.html` / `punch.html` など、
静的HTML + Supabase 直結の PWA 群。館山ジビエセンターの現場で毎日使われている。

- **壊さないこと。** ルートのファイル構成・`sw.js`・`manifest.json` を変更すると
  現場のPWAが壊れる可能性がある
- DBスキーマの変更は `/migrations` に「追加のみ」のSQLを置く既存流儀に従う
- 既存テーブル: individuals, hunters, staff, attendance, products,
  product_movements, orders, customers, area_master など

### 作業手順（毎回これに従う）

- Supabase project_id: `clpdyrehdgzgiidbfucj` / 本番: https://tateyama-gibier.vercel.app
- ブランチ: `claude/tateyama-gibier-ux-ws4c5p`
  毎回 `git fetch origin main && git checkout -B <branch> origin/main` から始める
- E2E: `CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
  NODE_PATH=/opt/node22/lib/node_modules /opt/node22/bin/node tests/e2e/<name>.e2e.js`
  **変更したら関連する既存テストも全部流す**（tests/e2e/ 配下）
- デプロイ: PRを作って squash merge → Vercelが自動反映（**約6分**）
- 反映確認: サンドボックスからvercel.appへ直接出られないため、Supabaseの
  `execute_sql` で `select position('目印' in (extensions.http_get('https://tateyama-gibier.vercel.app/index.html')).content)`
- **元データ（individuals / inventory / orders）は書き換えない。** 復元や補完は追記のみ。
- DBの破壊的な検証は `do $$ ... raise exception 'TESTRESULT: %', msg; end $$;` で
  ロールバックさせて確認する

## 2. ALCO OS（`alco-os/`）

合同会社アルコの業務全体を支える業務OS（Next.js + TypeScript + Supabase）。
Voice Memo / Grants / Nature Capital / CRM / Projects / HR / Documents /
Dashboard のモジュールを持ち、ジビエ基幹を段階統合する。

**`alco-os/` 内で作業する場合は必ず `alco-os/CLAUDE.md` と
`alco-os/docs/07-opus-maintenance-guide.md` を先に読むこと。**

統合方針: `alco-os/docs/09-gibier-integration.md`

## 3. プロフィールサイト（`profile/`）

沖浩志の個人プロフィール（1ページ静的サイト + 印刷PDF体裁）。
原本は `profile/profile.json` のみ。`build.js` が `dist/` を生成し、
Vercel（Root Directory: profile）でホスティング。DB・API接続なし。
編集手順は `profile/README.md` を参照。

## 捕獲データの原本: Google スプレッドシート「イノシシの搬入・処理管理台帳」

年度ごとに1ファイル。令和8年度: `1WBPSbiNECIivbi-lrMcAysPwfV4gLogvTLkGfDtyseo`（Drive MCPの
download_file_content + exportMimeType=xlsx で全シート取得可。text/csvは先頭シートのみ）。

シート構成: `捕獲者台帳` / `地区マスタ` / `イノシシ以外データ` / `選択` / `生データ`（マスタ）/
個体別シート（通し番号名 `1`〜）。

`生データ` の列（左から）: 半期 / 館山市・南房総市 / 通し番号 / 個体管理番号(TGC-08-Txxx・Mxxx) /
捕獲日時（`令和8年4月1日\n午前8時00分` 形式）/ 捕獲方法（括り→くくり罠・檻→箱罠）/ 捕獲場所（市名込み）/
捕獲者 / 止め刺し方法（ナイフ・銃）/ 放血時刻 / 放血場所 / 性別 / 体重 / 受入時刻 / 処理日時 / 記録者 /
止めさし・引取 / 買取料金支払い / 体重(2つ目) / 肉ランク / 歩留まり / 買取価格ベース / 買取価格 /
画像URL / ステータス。

DBへの同期は label_id をキーに individuals へupsert（市役所報告書の受入頭数はここから、イノシシのみ）。
将来この同期を自動化予定。

## 放射能検査の記録（台帳の個体別シート & 検査表速報）

台帳スプレッドシートの「数字だけのシート」（通し番号名 `1`〜）が市役所提出用の放射能検査資料。
各シートは3個体分を列 C/D/E に持ち、行18=検査日 / 行19=検査機関(館山市) / 行20=結果判明日 /
行21-23=セシウム134/137/合計（通常「検出下限値以下」）。

現場の原本は「館山ジビエセンター放射性物質検査結果速報」（手書き）。1枚に検査日（判明日）1日分と、
その日に検査した個体番号（例 T176・M077…）を列記。**検査日＝結果判明日（同日）がほぼ毎日**。
セシウムCs検出個体は通常「なし」。原本写真は Drive フォルダ `1mkZoi8j72KlvkABDGtc0leVJgttnxtUw`。

DB: individuals に radiation_test_date / radiation_result_date / radiation_result を追加済み。
検査表写真から individuals へ label_id で反映。台帳の個体別シートへ検査日を書き込むのは現状手作業
（Drive MCPにセルの書込みAPIが無いため）。将来: 検査日入力を業務アプリに追加 → 台帳へ反映を自動化予定。
