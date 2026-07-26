/**
 * 市役所への提出メール（要望・2026-07-26）。
 *
 * 宛先は館山市役所 農水産課。件名・本文をあらかじめ入れた mailto: を作り、
 * 捕獲者本人・職員のどちらでも「メールを開く → PDFを添付 → 送信」で済むようにする。
 *
 * PDF本体は添付できない（mailto: の仕様）。先にPDFを保存してもらい、
 * メール画面で添付する導線にする。
 */

export const CITY_MAIL_TO = "nousuisanka@city.tateyama.chiba.jp";

export interface CityMailParams {
  hunterName: string;
  captureDate: string | null;
  species: string | null;
  labelId: string | null;
  /** 送信者の立場。職員が代行するときは差出人の説明を変える */
  sender: "hunter" | "staff";
}

export function buildCityMailSubject(params: CityMailParams): string {
  const date = params.captureDate ? params.captureDate.replace(/-/g, "/") : "";
  const species = params.species ?? "";
  return `有害鳥獣捕獲票の提出（${params.hunterName}${date ? `／${date}` : ""}${
    species ? `／${species}` : ""
  }）`;
}

export function buildCityMailBody(params: CityMailParams): string {
  const lines = [
    "館山市役所 農水産課 御中",
    "",
    "いつもお世話になっております。",
    params.sender === "staff"
      ? `館山ジビエセンター（合同会社アルコ）です。捕獲者 ${params.hunterName} 様に代わり、有害鳥獣捕獲票を提出します。`
      : `${params.hunterName} です。有害鳥獣捕獲票を提出します。`,
    "",
    "【捕獲の内容】",
    `・捕獲者：${params.hunterName}`,
    `・捕獲年月日：${params.captureDate ?? "（記載のとおり）"}`,
    `・獣種：${params.species ?? "（記載のとおり）"}`,
    params.labelId ? `・個体番号：${params.labelId}` : "",
    "",
    "【添付】",
    "・有害鳥獣捕獲票（捕獲場所の図面つき）",
    "・捕獲個体の写真（全体／尻尾切除前／尻尾切除後）",
    "",
    "※ このメールにPDFを添付してから送信してください。",
    "※ 捕獲獣の尾は、これまでどおり別途ご提出ください。",
    "",
    "よろしくお願いいたします。",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/** mailto: リンク。本文が長いと一部のメーラーで切れるため簡潔に保つ */
export function buildCityMailtoUrl(params: CityMailParams): string {
  const subject = encodeURIComponent(buildCityMailSubject(params));
  const body = encodeURIComponent(buildCityMailBody(params));
  return `mailto:${CITY_MAIL_TO}?subject=${subject}&body=${body}`;
}
