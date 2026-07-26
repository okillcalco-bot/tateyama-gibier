import { notFound } from "next/navigation";
import { isSupabaseConfigured, env } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SetupNotice } from "@/components/ui";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCityFormReadiness, buildCityFormUrl } from "@/domain/hunters/city-form-service";
import { PHOTO_KIND_LABELS } from "@/domain/hunters/capture-photo-service";
import { describeWeight } from "@/domain/hunters/weight-service";
import { buildCityMailtoUrl, CITY_MAIL_TO } from "@/domain/hunters/city-mail-service";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

/**
 * 市役所提出パック（写真台紙）。要望3。
 *
 * 有害鳥獣捕獲票と捕獲場所の図面（朱色×印）は**既存アプリの実装をそのまま使う**
 * （capture-form.html?cityform=）。ここで作るのは既存に無い「写真台紙」だけ。
 *
 * 位置情報について:
 *   市役所提出は正当な用途。既存の捕獲票は緯度経度をそのまま印字する流儀なので、
 *   この台紙も同じ扱いにする（マスキングしない）。ただし提出以外に使わないよう
 *   注意書きを必ず紙面に入れる（docs/10）。
 */

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CityFormPackPage({ params }: PageProps) {
  const { id } = await params;

  if (!isSupabaseConfigured()) return <SetupNotice />;

  const supabase = await createSupabaseServerClient();
  const db = new SupabaseDb(supabase);

  const { data: report } = await supabase
    .from("capture_reports")
    .select(
      "id, hunter_id, species, capture_method, capture_date, capture_lat, capture_lng, individual_id, status, weight_kg, weight_measure",
    )
    .eq("id", id)
    .maybeSingle();
  if (!report) notFound();

  const readiness = await getCityFormReadiness(db, id);

  const [{ data: hunter }, { data: individual }] = await Promise.all([
    report.hunter_id
      ? supabase.from("hunters").select("name").eq("id", report.hunter_id).maybeSingle()
      : Promise.resolve({ data: null }),
    report.individual_id
      ? supabase
          .from("individuals")
          .select("label_id, serial_number")
          .eq("id", report.individual_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // 非公開バケットのため、印刷用に都度の署名URLを発行する
  const photoUrls = new Map<string, string>();
  if (readiness.photos.length > 0) {
    const { data: files } = await supabase
      .from("files")
      .select("id, bucket, path")
      .in(
        "id",
        readiness.photos.map((p) => p.fileId),
      );
    for (const file of files ?? []) {
      const { data: signed } = await supabase.storage
        .from(file.bucket as string)
        .createSignedUrl(file.path as string, 3600);
      if (signed?.signedUrl) photoUrls.set(file.id as string, signed.signedUrl);
    }
  }

  const labelId = (individual?.label_id as string | undefined) ?? "";
  const cityFormUrl = buildCityFormUrl(env.gibierAppUrl, labelId);
  const hunterName = (hunter?.name as string | undefined) ?? "";
  const weightText = describeWeight(
    report.weight_kg as number | null,
    report.weight_measure as string | null,
  );
  const isEstimated = report.weight_measure === "estimated";
  const mailParams = {
    hunterName: hunterName || "捕獲者",
    captureDate: (report.capture_date as string | null) ?? null,
    species: (report.species as string | null) ?? null,
    labelId: labelId || null,
    sender: "staff" as const,
  };
  const staffMailUrl = buildCityMailtoUrl(mailParams);
  const hunterMailUrl = buildCityMailtoUrl({ ...mailParams, sender: "hunter" });

  return (
    <main className="mx-auto max-w-[760px] bg-white p-6 text-stone-900 print:p-0">
      <style>{`
        @page { size: A4 portrait; margin: 12mm; }
        @media print {
          .no-print { display: none !important; }
          body { background: #fff; }
          figure { break-inside: avoid; page-break-inside: avoid; }
          img { max-height: 110mm; object-fit: contain; }
        }
      `}</style>

      <div className="no-print mb-4 flex flex-wrap gap-3 rounded-xl bg-stone-100 p-4">
        <PrintButton />
        {cityFormUrl ? (
          <a
            href={cityFormUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-[56px] items-center rounded-xl bg-green-700 px-5 text-base font-bold text-white"
          >
            🏛 有害鳥獣捕獲票と図面を開く（現場アプリ）
          </a>
        ) : (
          <p className="text-base text-stone-700">
            捕獲票は現場アプリの「個体一覧 → 🏛 市役所票」から印刷してください。
            {labelId ? `（個体番号：${labelId}）` : ""}
          </p>
        )}
        <a
          href="/gibier/reports"
          className="inline-flex min-h-[56px] items-center rounded-xl border-2 border-stone-400 px-5 text-base font-bold text-stone-700"
        >
          ← 捕獲報告の一覧へ
        </a>
      </div>

      <div className="no-print mb-4 rounded-xl border-2 border-green-700 bg-green-50 p-4">
        <p className="text-lg font-bold text-green-900">市役所へメールで提出する</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-base text-stone-800">
          <li>上の「🖨 印刷 / PDF保存」で、この台紙をPDFとして保存します。</li>
          <li>捕獲票（と図面）も同じようにPDFで保存します。</li>
          <li>下のボタンでメールを開き、保存したPDFを添付して送信します。</li>
        </ol>
        <p className="mt-2 text-base text-stone-700">
          宛先：{CITY_MAIL_TO}（館山市役所 農水産課）
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <a
            href={staffMailUrl}
            className="inline-flex min-h-[56px] items-center justify-center rounded-xl bg-green-700 px-5 text-base font-bold text-white"
          >
            ✉ センターが代わりに送るメールを開く
          </a>
          <a
            href={hunterMailUrl}
            className="inline-flex min-h-[56px] items-center justify-center rounded-xl border-2 border-green-700 bg-white px-5 text-base font-bold text-green-800"
          >
            ✉ 捕獲者ご本人が送る文面でメールを開く
          </a>
        </div>
        <p className="mt-2 text-sm text-stone-600">
          メールに添付できるのは保存したPDFです。捕獲獣の尾は、これまでどおり別途ご提出ください。
        </p>
      </div>

      {readiness.missingPhotos.length > 0 ? (
        <p className="no-print mb-4 rounded-xl bg-amber-50 p-4 text-base font-bold text-amber-900">
          ⚠ 写真が足りません：
          {readiness.missingPhotos.map((kind) => PHOTO_KIND_LABELS[kind]).join("・")}
          <br />
          捕獲報告の画面で写真の種別を選ぶか、捕獲者に追加の写真をお願いしてください。
        </p>
      ) : null}

      <h1 className="text-2xl font-bold">捕獲個体 写真台紙</h1>
      <p className="mt-1 text-base">有害鳥獣捕獲票 添付書類</p>

      <table className="mt-4 w-full border-collapse text-base">
        <tbody>
          <tr>
            <th className="w-32 border border-stone-800 bg-stone-100 p-2 text-left">捕獲者</th>
            <td className="border border-stone-800 p-2">{hunter?.name ?? ""}</td>
            <th className="w-32 border border-stone-800 bg-stone-100 p-2 text-left">個体番号</th>
            <td className="border border-stone-800 p-2">{labelId || "（未採番）"}</td>
          </tr>
          <tr>
            <th className="border border-stone-800 bg-stone-100 p-2 text-left">捕獲年月日</th>
            <td className="border border-stone-800 p-2">{report.capture_date ?? ""}</td>
            <th className="border border-stone-800 bg-stone-100 p-2 text-left">獣種・方法</th>
            <td className="border border-stone-800 p-2">
              {report.species ?? ""} {report.capture_method ? `／${report.capture_method}` : ""}
            </td>
          </tr>
          <tr>
            <th className="border border-stone-800 bg-stone-100 p-2 text-left">体重</th>
            <td className="border border-stone-800 p-2" colSpan={3}>
              {weightText}
              {isEstimated ? (
                <strong>　※ 計量しておらず、推定値です</strong>
              ) : null}
            </td>
          </tr>
          <tr>
            <th className="border border-stone-800 bg-stone-100 p-2 text-left">捕獲場所</th>
            <td className="border border-stone-800 p-2" colSpan={3}>
              {report.capture_lat && report.capture_lng
                ? `緯度 ${Number(report.capture_lat).toFixed(5)} / 経度 ${Number(
                    report.capture_lng,
                  ).toFixed(5)}（図面は捕獲票に印字）`
                : "位置情報なし（図面は別紙）"}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="mt-5 space-y-5">
        {readiness.photos.length === 0 ? (
          <p className="rounded-xl border-2 border-dashed border-stone-400 p-8 text-center text-base">
            写真がまだ登録されていません。
          </p>
        ) : (
          readiness.photos.map((photo) => {
            const url = photoUrls.get(photo.fileId);
            return (
              <figure
                key={photo.id}
                className="break-inside-avoid rounded-xl border border-stone-800 p-3"
              >
                <figcaption className="mb-2 text-lg font-bold">
                  {PHOTO_KIND_LABELS[photo.photoKind]}
                </figcaption>
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt={PHOTO_KIND_LABELS[photo.photoKind]} className="w-full" />
                ) : (
                  <p className="text-base">写真を読み込めませんでした。</p>
                )}
              </figure>
            );
          })
        )}
      </div>

      <p className="mt-6 border-t border-stone-400 pt-3 text-sm">
        館山ジビエセンター（合同会社アルコ）／ この台紙は市役所提出以外の目的に使用しないでください。
        捕獲場所は公開しないでください。
      </p>
    </main>
  );
}
