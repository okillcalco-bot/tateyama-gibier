import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, EmptyState } from "@/components/ui";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getAcceptanceStatus } from "@/domain/hunters/gibier-status-service";
import { CAPTURE_REPORT_STATUS_LABELS } from "@/domain/hunters/capture-report-service";
import { maskObservationPoint } from "@/domain/satoyama/geo-masking";
import { PHOTO_KIND_LABELS, toReportPhoto } from "@/domain/hunters/capture-photo-service";
import { missingCityFormPhotos } from "@/domain/hunters/capture-photo-service";
import { AcceptanceStatusForm, ApproveReportForm, PhotoKindForm } from "./report-forms";

export const dynamic = "force-dynamic";

/**
 * 捕獲報告の確認（職員用）。
 *
 * LINEで届いた捕獲報告を職員が確認し、承認すると individuals に
 * 「搬入待ち」の仮登録が作られる（既存の捕獲者フォームと同じ形）。
 *
 * 位置情報について:
 *   捕獲地点は docs/10 で sensitive 相当。座標を画面に出すのは業務上必要な
 *   職員だけなので、必ず maskObservationPoint() を通してから表示する。
 *   CSV等への書き出しは行わない。
 */

interface ReportRow {
  id: string;
  hunter_id: string | null;
  species: string | null;
  capture_method: string | null;
  capture_date: string | null;
  capture_lat: number | null;
  capture_lng: number | null;
  photo_file_id: string | null;
  raw_text: string | null;
  ai_suggestion: Record<string, unknown> | null;
  status: string;
  individual_id: string | null;
  created_at: string;
}

function formatDateTime(value: string): string {
  const d = new Date(value);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

function suggestionText(suggestion: Record<string, unknown> | null, key: string): string {
  const value = suggestion?.[key];
  return typeof value === "string" ? value : "";
}

export default async function CaptureReportsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="捕獲報告の確認" description="LINEで届いた捕獲報告" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const db = new SupabaseDb(supabase);

  const [reportsResult, huntersResult, acceptance] = await Promise.all([
    supabase
      .from("capture_reports")
      .select(
        "id, hunter_id, species, capture_method, capture_date, capture_lat, capture_lng, photo_file_id, raw_text, ai_suggestion, status, individual_id, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("hunters").select("id, name").is("deleted_at", null).limit(500),
    getAcceptanceStatus(db),
  ]);

  const reports = (reportsResult.data ?? []) as ReportRow[];
  const hunterNameById = new Map(
    ((huntersResult.data ?? []) as { id: string; name: string }[]).map((h) => [h.id, h.name]),
  );

  // 種別つきの写真一覧（0024）
  const { data: photoRows } = await supabase
    .from("capture_report_photos")
    .select("id, capture_report_id, file_id, photo_kind, sort_order")
    .in(
      "capture_report_id",
      reports.length > 0 ? reports.map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"],
    );
  const photosByReport = new Map<string, ReturnType<typeof toReportPhoto>[]>();
  for (const row of photoRows ?? []) {
    const key = String(row.capture_report_id);
    const list = photosByReport.get(key) ?? [];
    list.push(toReportPhoto(row as Record<string, unknown>));
    photosByReport.set(key, list);
  }

  // 写真は非公開バケット。都度の署名URLで表示する（URLは1時間で失効）
  const fileIds = [
    ...reports.map((r) => r.photo_file_id).filter((v): v is string => Boolean(v)),
    ...(photoRows ?? []).map((row) => String(row.file_id)),
  ];
  const photoUrlByFileId = new Map<string, string>();
  if (fileIds.length > 0) {
    const { data: files } = await supabase
      .from("files")
      .select("id, bucket, path")
      .in("id", fileIds);
    for (const file of files ?? []) {
      const { data: signed } = await supabase.storage
        .from(file.bucket as string)
        .createSignedUrl(file.path as string, 3600);
      if (signed?.signedUrl) photoUrlByFileId.set(file.id as string, signed.signedUrl);
    }
  }

  const pending = reports.filter((r) => r.status === "pending");
  const handled = reports.filter((r) => r.status !== "pending");
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title="捕獲報告の確認"
        description="LINEで届いた捕獲報告を確認して、個体（搬入待ち）に登録します。"
      />

      <div className="space-y-6">
        <section>
          <h2 className="mb-2 text-lg font-bold text-stone-800">本日の受け入れ</h2>
          <p className="mb-2 text-base text-stone-600">
            ここで選んだ内容が、捕獲者の「受入状況」ボタンの答えになります。
          </p>
          <Card>
            <AcceptanceStatusForm accepting={acceptance.accepting} note={acceptance.note} />
          </Card>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-bold text-stone-800">
            確認まちの報告（{pending.length}件）
          </h2>
          {pending.length === 0 ? (
            <EmptyState message="確認まちの捕獲報告はありません。" />
          ) : (
            <div className="space-y-3">
              {pending.map((report) => {
                const hunterName = report.hunter_id
                  ? (hunterNameById.get(report.hunter_id) ?? "")
                  : "";
                // 捕獲地点は sensitive 相当。業務権限（restricted）として扱う
                const point = maskObservationPoint(
                  {
                    lat: report.capture_lat,
                    lng: report.capture_lng,
                    sensitivity: "sensitive",
                  },
                  "restricted",
                );
                const photoUrl = report.photo_file_id
                  ? photoUrlByFileId.get(report.photo_file_id)
                  : undefined;

                return (
                  <Card key={report.id}>
                    <p className="text-sm text-stone-500">{formatDateTime(report.created_at)}</p>
                    <p className="mt-1 text-base font-bold text-stone-800">
                      <span aria-hidden="true">●</span>{" "}
                      {CAPTURE_REPORT_STATUS_LABELS.pending}／捕獲者：
                      {hunterName || "まだ確認できていません"}
                    </p>

                    {(() => {
                      const photos = photosByReport.get(report.id) ?? [];
                      if (photos.length === 0) {
                        return photoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={photoUrl}
                            alt="捕獲者から届いた写真"
                            className="mt-2 w-full rounded-xl border border-stone-200"
                          />
                        ) : (
                          <p className="mt-2 text-base text-stone-600">
                            写真はまだ届いていません。
                          </p>
                        );
                      }
                      const missing = missingCityFormPhotos(photos);
                      return (
                        <div className="mt-2 space-y-3">
                          {photos.map((photo) => {
                            const url = photoUrlByFileId.get(photo.fileId);
                            return (
                              <div key={photo.id} className="rounded-xl border border-stone-200 p-2">
                                {url ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={url}
                                    alt={PHOTO_KIND_LABELS[photo.photoKind]}
                                    className="w-full rounded-lg"
                                  />
                                ) : (
                                  <p className="text-base text-stone-600">
                                    写真を読み込めませんでした。
                                  </p>
                                )}
                                <PhotoKindForm photoId={photo.id} photoKind={photo.photoKind} />
                              </div>
                            );
                          })}
                          {missing.length > 0 ? (
                            <p className="rounded-xl bg-amber-50 p-3 text-base font-bold text-amber-900">
                              ⚠ 市役所提出に足りない写真：
                              {missing.map((kind) => PHOTO_KIND_LABELS[kind]).join("・")}
                            </p>
                          ) : null}
                        </div>
                      );
                    })()}

                    {report.raw_text ? (
                      <p className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-stone-50 p-3 text-base text-stone-800">
                        {report.raw_text}
                      </p>
                    ) : null}

                    {report.ai_suggestion ? (
                      <p className="mt-2 text-base text-stone-700">
                        <span aria-hidden="true">▶</span> AIの読み取り（下書き）：
                        {suggestionText(report.ai_suggestion, "species") || "獣種は不明"} ／
                        {suggestionText(report.ai_suggestion, "capture_method") || "方法は不明"}
                      </p>
                    ) : null}

                    {point.hidden || point.lat === null ? (
                      <p className="mt-2 text-base text-stone-600">場所は届いていません。</p>
                    ) : (
                      <p className="mt-2 rounded-xl bg-amber-50 p-3 text-base text-amber-900">
                        <span aria-hidden="true">⚠</span> 捕獲場所：{point.lat.toFixed(5)},{" "}
                        {point.lng?.toFixed(5)}（{point.precisionLabel}）
                        <br />
                        この場所は外部に出せません。地図や座標をSNS・メール・書類に貼らないでください。
                      </p>
                    )}

                    <ApproveReportForm
                      reportId={report.id}
                      hunterName={hunterName}
                      defaultSpecies={
                        report.species || suggestionText(report.ai_suggestion, "species")
                      }
                      defaultMethod={
                        report.capture_method ||
                        suggestionText(report.ai_suggestion, "capture_method")
                      }
                      defaultDate={report.capture_date || today}
                    />
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        {handled.length > 0 ? (
          <section>
            <h2 className="mb-2 text-lg font-bold text-stone-800">処理ずみ（{handled.length}件）</h2>
            <div className="space-y-3">
              {handled.map((report) => (
                <Card key={report.id}>
                  <p className="text-sm text-stone-500">{formatDateTime(report.created_at)}</p>
                  <p className="mt-1 text-base font-bold text-stone-800">
                    <span aria-hidden="true">{report.status === "accepted" ? "✓" : "✕"}</span>{" "}
                    {CAPTURE_REPORT_STATUS_LABELS[
                      report.status as keyof typeof CAPTURE_REPORT_STATUS_LABELS
                    ] ?? report.status}
                    ／{report.species ?? "獣種不明"}
                  </p>
                  {report.individual_id ? (
                    <>
                      <p className="mt-1 text-base text-stone-600">
                        個体を作成しました。個体番号は現場アプリ（受入）で付けてください。
                      </p>
                      <a
                        href={`/gibier/reports/${report.id}/pack`}
                        className="mt-3 inline-flex min-h-[56px] w-full items-center justify-center rounded-xl bg-green-700 px-4 text-base font-bold text-white"
                      >
                        🏛 市役所提出パックを開く
                      </a>
                    </>
                  ) : null}
                </Card>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
