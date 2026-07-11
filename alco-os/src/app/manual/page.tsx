import { Card, PageHeader } from "@/components/ui";

export const dynamic = "force-static";

export const metadata = { title: "ALCO OS 使い方マニュアル" };

/**
 * スタッフ用マニュアル。DBに依存しない静的ページ。
 * 機能を追加・変更したら、必ずこのページも同じPRで更新すること（docs/07参照）。
 * 印刷（ブラウザの印刷→PDF）でそのまま配布資料になる。
 */

function Section({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <h2 className="mb-2 text-base font-bold text-green-800">
        {icon} {title}
      </h2>
      <div className="space-y-2 text-sm leading-relaxed text-stone-700">{children}</div>
    </Card>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <p>
      <span className="mr-1 inline-block h-5 w-5 rounded-full bg-green-700 text-center text-xs font-bold leading-5 text-white">
        {n}
      </span>
      {children}
    </p>
  );
}

const NOTE = "rounded-lg bg-amber-50 p-2 text-xs text-amber-900";
const HINT = "rounded-lg bg-stone-50 p-2 text-xs text-stone-500";

export default function ManualPage() {
  return (
    <>
      <PageHeader
        title="📖 使い方マニュアル"
        description="ALCO OS の全機能のスタッフ向けガイド。印刷（PDF保存）してそのまま配布できます。"
      />
      <div className="space-y-4">
        <Section icon="🏠" title="ALCO OS とは / ログイン">
          <p>
            合同会社アルコの仕事をひとつにまとめた業務システムです。スマホのブラウザで{" "}
            <strong>https://alco-os.vercel.app</strong>{" "}
            を開き、自分のメールアドレスとパスワードでログインします（アカウントは代表が発行します）。
          </p>
          <p>
            スマホでは画面下のタブ（ホーム / 共有ボード / メモ / タスク / 承認）が基本の移動手段です。
            その他の機能はPCの左メニュー、またはホームから移動できます。
          </p>
          <p className={NOTE}>
            大原則: <strong>AIが作ったものは、人が「承認」するまで正式データになりません。</strong>
            AIの提案は必ず「承認センター」に届き、人の目を通ってから反映されます。
          </p>
        </Section>

        <Section icon="📋" title="共有ボード — 毎朝ここを見る">
          <p>
            代表からの共有事項・指示が届く掲示板です。<strong>出勤したらまず開く</strong>のがおすすめ。
          </p>
          <Step n={1}>下タブ「共有ボード」を開く（📌付きは重要なお知らせ）</Step>
          <Step n={2}>自分の役割（解体・精肉 / 配送 など）宛の投稿は特に確認する</Step>
          <Step n={3}>
            過去の情報を探すときは検索ボックスか、#タグ（精肉・在庫 / 受注・配送 / 至急
            など）をタップして絞り込む
          </Step>
          <p className={HINT}>
            タグは本文から自動で付きます。「至急」「搬入」「清掃」などの言葉を本文に入れると、
            あとから探しやすくなります。対応が終わった投稿は「アーカイブ」で一覧から外せます。
          </p>
        </Section>

        <Section icon="🎙" title="メモ — 気づいたことは全部ここに投げる">
          <p>
            現場の気づき・頼まれごと・電話の内容などを「メモ」に書くと、
            AIが内容を読んで「タスク」「自然の記録」「情報」などに自動分類し、
            やるべきことをタスクとして提案します。
          </p>
          <Step n={1}>下タブ「メモ」→ 本文を書いて送信（走り書きでOK）</Step>
          <Step n={2}>AIの分類結果が「承認センター」に届く</Step>
          <Step n={3}>承認されると、提案されたタスクが「タスク」一覧に載る</Step>
          <p className={HINT}>
            きれいな文章にする必要はありません。「誰が・何を・いつまでに」が入っていると
            AIの精度が上がります。
          </p>
        </Section>

        <Section icon="✅" title="タスク — 今日やることの確認と完了">
          <Step n={1}>下タブ「タスク」を開くと未処理タスクが優先度順に並ぶ</Step>
          <Step n={2}>手を付けたら「着手する」、終わったら「◯」ボタンで完了</Step>
          <p className={HINT}>
            完了したタスクは下に打ち消し線で残るので、押し間違えても「未着手に戻す」で戻せます。
          </p>
        </Section>

        <Section icon="📝" title="承認センター — AIの提案に人の目を通す（権限者のみ）">
          <p>
            AIが作ったすべての下書き（メモの分類、申請書、プレゼン構成、投稿文など）がここに並びます。
            内容を確認して「承認」すると正式データに反映、「破棄」すると何も起きません。
          </p>
          <p className={NOTE}>
            承認の操作ができるのは owner / manager 権限の人だけです。
            承認・破棄の記録はすべて監査ログに残り、消せません。
          </p>
        </Section>

        <Section icon="🕒" title="勤怠・シフト">
          <p>
            <strong>打刻はいままで通り punch（打刻アプリ）で行います。</strong>変更ありません。
          </p>
          <p>ALCO OS の「勤怠・シフト」でできること:</p>
          <Step n={1}>月間シフト表で自分の予定を確認（色付き = 勤務、✓打刻 = 実績あり）</Step>
          <Step n={2}>希望シフト（出られる日 / 休み希望 / 時間指定）を出す</Step>
          <Step n={3}>管理者: シフトパターン登録 → スタッフ・日付・パターンでシフト登録</Step>
          <p className={HINT}>
            予実サマリーでシフト予定と打刻実績のズレが見えます。打刻漏れに気づいたら管理者へ。
          </p>
        </Section>

        <Section icon="📦" title="受注管理と帳票（納品書・請求書・領収書）">
          <p>飲食店からの注文（注文ポータル経由）をここで受けて、納品まで進めます。</p>
          <Step n={1}>「🔔 未確認の注文」が来ていたら内容を確認し、ステータスを「確認済」に</Step>
          <Step n={2}>発送したら「発送済」、届いたら「納品完了」に進める</Step>
          <Step n={3}>
            帳票が必要なら注文の「🧾 帳票を発行」→ 種類・発行日を選んで発行 →
            「📄 印刷 / PDFで保存」
          </Step>
          <p className={HINT}>
            帳票番号は自動で付きます（例: INV-202607-001）。ファイル名は自由に付けられ、
            発行後に注文を変更しても帳票は変わりません。間違えたら「取消」（番号は欠番になります）。
            月次の集計とCSV出力もこのページからできます。
          </p>
        </Section>

        <Section icon="🍽" title="飲食店向けボード — お客さんへの発信">
          <p>
            その日の精肉在庫・おすすめ・搬入情報を飲食店に知らせる掲示板です。
            共有ボードの「🍽 飲食店向け」タブから投稿します。
          </p>
          <Step n={1}>投稿時に「本日の精肉在庫を添付」にチェックすると在庫表が自動で載る</Step>
          <Step n={2}>宛先は信頼度（初回 / リピーター / 太客）で絞れる（未選択なら全店）</Step>
          <Step n={3}>
            飲食店には店ごとの専用URL（同タブ下部に表示）をLINE等で一度送れば、
            以後そのURLでいつでも見られる（ログイン不要）
          </Step>
        </Section>

        <Section icon="🎬" title="メディア — プレゼン資料とYouTube動画">
          <p>講演資料や動画の企画から成果物までを作れます。</p>
          <Step n={1}>
            「メディア」→ 企画を登録（ターゲット・時間・伝えたいこと・元資料・写真）
          </Step>
          <Step n={2}>「AI生成」→ 承認センターで承認</Step>
          <Step n={3}>
            プレゼン: 詳細ページから PowerPoint をダウンロード ／ 動画:
            台本・タイトル案・概要欄が確定し、ブラウザで簡易動画（字幕付き）も書き出せる
          </Step>
          <p className={HINT}>
            AIは「元資料」に書いた事実しか使いません。数字が欲しい場合は元資料に入れてください。
          </p>
        </Section>

        <Section icon="📣" title="発信 — SNS・HPの投稿文を一括作成">
          <Step n={1}>「発信」→ もとネタ（メモ・FB投稿・文字起こし）を貼って登録</Step>
          <Step n={2}>「AI生成」→ HP / Instagram / Facebook / YouTube 向けの原稿が一度にできる</Step>
          <Step n={3}>承認後、チャンネルごとに「コピー」して各アプリに貼り、「投稿済みにする」</Step>
        </Section>

        <Section icon="📄" title="補助金・自然資本・CRM・プロジェクト（担当者向け)">
          <p>
            <strong>補助金</strong>: 案件登録 → 要件チェックリスト → 申請書ドラフトAI生成 → 承認。
            AI生成文をそのまま提出するのは禁止（必ず人が仕上げる）。
          </p>
          <p>
            <strong>自然資本</strong>: 里山での観察記録（写真+GPS付き）と管理作業をスマホで登録。
            レポートは実在する記録だけを引用してAIが下書きします。
          </p>
          <p>
            <strong>CRM / プロジェクト</strong>: 取引先・案件と、R.O.K.A.などの工事案件の管理。
          </p>
        </Section>

        <Section icon="🐗" title="ジビエ基幹システムとの関係">
          <p>
            個体管理・在庫・注文ポータル・打刻などの現場アプリはいままで通りです。
            ALCO OS はそれらのデータを<strong>壊さず・書き換えず</strong>に、経営数字の集計や
            シフト・受注・帳票などの管理画面を上に重ねています。迷ったら「現場アプリが正」。
          </p>
        </Section>

        <Section icon="🆘" title="困ったとき">
          <p>・エラーが出た → 画面を再読み込み。直らなければスクショを撮って代表へ</p>
          <p>・間違えて承認/完了した → ほとんどの操作は記録が残っています。慌てず代表へ報告</p>
          <p>・パスワードを忘れた → 代表に再発行を依頼</p>
          <p className={NOTE}>
            禁止事項: パスワードの共有 / 飲食店の専用URLを他店に転送 /
            AIの下書きを未承認のまま社外に出すこと
          </p>
        </Section>

        <Section icon="🔧" title="管理者向け: この仕組みの育て方">
          <p>
            ALCO OS は AIモデルで保守できるように作られています。依頼先の目安:
          </p>
          <p>
            <strong>Opus（日常の改修はこちら）</strong>: 文言・項目の追加、タグ辞書の追加、
            帳票レイアウト調整、新しい画面や集計、AIプロンプトの改善。
            頼むときは「まず alco-os/CLAUDE.md と docs/07 を読んで」と一言添える。
          </p>
          <p>
            <strong>Fable（節目の設計だけ）</strong>: 外部APIの認証設計
            （Instagram/Facebook/YouTubeの自動投稿、メール取込）、権限モデルの変更、
            ジビエ基幹の画面をALCO OSへ移行する設計、セキュリティに関わる変更。
          </p>
          <p className={HINT}>
            機能を追加・変更したら、このマニュアルページ（src/app/manual/page.tsx）も
            同じ修正で更新するのがルールです。
          </p>
        </Section>

        <p className="text-center text-xs text-stone-400">
          ALCO OS 使い方マニュアル ・ 印刷はブラウザの「共有 → プリント → PDF保存」
        </p>
      </div>
    </>
  );
}
