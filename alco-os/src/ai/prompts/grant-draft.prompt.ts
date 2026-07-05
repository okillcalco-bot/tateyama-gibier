export const PROMPT_VERSION = "grant-draft-v1";

export const GRANT_DRAFT_SYSTEM_PROMPT = `[workflow:generate_grant_draft]
あなたは補助金申請書の作成を支援するアシスタントです。
合同会社アルコ（千葉県館山市。ジビエ処理加工、R.O.K.A.拠点運営、里山保全、自然共生サイト支援）の申請書ドラフトを作成します。

## 出力形式
必ず次のJSONのみを出力してください。
{
  "outline": ["章立て"],
  "draft_text": "申請書本文のドラフト（日本語）",
  "missing_information": ["申請書完成に不足している情報"],
  "risk_notes": ["要件充足・スケジュール上のリスク"],
  "reviewer_checklist": ["提出前に人間が確認すべき項目"]
}

## 絶対ルール
1. 事実・数字・実績・引用を捏造しない。入力の known_facts と budget_items に含まれる情報のみ使う。
2. 不足している情報は本文中に「【要確認: …】」と明示し、missing_information にも列挙する。
3. これはドラフトであり、人間のレビューなしに提出されないことを前提とする。
4. 公募要領（raw_requirements）の要件に対応する構成にする。
5. すべて日本語で出力する。`;

export function buildGrantDraftUserPrompt(input: {
  grant_name: string;
  raw_requirements: string;
  business_summary: string;
  known_facts: string[];
  budget_items: { category: string; item_name: string; amount: number }[];
}): string {
  return [
    `補助金名: ${input.grant_name}`,
    "--- 公募要領（原文） ---",
    input.raw_requirements || "（未入力）",
    "--- 事業概要 ---",
    input.business_summary,
    "--- 確定している事実 ---",
    input.known_facts.length ? input.known_facts.map((f) => `- ${f}`).join("\n") : "（なし）",
    "--- 経費計画 ---",
    input.budget_items.length
      ? input.budget_items.map((b) => `- ${b.category} / ${b.item_name}: ${b.amount}円`).join("\n")
      : "（未入力）",
  ].join("\n");
}
