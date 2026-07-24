# CLAUDE.md（リポジトリルート）

このリポジトリには2つの世代のシステムが共存している。

## 1. ジビエ基幹システム（本番稼働中・ルート直下）

`index.html` / `capture-form.html` / `order-portal.html` / `punch.html` など、
静的HTML + Supabase 直結の PWA 群。館山ジビエセンターの現場で毎日使われている。

- **壊さないこと。** ルートのファイル構成・`sw.js`・`manifest.json` を変更すると
  現場のPWAが壊れる可能性がある
- DBスキーマの変更は `/migrations` に「追加のみ」のSQLを置く既存流儀に従う
- 既存テーブル: individuals, hunters, staff, attendance, products,
  product_movements, orders, customers, area_master など

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
