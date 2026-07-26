export const dynamic = "force-static";

export const metadata = {
  title: "館山ジビエセンター LINEの使い方",
  description: "捕獲者のみなさま向け。LINEのボタンの使い方を大きな文字で説明します。",
};

/**
 * 捕獲者向けの公開説明ページ（ログイン不要 / middleware で認証除外）。
 *
 * LINEの「使い方」ボタンから開く。読むのは高齢の捕獲者が中心なので:
 * - 文字を大きく（本文 18px 以上）、行間を広く
 * - 1画面に1つの話題。専門用語を使わない
 * - 色だけで意味を伝えない（見出しに記号を併記）
 * - 390px幅で横スクロールしない
 */

function Step({ mark, title, children }: { mark: string; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border-2 border-stone-200 bg-white p-5">
      <h2 className="text-2xl font-bold text-green-900">
        <span aria-hidden="true">{mark}</span> {title}
      </h2>
      <div className="mt-3 space-y-3 text-lg leading-relaxed text-stone-800">{children}</div>
    </section>
  );
}

export default function GuidePage() {
  return (
    <main className="mx-auto max-w-2xl bg-stone-50 px-4 py-6">
      <h1 className="text-3xl font-bold text-green-900">LINEの使い方</h1>
      <p className="mt-2 text-lg text-stone-700">
        館山ジビエセンターです。画面の下にあるボタンを押すだけで手続きができます。
      </p>

      <div className="mt-5 space-y-4">
        <Step mark="①" title="捕獲を報告する">
          <p>「捕獲報告」を押してください。写真をお願いする返事がきます。</p>
          <p className="rounded-xl bg-amber-50 p-4 font-bold text-amber-900">
            写真は3枚あると助かります。
            <br />
            1枚目：全体がわかる写真
            <br />
            2枚目：尻尾を切る前
            <br />
            3枚目：尻尾を切った後
          </p>
          <p>
            写真のあとに、獣の種類（イノシシ・シカなど）と、
            とった方法（くくり罠・箱罠・銃）を文字で送ってください。
          </p>
          <p>
            場所は、LINEの「＋」→「位置情報」で送れます。
            市役所に出す書類の地図に使います。
          </p>
          <p>1枚だけでも大丈夫です。足りない分は職員からおたずねします。</p>
        </Step>

        <Step mark="②" title="これから持っていくとき">
          <p>「搬入連絡」を押してください。受け入れの案内が返ってきます。</p>
          <p>だいたいの到着時間を文字で送っていただけると助かります。</p>
        </Step>

        <Step mark="③" title="今日の受け入れを知りたいとき">
          <p>「受入状況」を押すと、本日の受入件数が返ってきます。</p>
        </Step>

        <Step mark="④" title="買取のこと">
          <p>「買取状況」はいま準備中です。</p>
          <p>お急ぎのときは職員が確認してご連絡します。</p>
        </Step>

        <Step mark="⑤" title="電話したいとき">
          <p>「電話」を押すと、そのままセンターに電話がかかります。</p>
        </Step>

        <Step mark="⑥" title="はじめてご連絡いただくとき">
          <p>お名前（フルネーム）を送ってください。職員が確認します。</p>
          <p className="rounded-xl bg-stone-100 p-4">
            すでにセンターに登録がある方は、あらためて住所や口座などをお送りいただく必要は
            ありません。お名前だけで大丈夫です。
          </p>
        </Step>
      </div>

      <p className="mt-6 rounded-2xl bg-white p-5 text-lg leading-relaxed text-stone-800">
        文章をそのまま送っていただいても大丈夫です。職員が読んでお返事します。
        <br />
        すぐに自動で「受け付けました」と返事がきますが、実際の対応は職員が行います。
      </p>

      <p className="mt-4 text-base text-stone-500">館山ジビエセンター（合同会社アルコ）</p>
    </main>
  );
}
