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
  summarize_meeting: JSON.stringify({
    title: "打ち合わせ議事録（モック）",
    attendees: [],
    decisions: ["（モック）方針Aで進める"],
    action_items: [{ title: "（モック）次回までに資料準備", assignee: null, due_date: null }],
    minutes_text: "【議事録ドラフト】…（モック出力）",
  }),
};
