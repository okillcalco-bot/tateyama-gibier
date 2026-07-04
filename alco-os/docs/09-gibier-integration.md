# 09. ジビエ基幹システム統合方針

## 現状

リポジトリルートの静的HTMLアプリ群（index.html, capture-form.html,
order-portal.html, punch.html 等）が **本番稼働中** のジビエ基幹システム。
Supabase プロジェクト（個体・捕獲者・スタッフ・勤怠・完成品在庫・受注・顧客）に
直接接続し、RLSは「有効化 + allow_all ポリシー」パターン。

主な既存テーブル:

| テーブル | 内容 |
|---|---|
| individuals | 個体（捕獲日・場所・獣種・体重・肉ランク・歩留まり・買取） |
| hunters | 捕獲者台帳（国産ジビエ認証様式対応） |
| staff / attendance | スタッフ・出退勤 |
| products / product_movements | 完成品マスタ・在庫移動ログ（append-only、source_ident_code でトレーサビリティ） |
| orders / customers | 受注・顧客 |
| area_master | 地区マスタ |

## 統合の原則

1. **現場を止めない。** 既存アプリ・既存テーブル・既存データは壊さない
2. 在庫はムーブメント（append-only）から算出する既存設計を維持する
3. トレーサビリティ（製品→個体）の連鎖を切らない
4. 統合は「共存 → 参照 → 統一」の3段階で進める

## Step 1: 共存（現状）

- ALCO OS と既存アプリが同一 Supabase プロジェクトを共有する
- ALCO OS の新テーブルは既存と名前衝突しない（確認済み。
  既存: individuals/hunters/staff/attendance/products/product_movements/orders/customers/area_master、
  ALCO OS: organizations/profiles/tasks/voice_memos/grant_*/sites/...）
- 既存テーブルへの変更は既存側のマイグレーション（/migrations）でのみ行う

## Step 2: 参照（ダッシュボード統合）

- ALCO OS 側に読み取り専用ビュー `v_gibier_*` を追加:
  - v_gibier_intake: 月次捕獲頭数（獣種別）
  - v_gibier_inventory: 在庫数量・在庫金額（product_movements 集計）
  - v_gibier_sales: 売上・顧客別売上（orders 集計）
  - v_gibier_yield: 歩留まり・廃棄量
- ダッシュボード（src/app/page.tsx）の「ジビエ基幹」カードを実数値に差し替え
- 音声メモの detected_category = gibier_operation を
  既存テーブルへの参照付きタスクに変換できるようにする

## Step 3: 統一（権限・データモデル）

- 既存テーブルに organization_id を追加（default で単一組織を埋める）
- allow_all ポリシーを段階的に `alco_add_member_policy` 相当へ移行
  （既存静的アプリが anon キーで動いている間は互換ポリシーを併存させる）
- 既存アプリの画面を ALCO OS の /gibier 配下へ段階移行
  （現場スタッフの習熟を優先し、機能単位で少しずつ）

## 注意

- 既存アプリは PWA としてルートから配信されている。
  リポジトリのルート構成を変えるとサービスワーカー（sw.js）や
  manifest.json が壊れる可能性があるため、alco-os/ ディレクトリ内で完結させること。
- 既存の staff / attendance を HR モジュールで置き換えない。
  シフト・勤怠の正は既存側とし、ALCO OS は SOP・チェックリストのみ担う。
