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
