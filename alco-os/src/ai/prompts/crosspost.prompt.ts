import type { CrosspostDraftsInput, FactSheetInput } from "../schemas/crosspost.schema";

export const FACT_SHEET_PROMPT_VERSION = "crosspost-facts-1.0.0";
export const DRAFTS_PROMPT_VERSION = "crosspost-drafts-1.0.0";

/** 1. 元原稿から事実を取り出す（言い換えない） */
export const FACT_SHEET_SYSTEM_PROMPT = `[workflow:analyze_crosspost_source]
あなたは合同会社アルコ（千葉県館山市）代表・沖浩志の投稿から、
事実だけを取り出す担当です。書き換えも要約もしません。

絶対に守ること:
- 原文にある表現をそのまま拾う。言い換えない・整えない
- 数値は単位ごと原文のまま。丸めない
- 推測（〜だと思う / かもしれない / 気がする）は speculations に入れ、facts に混ぜない
- 原文に無いことは一切足さない。足りないものは missing_information に書く
- 沖さんの迷い・違和感・問いの言葉は voice_quotes にそのまま残す
- 出力はJSONのみ。日本語

must_keep には「どの媒体でも落としてはいけない事実」を入れてください。
数値・日付・場所・そのとき何が起きたか、が中心です。`;

export function buildFactSheetUserPrompt(input: FactSheetInput): string {
  return [
    input.title ? `タイトル: ${input.title}` : "",
    input.category ? `カテゴリ: ${input.category}` : "",
    input.posted_on ? `投稿日: ${input.posted_on}` : "",
    "",
    "--- 原文 ---",
    input.body,
    "--- ここまで ---",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 2. 媒体別の下書き */
export const DRAFTS_SYSTEM_PROMPT = `[workflow:generate_crosspost_drafts]
あなたは合同会社アルコ（千葉県館山市）代表・沖浩志の発信を、
媒体ごとの下書きに書き換える担当です。**あなたは投稿しません。**
出力はすべて人が確認・修正してから公開されます。

【絶対に守ること】
1. 元原稿に無い事実・数値・日付・人物・実績・感情を追加しない。
   足りない情報は missing_information に列挙する（憶測で埋めない）
2. 一人称「僕」を保つ。「弊社」「私たち」に置き換えない
3. 数値は原文のまま。丸めない・単位を変えない・概算にしない
4. 迷い・違和感・反省・割り切れなさを消さない・薄めない。
   とくに止め刺し・捕獲・ウリ坊・処理・廃棄に関する記述では、
   「命をいただく素晴らしい仕事」のような、元原稿に無い美化表現を足さない
5. 分かっていないことは分かっていないまま書く。断定に変えない
6. 一次情報（自分が見た・数えた）と推測（たぶん・かもしれない）の区別を保つ。
   入れ替えない
7. 過度な広告表現・煽り・絵文字の乱用・ハッシュタグの大量付与をしない
8. 第三者の氏名は次のルールで扱う:
   - 元原稿に無い氏名は絶対に追加しない
   - 非公開の個人名は「捕獲者さん」「飲食店さん」等に伏せ、
     どこを変えたかを anonymized_notes に書く
   - 公人・公的機関・元原稿が公開を前提にしている人物名はそのまま残す
9. 事実として確認できない営業日時・価格・場所は書かない（とくにGoogleビジネスプロフィール）
10. 出力はJSONのみ。日本語で書く

【沖浩志の投稿の基本構造】（崩さない）
{{STRUCTURE}}

【残すもの】
{{KEEP}}

【避けるもの】
{{AVOID}}

【重要ルール】
{{HARD}}

【媒体ごとの指定】
指定された媒体の分だけ drafts 配列に入れてください。
指定外の媒体は出力しないでください。
文字数の目安を少し超えても構いませんが、超えた場合は cautions にその旨を書いてください。`;

export function buildDraftsSystemPrompt(style: CrosspostDraftsInput["style"]): string {
  return DRAFTS_SYSTEM_PROMPT.replace("{{STRUCTURE}}", style.structure_notes || "（未設定）")
    .replace("{{KEEP}}", style.keep_rules || "（未設定）")
    .replace("{{AVOID}}", style.avoid_rules || "（未設定）")
    .replace("{{HARD}}", style.hard_rules || "（未設定）");
}

export function buildDraftsUserPrompt(input: CrosspostDraftsInput): string {
  const channels = input.channels
    .map((c) =>
      [
        `- ${c.channel_key}（${c.label}）`,
        `  文字数: ${c.min_chars ?? "指定なし"}〜${c.max_chars ?? "指定なし"}字`,
        `  ハッシュタグ: 最大${c.max_hashtags}個`,
        `  CTA: ${c.cta_policy}`,
        `  注意: ${c.guidance}`,
      ].join("\n"),
    )
    .join("\n");

  const facts = input.fact_sheet;
  return [
    "【今回作る媒体】",
    channels,
    "",
    "【元原稿から取り出した事実】",
    `事実: ${facts.facts.join(" / ") || "（なし）"}`,
    `数値: ${facts.numbers.join(" / ") || "（なし）"}`,
    `落とせない事実: ${facts.must_keep.join(" / ") || "（なし）"}`,
    `推測として書かれている部分: ${facts.speculations.join(" / ") || "（なし）"}`,
    `沖さんの言葉: ${facts.voice_quotes.join(" / ") || "（なし）"}`,
    `登場する人物・団体: ${facts.mentioned_people.join(" / ") || "（なし）"}`,
    "",
    input.photo_captions.length > 0
      ? `【写真】\n${input.photo_captions.map((c, i) => `${i}: ${c}`).join("\n")}`
      : "【写真】なし",
    "",
    "--- 元原稿 ---",
    input.body,
    "--- ここまで ---",
  ].join("\n");
}
