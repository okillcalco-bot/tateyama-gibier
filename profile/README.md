# 沖浩志 プロフィールサイト

リンク1本とPDF1枚でプロフィールを伝える1ページサイト。
**原本は `profile.json` だけ。** ここを編集して commit すれば、サイトもPDF（印刷体裁）も自動更新される。

## 更新のしかた

1. GitHub で `profile/profile.json` を開いて ✏️ 編集
2. 直したい値を書き換えて commit（`_todo` で始まる文字列は未記入扱いで公開ページに出ない。書き終えたら `_todo` を消す）
3. Vercel が自動ビルド → 数分で本番反映

## 画像の差し替え

- 実ファイルを `profile/public/` に置く（例: `oki.jpg`, `og.png`）
- `profile.json` の `images` / `businesses[].image` の `src` をファイル名に書き換える
- `src: ""` にするとその画像ブロックごと非表示。ファイルが無い場合もビルドは通る（警告のみ）
- ビルド時に幅1200px上限へリサイズ + WebP変換される（`og.png` は 1200x630 PNG）
- `og.png` が無い間は仮のOG画像を自動生成する

## PDF

サイト右上の「📄 PDFで保存」→ 印刷ダイアログでPDF保存。
`print.css` がA4縦・2ページ以内・白黒前提の体裁に整える（事業カードの詳細は展開して出力）。

## Vercel 設定（初回のみ）

1. Vercel → Add New → Project → このリポジトリを選択
2. **Root Directory を `profile` に設定**（これを忘れるとジビエ基幹が表示される）
3. Build Command / Output Directory は `vercel.json` が指定済み（`node build.js` / `dist`）
4. 独自ドメイン（例 `oki.llcalco.com`）を使う場合: Project → Settings → Domains で追加し、
   DNS に CNAME を設定。決まったら `profile.json` の `site.url` にも書く（OGPの絶対URLに使われる）

## 技術メモ

- Vanilla JS + 静的HTML。フレームワーク・DB・API接続なし
- メールアドレスはbot対策のためHTMLに生で書かず、base64をJSで組み立てる
- 将来 ALCO OS を中枢DB化する場合は `build.js` の `loadProfile()` だけ差し替える
