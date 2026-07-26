import type { HunterMenuIntent } from "./hunter-keywords";

/**
 * 捕獲者へ返す定型文。
 *
 * ルール:
 * - AIが書いた文章は自動送信しない。ここにある定型文だけを即時返信する
 * - 受入の可否や日時を勝手に約束しない（判断は職員）
 * - 高齢の捕獲者が多い。1文を短く、専門用語を使わない
 * - どのメッセージにも必ず返事をする（送りっぱなしにしない）
 */

/** すべての受信に共通の締め。指示書の「受け付けました。担当が確認します」 */
export const ACK_TEXT = "受け付けました。担当が確認します。";

export function captureReportStartReply(templateLines: readonly string[]): string {
  return [
    "捕獲報告をはじめます。",
    "",
    "【写真】2枚、続けて送ってください。",
    "① 尻尾を切る前",
    "② 尻尾を切った後",
    "場所は、LINEの「＋」→「位置情報」で送れます。",
    "",
    "【内容】下の型をコピーして、分かるところだけ埋めて1回で送ってください。",
    "分からない項目は空欄のままで大丈夫です。",
    "",
    ...templateLines,
    "",
    "型が難しければ、今までどおり1つずつ聞くこともできます。",
    "そのまま文章で送っていただいても大丈夫です。",
  ].join("\n");
}

/** 不足している必須項目だけを1通でまとめて聞く */
export function missingFieldsQuestionReply(labels: string[]): string {
  return [
    "ありがとうございます。あと少しだけ教えてください。",
    "",
    ...labels.map((label) => `・${label}`),
    "",
    "分かるところだけで大丈夫です。まとめて1回で送れます。",
    "分からない項目は「わからない」と送ってください。担当者が確認します。",
  ].join("\n");
}

/** すべてそろったので捕獲票のダウンロードリンクを渡す */
export function cityFormReadyReply(url: string): string {
  return [
    "捕獲票ができました。",
    "こちらから印刷／PDF保存できます。",
    url,
    "（30日間有効です）",
    "",
    "印刷したものと、捕獲獣の尾を市役所へご提出ください。",
  ].join("\n");
}

/** そろったが写真がまだのとき */
export function cityFormReadyButPhotosReply(url: string, missingLabels: string[]): string {
  return [
    "捕獲票ができました。",
    url,
    "（30日間有効です）",
    "",
    `写真がまだ届いていません：${missingLabels.join("・")}`,
    "お手すきのときに送ってください。",
  ].join("\n");
}

export function captureReportPhotoSavedReply(): string {
  return [
    "写真を受け取りました。",
    "尻尾を切る前・切った後の2枚をお願いします。まだの分はそのまま送ってください。",
    "内容は、先ほどの型に記入して1回で送っていただけると助かります。",
    ACK_TEXT,
  ].join("\n");
}

export function captureReportLocationSavedReply(): string {
  return ["場所を受け取りました。", ACK_TEXT].join("\n");
}

export function captureReportDetailSavedReply(): string {
  return [
    "内容を受け取りました。",
    "写真がまだの場合は、このまま送ってください。",
  ].join("\n");
}

/** 体重の計測区分をたずねる（下に出るボタンを押すだけで答えられる） */
export function weightKindQuestionReply(): string {
  return [
    "体重について教えてください。",
    "下のボタンから選んでください。",
    "・センターで計量",
    "・処理施設で計量",
    "・だいたいの重さ（推定）",
  ].join("\n");
}

export function weightValueQuestionReply(measureLabel: string): string {
  return [
    `${measureLabel} ですね。`,
    "重さを数字で送ってください。",
    "例：45",
    "分からないときは「わからない」と送ってください。",
  ].join("\n");
}

export function weightSavedReply(description: string): string {
  return [
    `体重 ${description} で受け取りました。`,
    "報告は以上です。担当者が確認して、あらためてご連絡します。",
  ].join("\n");
}

export function weightSkippedReply(): string {
  return [
    "わかりました。体重は担当者が確認します。",
    "報告は以上です。ありがとうございました。",
  ].join("\n");
}

export function weightNotUnderstoodReply(): string {
  return [
    "すみません、数字が読み取れませんでした。",
    "「45」のように数字だけで送ってください。",
    "分からないときは「わからない」と送ってください。",
  ].join("\n");
}

export function deliveryNoticeReply(params: {
  accepting: boolean | null;
  note: string;
}): string {
  const lines = ["搬入のご連絡ありがとうございます。"];
  if (params.accepting === true) {
    lines.push("本日は受け入れできます。");
  } else if (params.accepting === false) {
    lines.push("本日は受け入れを止めています。担当者からご連絡します。");
  } else {
    lines.push("本日の受け入れは担当者が確認します。");
  }
  if (params.note) lines.push(params.note);
  lines.push("到着のおおよその時間を送っていただけると助かります。");
  lines.push(ACK_TEXT);
  return lines.join("\n");
}

/**
 * 受入状況（仕様確定 2026-07-26）: まずは「本日の受入件数」だけを返す。
 * 受入可否の設定があれば一言だけ添える。
 */
export function acceptanceStatusReply(params: {
  todayCount: number;
  accepting: boolean | null;
  note: string;
}): string {
  const lines = [
    "【本日の受入状況】",
    `本日の受入は ${params.todayCount} 件です。`,
  ];
  if (params.accepting === false) {
    lines.push("本日は受け入れを止めています。");
  }
  if (params.note) lines.push(params.note);
  lines.push("搬入されるときは「搬入連絡」を押してください。");
  return lines.join("\n");
}

export interface PaymentSummaryLine {
  captureDate: string | null;
  species: string | null;
  labelId: string | null;
  amount: number | null;
}

/**
 * 買取状況（仕様確定 2026-07-26）: 当面は「準備中」の案内を返す。
 *
 * 買取額は精肉の歩留まりに連動して決まるため、自動でお伝えすると
 * 誤った金額を伝える恐れがある。金額の自動配信ができるようになるまでは
 * 案内だけを返し、問い合わせ自体は職員一覧に残して人が対応する。
 */
export function paymentStatusReply(): string {
  return [
    "【買取状況】",
    "この機能は準備中です。",
    "お急ぎの場合は職員が確認してご連絡します。このままお待ちください。",
    "お電話でのお問い合わせは、下のメニューの「電話」からお願いします。",
  ].join("\n");
}

/**
 * 使い方（仕様確定 2026-07-26）: 短い説明 + 説明ページへのリンク。
 * ページはログイン不要・大きい文字（/guide）。
 */
export function helpReply(guideUrl: string): string {
  const lines = [
    "【館山ジビエセンター LINEの使い方】",
    "下のメニューを押すだけで手続きができます。",
    "・捕獲報告：写真と場所を送って報告できます",
    "・搬入連絡：これから持ち込むときに押してください",
    "・受入状況：本日の受入件数をお知らせします",
    "・買取状況：準備中です",
    "・電話：センターに直接つながります",
  ];
  if (guideUrl) {
    lines.push("");
    lines.push("くわしい使い方はこちら（文字が大きい説明ページ）");
    lines.push(guideUrl);
  }
  lines.push("文章をそのまま送っていただいても大丈夫です。担当者が読みます。");
  return lines.join("\n");
}

/**
 * 初回の案内（B案 / 2026-07-26 確定）。
 * 口座番号はLINEで受け取らない。登録済みの人には入力を求めない。
 */
export function askNameReply(): string {
  return [
    "ご連絡ありがとうございます。",
    "はじめてのご連絡のため、まだお名前が分かりません。",
    "お手数ですが、お名前（フルネーム）を送ってください。",
    "",
    "すでにセンターに登録がある方は、お名前だけで大丈夫です。",
    "住所や生年月日などをあらためて送っていただく必要はありません。",
    "",
    "口座番号は、安全のためLINEでは送らないでください。",
    "必要なときは担当者からお電話でご連絡します。",
  ].join("\n");
}

/** メニュー以外の自由文への返事 */
export function freeTextReply(): string {
  return [ACK_TEXT, "お急ぎのときは、下のメニューの「電話」からご連絡ください。"].join("\n");
}

export const MENU_REPLY_BUILDERS: Record<HunterMenuIntent, string> = {
  capture_report: "captureReportStartReply",
  delivery_notice: "deliveryNoticeReply",
  acceptance_status: "acceptanceStatusReply",
  payment_status: "paymentStatusReply",
  help: "helpReply",
};
