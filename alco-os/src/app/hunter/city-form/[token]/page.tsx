import { getServiceDbContext } from "@/lib/db/service-context";
import {
  SPECIES_LIST,
  buildMapTiles,
  buildRemarks,
  checkbox,
  speciesMatches,
  toEra,
  type CityFormRow,
} from "@/domain/hunters/city-form-view";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

/** 検索エンジンに載せない（共有リンクは本人だけが使う） */
export const metadata = {
  title: "有害鳥獣捕獲票",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * 捕獲者が自分で捕獲票を開くページ（フェーズ3 / 要望3）。
 *
 * - ログイン不要。共有トークン（30日有効）で1件だけ引く
 * - 読み出しは 0027 の SECURITY DEFINER 関数。**捕獲票に必要な列しか返さない**
 *   （口座・LINEユーザーID・AIの下書きなどは取得しない）
 * - 様式は既存アプリ（capture-form.html の cityFormPrint）と同じ
 * - 印刷 → PDF保存で市役所へ提出できる
 */

interface PageProps {
  params: Promise<{ token: string }>;
}

async function loadByToken(token: string): Promise<CityFormRow | null> {
  if (!token || token.length < 24) return null;
  try {
    const { supabase } = await getServiceDbContext();
    const { data, error } = await supabase.rpc("get_capture_form_by_token", { p_token: token });
    if (error || !data || (Array.isArray(data) && data.length === 0)) return null;
    return (Array.isArray(data) ? data[0] : data) as CityFormRow;
  } catch {
    return null;
  }
}

function NotAvailable() {
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-bold text-stone-800">このリンクは使えません</h1>
      <div className="mt-4 space-y-3 text-lg leading-relaxed text-stone-700">
        <p>リンクの有効期限（30日）が過ぎたか、無効になっています。</p>
        <p>お手数ですが、館山ジビエセンターへLINEまたはお電話でご連絡ください。</p>
        <p>新しいリンクをお送りします。</p>
      </div>
    </main>
  );
}

export default async function HunterCityFormPage({ params }: PageProps) {
  const { token } = await params;
  const row = await loadByToken(token);
  if (!row) return <NotAvailable />;

  const captureDate = toEra(row.capture_date);
  const trapSetDate = toEra(row.trap_set_date);
  const finishing = row.finishing_method ?? "";
  const disposal = row.disposal_method ?? "販売（館山ジビエセンター）";
  const remarks = buildRemarks(row);
  const hasLocation = row.capture_lat !== null && row.capture_lng !== null;
  const tiles = hasLocation
    ? buildMapTiles(Number(row.capture_lat), Number(row.capture_lng))
    : [];

  const TH = "border border-black bg-stone-100 p-1 text-left align-top";
  const TD = "border border-black p-1 align-top";

  return (
    <main className="mx-auto max-w-[760px] bg-white p-4 text-black">
      <style>{`
        @page { size: A4 portrait; margin: 10mm; }
        @media print { .no-print { display: none !important; } }
      `}</style>

      <div className="no-print mb-4 rounded-xl bg-stone-100 p-4">
        <p className="text-lg font-bold text-stone-800">有害鳥獣捕獲票</p>
        <p className="mt-1 text-base text-stone-700">
          下のボタンで印刷、またはPDFとして保存できます。
          印刷したものと捕獲獣の尾を、市役所へご提出ください。
        </p>
        <div className="mt-3">
          <PrintButton />
        </div>
        <p className="mt-2 text-sm text-stone-600">
          このページのリンクは30日間だけ使えます。他の方には送らないでください。
        </p>
      </div>

      <div className="text-right text-sm">
        捕獲番号　　　　号
        <br />
        <span className="text-xs">（事務局で記入）</span>
      </div>
      <h1 className="text-center text-xl font-bold">有害鳥獣捕獲票</h1>
      <p className="text-center text-sm">（イノシシ等獣類別捕獲用）</p>

      <table className="mt-2 w-full border-collapse text-sm">
        <tbody>
          <tr>
            <th className={`${TH} w-28`}>
              箱わな番号
              <br />
              （摘要5）
            </th>
            <td className={TD}>{row.trap_number || "　"}　番</td>
            <th className={`${TH} w-28`}>捕獲票提出者名</th>
            <td className={TD}>{row.hunter_name ?? ""}</td>
          </tr>
          <tr>
            <th className={TH}>捕獲個体</th>
            <td className={TD} colSpan={3}>
              {SPECIES_LIST.map((name) => (
                <span key={name} className="mr-3 inline-block">
                  {checkbox(speciesMatches(name, row.species))} {name}
                </span>
              ))}
            </td>
          </tr>
          <tr>
            <th className={TH}>捕獲年月日</th>
            <td className={TD} colSpan={3}>
              令和 {captureDate[0]} 年 {captureDate[1]} 月 {captureDate[2]} 日
            </td>
          </tr>
          <tr>
            <th className={TH}>捕獲場所</th>
            <td className={TD} colSpan={3}>
              （大字） {row.capture_place ?? ""} 　（小字）
            </td>
          </tr>
          <tr>
            <th className={TH}>性別</th>
            <td className={TD} colSpan={3}>
              {checkbox(row.sex === "オス")} オス（
              {checkbox(row.sex === "オス" && row.is_juvenile === true)} 幼）　
              {checkbox(row.sex === "メス")} メス（
              {checkbox(row.sex === "メス" && row.is_juvenile === true)} 幼）
            </td>
          </tr>
          <tr>
            <th className={TH}>体長・体重</th>
            <td className={TD} colSpan={3}>
              {row.body_length_cm ?? "　　"} cm　　{row.weight_kg ?? "　　"} kg
              {row.weight_measure === "estimated" ? "（推定値）" : ""}
            </td>
          </tr>
          <tr>
            <th className={TH}>捕獲方法</th>
            <td className={TD} colSpan={3}>
              {checkbox(row.capture_method === "銃猟")} 銃器　
              {checkbox(row.capture_method === "くくり罠")} くくりわな　
              {checkbox(row.capture_method === "箱罠")} 箱わな　
              {checkbox(
                row.capture_method !== null &&
                  !["銃猟", "くくり罠", "箱罠"].includes(row.capture_method),
              )}{" "}
              その他
            </td>
          </tr>
          <tr>
            <th className={TH}>
              餌の種類
              <br />
              （摘要6）
            </th>
            <td className={TD} colSpan={3}>
              {row.bait_type ?? ""}
            </td>
          </tr>
          <tr>
            <th className={TH}>わな設置日</th>
            <td className={TD} colSpan={3}>
              令和 {trapSetDate[0]} 年 {trapSetDate[1]} 月 {trapSetDate[2]} 日
            </td>
          </tr>
          <tr>
            <th className={TH}>
              捕獲個体の
              <br />
              処理方法
            </th>
            <td className={TD} colSpan={3}>
              {checkbox(disposal === "焼却施設搬入")} 焼却施設搬入　
              {checkbox(disposal === "埋却")} 埋却　
              {checkbox(disposal === "自家消費")} 自家消費
              <br />
              {checkbox(disposal.startsWith("販売"))} 販売（
              {checkbox(disposal.includes("館山ジビエセンター"))} 館山ジビエセンター）
            </td>
          </tr>
          <tr>
            <th className={TH}>
              捕獲者
              <br />
              （わな設置者）
            </th>
            <td className={TD}>氏名　{row.hunter_name ?? ""}</td>
            <th className={`${TH} w-20`}>電話番号</th>
            <td className={TD}>{row.hunter_phone ?? ""}</td>
          </tr>
          <tr>
            <th className={TH}>止め刺し方法</th>
            <td className={TD} colSpan={3}>
              {checkbox(finishing === "銃")} 射殺（銃）　
              {checkbox(finishing === "刺殺")} 刺殺（竹槍・ナイフなど）　
              {checkbox(finishing === "既に死亡")} 既に死亡
            </td>
          </tr>
          <tr>
            <th className={TH}>
              その他
              <br />
              特記事項
            </th>
            <td className={`${TD} h-9`} colSpan={3}>
              {remarks}
            </td>
          </tr>
        </tbody>
      </table>

      {hasLocation ? (
        <div className="mt-3" style={{ breakInside: "avoid" }}>
          <b className="text-sm">捕獲場所（朱色×印）</b>
          <div
            className="relative mt-1 overflow-hidden border-2 border-black"
            style={{ width: 640, height: 400 }}
          >
            {tiles.map((tile) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${tile.left}-${tile.top}`}
                src={tile.url}
                alt=""
                width={256}
                height={256}
                style={{ position: "absolute", left: tile.left, top: tile.top }}
              />
            ))}
            <div
              style={{
                position: "absolute",
                left: 640 / 2 - 15,
                top: 400 / 2 - 20,
                fontSize: 30,
                fontWeight: 900,
                color: "#e02020",
                textShadow: "0 0 3px #fff, 0 0 3px #fff",
              }}
            >
              ✕
            </div>
          </div>
          <div className="text-xs">
            出典: 国土地理院（地理院タイル）　緯度 {Number(row.capture_lat).toFixed(5)} / 経度{" "}
            {Number(row.capture_lng).toFixed(5)}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm">
          捕獲場所の地図は別紙に添付してください（位置情報が届いていません）。
        </p>
      )}

      <div className="mt-3 text-xs leading-relaxed">
        （摘要）
        <br />
        1　捕獲1頭につき1枚提出すること
        <br />
        2　<b>捕獲後おおむね3日以内に提出すること</b>。ただし、土日および祝日を除く。
        <br />
        3　捕獲者及び止め刺し者は、館山市有害鳥獣捕獲員に限る。
        <br />
        4　任意の地図に、捕獲場所を朱色×印にて記入すること（
        {hasLocation ? "本票に地図を印字済み" : "別紙添付"}）。
        <br />
        5　市から貸与の箱わなで捕獲した場合、番号札（　）内の数字を記入すること。
        <br />
        6　餌の種類は、箱わなを使用して捕獲した場合に記入すること。
        <br />
        7　<b>添付品: 捕獲獣の尾（1頭分ずつ、ジップロックに封入して提出すること）</b>
      </div>

      <table className="mt-2 w-full border-collapse text-sm">
        <tbody>
          <tr>
            <td className={`${TD} text-center`}>館山有害鳥獣対策協議会</td>
            <th className={`${TH} w-16`}>確認</th>
            <td className={`${TD} w-28`}></td>
          </tr>
        </tbody>
      </table>
    </main>
  );
}
