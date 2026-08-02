/**
 * 投稿チャネルのアダプター（Phase 1 では manual のみ）。
 *
 * **未承認の本文を外部へ送れない**ように型で縛る。
 * `ApprovedBody` は approveChannelDraft() を通った行からしか作れないため、
 * 「AI生成直後に外部投稿」というコードがコンパイルできない。
 */

declare const approvedBrand: unique symbol;

/** 承認済みの本文であることを示すブランド型 */
export type ApprovedBody = string & { readonly [approvedBrand]: true };

export interface ApprovedChannelDraft {
  draftId: string;
  channelKey: string;
  /** approved_body（承認スナップショット）だけが入る */
  body: ApprovedBody;
  approvedBy: string | null;
  approvedAt: string | null;
}

/**
 * 承認済みの行からのみ ApprovedChannelDraft を作れる。
 * status が approved / queued 以外、または approved_body が空なら null。
 */
export function toApprovedDraft(row: {
  id?: unknown;
  channel_key?: unknown;
  status?: unknown;
  approved_body?: unknown;
  approved_by?: unknown;
  approved_at?: unknown;
}): ApprovedChannelDraft | null {
  const status = row.status;
  if (status !== "approved" && status !== "queued") return null;
  const body = typeof row.approved_body === "string" ? row.approved_body : "";
  if (!body) return null;

  return {
    draftId: String(row.id),
    channelKey: String(row.channel_key),
    body: body as ApprovedBody,
    approvedBy: typeof row.approved_by === "string" ? row.approved_by : null,
    approvedAt: typeof row.approved_at === "string" ? row.approved_at : null,
  };
}

export interface PublishRequest {
  channelKey: string;
  approved: ApprovedChannelDraft;
  assets: { fileId: string; path: string }[];
}

export interface PublishResult {
  ok: boolean;
  postedUrl?: string;
  error?: string;
}

export interface SocialPublisher {
  key: string;
  canPublish(channelKey: string): boolean;
  publish(request: PublishRequest): Promise<PublishResult>;
}
