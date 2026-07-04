import {
  grantDraftInputSchema,
  grantDraftOutputSchema,
  type GrantDraftInput,
  type GrantDraftOutput,
} from "../schemas/grant.schema";
import {
  GRANT_DRAFT_SYSTEM_PROMPT,
  buildGrantDraftUserPrompt,
  PROMPT_VERSION,
} from "../prompts/grant-draft.prompt";
import { runWorkflow, type WorkflowContext, type WorkflowResult } from "./run-workflow";

/**
 * 補助金申請書ドラフト生成。
 * 生成物は必ず generated_drafts に保存され、人間レビュー後に
 * grant_documents へ確定保存される（grant-draft-service 経由）。
 */
export async function generateGrantDraft(
  ctx: WorkflowContext,
  rawInput: GrantDraftInput,
  options: { grantProjectId?: string } = {},
): Promise<WorkflowResult<GrantDraftOutput>> {
  const input = grantDraftInputSchema.parse(rawInput);

  return runWorkflow(ctx, {
    workflow: "generate_grant_draft",
    promptVersion: PROMPT_VERSION,
    system: GRANT_DRAFT_SYSTEM_PROMPT,
    user: buildGrantDraftUserPrompt(input),
    outputSchema: grantDraftOutputSchema,
    inputSummary: `補助金ドラフト生成: ${input.grant_name}`,
    draft: {
      draftType: "grant_application",
      sourceTable: "grant_projects",
      sourceId: options.grantProjectId,
      title: `${input.grant_name} 申請書ドラフト`,
    },
  });
}
