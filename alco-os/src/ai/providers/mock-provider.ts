import type { AiProvider, CompletionRequest, CompletionResult } from "../types";

/**
 * モックプロバイダ。
 * - APIキーなしでの開発・デモ
 * - ユニットテスト
 * で使用する。ワークフロー名をシステムプロンプト中のマーカーで判別し、
 * Zodスキーマに適合する固定レスポンスを返す。
 */
export class MockProvider implements AiProvider {
  readonly name = "mock";

  /** テストから任意の応答を差し込めるようにする */
  constructor(private cannedResponses: Record<string, string> = {}) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const workflowMatch = req.system.match(/\[workflow:([a-z_-]+)\]/);
    const workflow = workflowMatch?.[1] ?? "unknown";

    const canned = this.cannedResponses[workflow] ?? DEFAULT_RESPONSES[workflow];
    if (!canned) {
      throw new Error(`MockProvider: no canned response for workflow "${workflow}"`);
    }
    return { text: canned, inputTokens: 100, outputTokens: 200 };
  }
}

const DEFAULT_RESPONSES: Record<string, string> = {
  classify_voice_memo: JSON.stringify({
    summary: "湿地でアカガエル卵塊3つを確認。草刈りは竹の伸びた南側を優先。田中氏へ補助金の件で金曜までに連絡。",
    detected_category: "task",
    suggested_tasks: [
      { title: "サンプル商事 田中さんへ補助金の件で連絡", due_date: null, priority: "high" },
      { title: "南側の竹エリアの草刈りを優先する", due_date: null, priority: "normal" },
    ],
    nature_records: [
      { species_name: "ニホンアカガエル", note: "卵塊3つを湿地北側で確認" },
    ],
    generated_draft: "【現場記録】湿地北側にてニホンアカガエルの卵塊3つを確認。",
    confidence: 0.85,
    needs_human_review: true,
    warnings: [],
  }),
  generate_grant_draft: JSON.stringify({
    outline: ["事業概要", "実施体制", "経費計画", "スケジュール", "期待される効果"],
    draft_text: "【ドラフト】本事業は…（モック出力。実データに基づく記載はここに生成される）",
    missing_information: ["見積書2社以上", "直近の決算数値"],
    risk_notes: ["締切まで要件充足の確認が必要"],
    reviewer_checklist: ["数字の根拠資料を確認", "要件との対応を確認", "文体・様式の指定を確認"],
  }),
  generate_nature_report: JSON.stringify({
    summary: "対象地では両生類・猛禽類の生息が確認されており、湿地環境の保全価値が高い。",
    ecological_value: "湿地・雑木林のモザイク環境により多様な生物相を支えている。",
    current_issues: "竹林の拡大による植生の単純化が進行している。",
    management_summary: "定期的な草刈りと竹林整備を実施中。",
    evidence_refs: [],
    missing_evidence: ["植物相の調査記録", "冬季の鳥類調査"],
    draft_proposal_text: "【提案ドラフト】自然共生サイト認証に向け…（モック出力）",
  }),
  generate_presentation: JSON.stringify({
    title: "里山からはじまる地域の未来（モック）",
    subtitle: "合同会社アルコ 沖浩志",
    total_minutes: 15,
    slides: [
      {
        title: "皆さんの地域にも「宝の山」があります",
        bullets: ["放置された里山は課題ではなく資源", "館山での実例を紹介します"],
        speaker_notes: "（モック）つかみの台本がここに入ります。",
        minutes: 2,
        photo_filename: null,
      },
      {
        title: "館山ジビエセンターの現場",
        bullets: ["年間◯頭を受け入れ【要確認】", "捕獲から食卓までを一気通貫"],
        speaker_notes: "（モック）現場ストーリーの台本。",
        minutes: 5,
        photo_filename: null,
      },
      {
        title: "今日から出来ること",
        bullets: ["地域の資源を「困りごと」と呼ばない", "まず現場を見に来てください"],
        speaker_notes: "（モック）締めの台本。",
        minutes: 3,
        photo_filename: null,
      },
    ],
    key_message_recap: ["里山は資源である", "小さく始めて続ける"],
    qa_prep: ["Q: 収益化までの期間は? → 実績ベースで回答【要確認】"],
    missing_information: ["年間受入頭数の実数"],
  }),
  generate_video_plan: JSON.stringify({
    title_candidates: [
      "【密着】イノシシが食卓に届くまで（モック）",
      "ジビエ処理施設の1日",
      "館山ジビエセンターの裏側",
    ],
    description: "（モック）館山ジビエセンターの1日に密着。\n捕獲から精肉までの流れを紹介します。\n#ジビエ #館山",
    tags: ["ジビエ", "館山", "狩猟"],
    target_duration_minutes: 8,
    script: [
      {
        section: "オープニング",
        narration: "（モック）この動画では、イノシシが食卓に届くまでの全工程をお見せします。",
        seconds: 15,
        visual: "施設外観 → 作業カットの早回し",
        asset_filename: null,
      },
      {
        section: "本編",
        narration: "（モック）本編ナレーション。",
        seconds: 400,
        visual: "撮影が必要: 受入〜解体の一連のカット",
        asset_filename: null,
      },
      {
        section: "まとめ",
        narration: "（モック）締めのナレーション。",
        seconds: 65,
        visual: "商品カット + チャンネル登録テロップ",
        asset_filename: null,
      },
    ],
    chapters: [
      { time: "0:00", label: "オープニング" },
      { time: "0:15", label: "本編" },
      { time: "7:00", label: "まとめ" },
    ],
    thumbnail_text: ["食卓に届くまで", "ジビエの舞台裏"],
    cta: "チャンネル登録と、館山ジビエセンターの商品ページへのアクセス",
    missing_information: ["解体工程の動画素材"],
  }),
  generate_social_posts: JSON.stringify({
    hp: {
      title: "（モック）里山の恵みを食卓へ — 今週の館山ジビエセンター",
      body: "（モック）ホームページ向けの丁寧な記事本文がここに生成されます。一次データに無い事実は書きません。",
    },
    instagram: {
      caption: "（モック）Instagram向けキャプション。冒頭1行で惹きつけます🌿",
      hashtags: ["ジビエ", "館山", "里山", "イノシシ", "猟師"],
    },
    facebook: {
      post_text: "（モック）Facebook会社ページ向けの投稿文。個人の語り口を活かしつつ文脈を補います。",
    },
    youtube: {
      title: "（モック）里山の恵みを食卓へ｜館山ジビエセンター",
      description: "（モック）概要欄。内容要約と会社紹介、問い合わせ導線。",
      tags: ["ジビエ", "館山"],
    },
    missing_information: ["開催日の確定情報"],
  }),
  parse_field_note: JSON.stringify({
    observations: [
      {
        species_candidates: ["ニホンアカガエル", "ヤマアカガエル"],
        taxon_group: "両生類",
        count: 3,
        evidence_type: "sighting",
        habitat_note: "（モック）湿地北側の浅い水たまり",
        raw_phrase: "湿地の北側でアカガエルの卵塊3つ",
        identification_certainty: "ai_only",
        needs_expert_review: true,
      },
    ],
    resource_notes: [
      { target: "竹林", metric: "枯死率", value: "約7割", raw_phrase: "モウソウチク枯死7割" },
    ],
    management_notes: ["（モック）南側の草刈りを実施"],
    sensitivity_flag: false,
    sensitivity_reason: "",
    missing_information: ["正確な観察時刻"],
    summary: "（モック）湿地でアカガエル類の卵塊を確認。竹林の枯死が進行。",
  }),
  generate_advisor_brief: JSON.stringify({
    issue_summary: "（モック）解体体験の参加費に係る消費税区分と、現金売上の記帳方法が論点。",
    general_guidance:
      "（モック）一般的には役務提供の対価は標準税率10%、食品の販売は軽減税率8%と整理されることが多い。ただし個別の取引実態により判断が分かれるため、最終判断は税理士への確認が必要。",
    key_facts_needed: ["体験に食事・持ち帰り肉が含まれるか", "年間の現金売上規模"],
    documents_to_prepare: ["料金表", "直近の売上記録（sales_slipsのCSV）"],
    questions_for_expert: [
      "解体体験（体験料+持ち帰り肉付き）の消費税区分はどうなりますか？",
      "現金売上の記帳はALCO OSの伝票CSVで足りますか？",
    ],
    recommended_expert: "税理士",
    urgency: "medium",
    urgency_reason: "（モック）次回の申告時期までに整理すれば足りる想定。",
    missing_information: ["体験プランの内容詳細"],
  }),
  summarize_meeting: JSON.stringify({
    title: "打ち合わせ議事録（モック）",
    attendees: [],
    decisions: ["（モック）方針Aで進める"],
    action_items: [{ title: "（モック）次回までに資料準備", assignee: null, due_date: null }],
    minutes_text: "【議事録ドラフト】…（モック出力）",
  }),
};
