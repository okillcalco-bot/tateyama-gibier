import type { DbPort } from "@/lib/db/port";
import {
  missingCityFormPhotos,
  orderForCityForm,
  toReportPhoto,
  type ReportPhoto,
} from "./capture-photo-service";

/**
 * 市役所提出パック（要望3）。
 *
 * 提出物は3点:
 *   ① 有害鳥獣捕獲票 … **既存実装をそのまま使う**
 *      （capture-form.html?cityform=<label_id>。館山有害鳥獣対策協議会様式）
 *   ② 捕獲場所の図面（朱色×印） … ①の中に既に印字される
 *   ③ 尻尾切除前後を含む写真 … ALCO OS 側で台紙にして印刷する（新規）
 *
 * ①②を作り直さないのが原則。ALCO OS は「①へのリンク」と「③の台紙」を出す。
 */

/** 既存アプリの捕獲票URL。個体番号（label_id）で開く */
export function buildCityFormUrl(gibierAppUrl: string, labelId: string): string {
  if (!gibierAppUrl || !labelId) return "";
  return `${gibierAppUrl}/capture-form.html?cityform=${encodeURIComponent(labelId)}`;
}

export interface CityFormReadiness {
  /** 個体化されているか（捕獲票は individuals の行から作られる） */
  hasIndividual: boolean;
  /** 捕獲場所の座標があるか（図面の×印に必要） */
  hasLocation: boolean;
  /** 提出に必要な写真のうち、まだ無い種別 */
  missingPhotos: ReturnType<typeof missingCityFormPhotos>;
  /** 台紙に並べる写真（全体 → 切る前 → 切った後 → その他） */
  photos: ReportPhoto[];
}

/**
 * 提出パックが作れる状態かを判定する。
 * 足りないものは画面で職員に伝える（勝手に補完しない）。
 */
export async function getCityFormReadiness(
  db: DbPort,
  captureReportId: string,
): Promise<CityFormReadiness> {
  const report = await db.findById("capture_reports", captureReportId);
  const rows = await db.findMany(
    "capture_report_photos",
    { capture_report_id: captureReportId },
    50,
  );
  const photos = rows.map(toReportPhoto);

  return {
    hasIndividual: Boolean(report?.individual_id),
    hasLocation: report?.capture_lat !== null && report?.capture_lat !== undefined,
    missingPhotos: missingCityFormPhotos(photos),
    photos: orderForCityForm(photos),
  };
}
