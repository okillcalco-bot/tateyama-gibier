# tests/e2e

画面ごとの回帰テスト（Playwright）。どれも `page.route` で Supabase などの通信をモックしており、本番DBには触れない。

## 流し方

```bash
# 1本
CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome NODE_PATH=/opt/node22/lib/node_modules \
  /opt/node22/bin/node tests/e2e/<name>.e2e.js

# 全部（ファイルごとの結果と NG の一覧）
bash tests/e2e/run-all.sh
# 外へ出られないネットワークで全部（本番に触らないことを仕組みで保証する）
OFFLINE=1 bash tests/e2e/run-all.sh
```

## 一部のテストが使う道具

| テスト | 必要なもの |
|---|---|
| PDF の余白・ページ数を測るもの（buyback-print-margins など） | Python の `pymupdf`（`pip install pymupdf`） |
| QR を実寸で読むもの（menu-voices など） | Python の `zxing-cpp`（`pip install zxing-cpp`） |
| invoice-batch-month の個別PDF（ZIP） | `html2canvas` `jspdf` `jszip` を入れた node_modules を `INV_PDF_LIBDIR` で指定 |

道具が無いとそのテストは失敗する（黙って通さない）。

## 日付に依存するテスト

固定データの「今月」に合わせて、ブラウザの時計を `page.clock.setFixedTime(...)` で固定する。
固定しないと、月が変わった日から失敗する（2026-10 に document-* と sale-event が実際に落ちた）。

## OFFLINE=1 で失敗するもの

外へ出られないネットワークでは、Chrome が `navigator.onLine === false` を返す。捕獲票はこれを見て「通信できない」と判断し、端末のキューに入れる（正しい動き）。
そのため **capture-save-errors-visible** は、OFFLINE=1 では 23505 の場面が「オフライン」扱いになって失敗する。
このテストはすべての通信を `page.route('**/*')` でモックしているので、通常のネットワークで流してよい（2026-10-14 時点で 15/15）。
