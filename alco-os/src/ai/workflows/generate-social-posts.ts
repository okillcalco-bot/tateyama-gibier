import {
  socialBriefSchema,
  socialPostsOutputSchema,
  type SocialBrief,
  type SocialPostsOutput,
} from "../schemas/social.schema";
import {
  SOCIAL_SYSTEM_PROMPT,
  buildSocialUserPrompt,
  PROMPT_VERSION,
} from "../prompts/social.prompt";
import { runWorkflow, type WorkflowContext, type WorkflowResult } from "./run-workflow";

/**
 * 投稿一括更新: 一次データ → 各チャンネル向け原稿。
 * 依頼したチャンネルの原稿が欠けている出力は保存前に拒否する。
 */
export async function generateSocialPosts(
  ctx: WorkflowContext,
  rawInput: SocialBrief,
  options: { socialProjectId?: string } = {},
): Promise<WorkflowResult<SocialPostsOutput>> {
  const input = socialBriefSchema.parse(rawInput);

  const outputSchema = socialPostsOutputSchema.superRefine((output, zodCtx) => {
    for (const channel of input.channels) {
      if (!output[channel]) {
        zodCtx.addIssue({
          code: "custom",
          path: [channel],
          message: `依頼したチャンネル「${channel}」の原稿がありません`,
        });
      }
    }
  });

  return runWorkflow(ctx, {
    workflow: "generate_social_posts",
    promptVersion: PROMPT_VERSION,
    system: SOCIAL_SYSTEM_PROMPT,
    user: buildSocialUserPrompt(input),
    outputSchema,
    inputSummary: `投稿原稿生成: ${input.title}（${input.channels.join("/")}）`,
    draft: {
      draftType: "social_posts",
      sourceTable: "social_projects",
      sourceId: options.socialProjectId,
      title: `${input.title} 投稿原稿`,
    },
  });
}
