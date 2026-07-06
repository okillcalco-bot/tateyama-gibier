import {
  mediaBriefSchema,
  presentationOutputSchema,
  videoPlanOutputSchema,
  type MediaBrief,
  type PresentationOutput,
  type VideoPlanOutput,
} from "../schemas/media.schema";
import {
  PRESENTATION_SYSTEM_PROMPT,
  buildPresentationUserPrompt,
  PROMPT_VERSION as PRESENTATION_PROMPT_VERSION,
} from "../prompts/presentation.prompt";
import {
  VIDEO_PLAN_SYSTEM_PROMPT,
  buildVideoPlanUserPrompt,
  PROMPT_VERSION as VIDEO_PROMPT_VERSION,
} from "../prompts/video-plan.prompt";
import { runWorkflow, type WorkflowContext, type WorkflowResult } from "./run-workflow";

/**
 * メディア生成ワークフロー（プレゼン構成 / YouTube動画プラン）。
 * 写真・素材の割付は「添付済みファイル名」のみ許可し、スキーマ検証で
 * 実在チェックを強制する（存在しない素材名を指定した出力は保存拒否）。
 */

/** 素材名が実在リストに含まれるかを検証するヘルパー */
function assertKnownAssets(
  refs: (string | null)[],
  known: Set<string>,
  ctx: { addIssue: (issue: { code: "custom"; path: (string | number)[]; message: string }) => void },
  path: string,
) {
  const unknown = refs.filter((ref): ref is string => ref !== null && !known.has(ref));
  if (unknown.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: [path],
      message: `添付されていない素材名が指定されました: ${unknown.join(", ")}`,
    });
  }
}

export async function generatePresentation(
  ctx: WorkflowContext,
  rawInput: MediaBrief,
  options: { mediaProjectId?: string } = {},
): Promise<WorkflowResult<PresentationOutput>> {
  const input = mediaBriefSchema.parse(rawInput);
  const known = new Set(input.photo_filenames);

  const outputSchema = presentationOutputSchema.superRefine((output, zodCtx) => {
    assertKnownAssets(
      output.slides.map((slide) => slide.photo_filename),
      known,
      zodCtx,
      "slides",
    );
  });

  return runWorkflow(ctx, {
    workflow: "generate_presentation",
    promptVersion: PRESENTATION_PROMPT_VERSION,
    system: PRESENTATION_SYSTEM_PROMPT,
    user: buildPresentationUserPrompt(input),
    outputSchema,
    inputSummary: `プレゼン構成生成: ${input.title}`,
    draft: {
      draftType: "presentation_outline",
      sourceTable: "media_projects",
      sourceId: options.mediaProjectId,
      title: `${input.title} プレゼン構成`,
    },
  });
}

export async function generateVideoPlan(
  ctx: WorkflowContext,
  rawInput: MediaBrief,
  options: { mediaProjectId?: string } = {},
): Promise<WorkflowResult<VideoPlanOutput>> {
  const input = mediaBriefSchema.parse(rawInput);
  const known = new Set(input.photo_filenames);

  const outputSchema = videoPlanOutputSchema.superRefine((output, zodCtx) => {
    assertKnownAssets(
      output.script.map((cut) => cut.asset_filename),
      known,
      zodCtx,
      "script",
    );
  });

  return runWorkflow(ctx, {
    workflow: "generate_video_plan",
    promptVersion: VIDEO_PROMPT_VERSION,
    system: VIDEO_PLAN_SYSTEM_PROMPT,
    user: buildVideoPlanUserPrompt(input),
    outputSchema,
    inputSummary: `動画プラン生成: ${input.title}`,
    draft: {
      draftType: "video_plan",
      sourceTable: "media_projects",
      sourceId: options.mediaProjectId,
      title: `${input.title} 動画プラン`,
    },
  });
}
