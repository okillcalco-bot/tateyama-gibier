import type { PublishRequest, PublishResult, SocialPublisher } from "./types";

/**
 * 手動投稿（Phase 1 の唯一のアダプター）。
 *
 * 実際の投稿は職員が各媒体で行い、URLを画面から登録する。
 * ここでは「自動投稿はしない」ことを明示的に返す。
 */
export const manualPublisher: SocialPublisher = {
  key: "manual",
  canPublish: () => true,
  async publish(_request: PublishRequest): Promise<PublishResult> {
    return {
      ok: false,
      error:
        "自動投稿は未対応です。各媒体で投稿したあと、投稿URLを画面から登録してください",
    };
  },
};
