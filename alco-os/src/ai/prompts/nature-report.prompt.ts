export const PROMPT_VERSION = "nature-report-v1";

export const NATURE_REPORT_SYSTEM_PROMPT = `[workflow:generate_nature_report]
あなたは自然共生サイト認証・TNFD・自然資本コンサルティングの報告書作成を支援するアシスタントです。
里山の調査記録から、企業・行政に提出できる証跡付きレポートのドラフトを作成します。

## 出力形式
必ず次のJSONのみを出力してください。
{
  "summary": "サイトの概況と価値の要約",
  "ecological_value": "生態学的価値の説明",
  "current_issues": "現状の課題",
  "management_summary": "管理作業の実施状況",
  "evidence_refs": ["言及した観察・作業の証跡ID"],
  "missing_evidence": ["結論を支えるために不足している証跡"],
  "draft_proposal_text": "提出先の目的に応じた提案文ドラフト"
}

## 絶対ルール
1. 入力に含まれる観察記録・管理作業のみに言及する。観察を創作してはならない。
2. 種の評価（希少性等）に言及する場合、入力データにない格付けを断定しない。
3. evidence_refs には入力データのIDのみを入れる。
4. 証跡が不足している主張は書かず、missing_evidence に「何が必要か」を書く。
5. すべて日本語で出力する。`;

export function buildNatureReportUserPrompt(input: {
  site_name: string;
  site_description: string;
  client_purpose: string;
  observations: {
    id: string;
    observed_at: string;
    species_name: string;
    taxon_group: string | null;
    note: string | null;
  }[];
  management_actions: {
    id: string;
    action_date: string;
    action_type: string;
    description: string | null;
  }[];
}): string {
  return [
    `対象地: ${input.site_name}`,
    `概要: ${input.site_description || "（未入力）"}`,
    `提出目的: ${input.client_purpose || "（未指定）"}`,
    "--- 観察記録 ---",
    input.observations.length
      ? input.observations
          .map(
            (o) =>
              `[${o.id}] ${o.observed_at} ${o.species_name}（${o.taxon_group ?? "分類不明"}）${o.note ?? ""}`,
          )
          .join("\n")
      : "（観察記録なし）",
    "--- 管理作業履歴 ---",
    input.management_actions.length
      ? input.management_actions
          .map((m) => `[${m.id}] ${m.action_date} ${m.action_type} ${m.description ?? ""}`)
          .join("\n")
      : "（作業履歴なし）",
  ].join("\n");
}
