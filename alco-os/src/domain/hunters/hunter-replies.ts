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

export function captureReportStartReply(): string {
  return [
    "捕獲報告をはじめます。",
    "まず、獲物の写真を送ってください。",
    "そのあとに、獣種・捕獲方法・場所を文章で送っていただけると助かります。",
    "位置情報（LINEの「＋」→「位置情報」）も送れます。",
  ].join("\n");
}

export function captureReportPhotoSavedReply(): string {
  return [
    "写真を受け取りました。",
    "続けて、獣種（イノシシ・シカなど）と捕獲方法（くくり罠・箱罠・銃猟）を送ってください。",
    ACK_TEXT,
  ].join("\n");
}

export function captureReportLocationSavedReply(): string {
  return ["場所を受け取りました。", ACK_TEXT].join("\n");
}

export function captureReportDetailSavedReply(): string {
  return [
    "内容を受け取りました。",
    "担当者が確認して、あらためてご連絡します。",
    "写真がまだの場合は、このまま送ってください。",
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

export function acceptanceStatusReply(params: {
  accepting: boolean | null;
  note: string;
}): string {
  const lines = ["【本日の受け入れ】"];
  if (params.accepting === true) {
    lines.push("受け入れできます。");
  } else if (params.accepting === false) {
    lines.push("本日は受け入れを止めています。");
  } else {
    lines.push("まだ設定されていません。担当者が確認します。");
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

export function paymentStatusReply(params: {
  linked: boolean;
  hunterName?: string;
  rows: PaymentSummaryLine[];
}): string {
  if (!params.linked) {
    return [
      "買取のご確認ですね。",
      "まだお名前の確認ができていないため、金額をお伝えできません。",
      "お名前（フルネーム）を送ってください。担当者が確認します。",
    ].join("\n");
  }
  if (params.rows.length === 0) {
    return [
      `【${params.hunterName ?? "お客様"}さまの買取状況】`,
      "直近の記録が見つかりませんでした。",
      "担当者が確認しますので、少しお待ちください。",
    ].join("\n");
  }
  const lines = [`【${params.hunterName ?? "お客様"}さまの直近の買取】`];
  for (const row of params.rows) {
    const date = row.captureDate ?? "日付不明";
    const species = row.species ?? "獣種不明";
    const amount =
      row.amount === null ? "金額はまだ確定していません" : `${row.amount.toLocaleString()}円`;
    lines.push(`・${date} ${species}：${amount}`);
  }
  lines.push("金額のご質問は担当者が確認します。");
  return lines.join("\n");
}

export function helpReply(): string {
  return [
    "【館山ジビエセンター LINEの使い方】",
    "下のメニューを押してください。",
    "・捕獲報告：写真と場所を送って報告できます",
    "・搬入連絡：これから持ち込むときに押してください",
    "・受入状況：今日受け入れできるかが分かります",
    "・買取状況：直近の買取をお知らせします",
    "・使い方：この案内が出ます",
    "・電話：センターに直接つながります",
    "文章をそのまま送っていただいても大丈夫です。担当者が読みます。",
  ].join("\n");
}

export function askNameReply(): string {
  return [
    "ご連絡ありがとうございます。",
    "はじめてのご連絡のため、まだお名前が分かりません。",
    "お手数ですが、お名前（フルネーム）を送ってください。",
    "担当者が確認して、あらためてご連絡します。",
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
