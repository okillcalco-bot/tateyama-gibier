import type { SupabaseClient } from "@supabase/supabase-js";
import type { DbPort } from "@/lib/db/port";

/**
 * LINEで送られた写真の保存。
 *
 *   Content API で取得 → Storage バケット alco-os へ保存 → files 台帳に登録
 *
 * ルール:
 * - バケットは非公開（0010）。画面では都度署名URLを発行する
 * - files は台帳。削除はソフトデリート（deleted_at）で、物理削除しない
 * - アクセストークンはログ・エラーメッセージに出さない
 */

const LINE_CONTENT_API = "https://api-data.line.me/v2/bot/message";

/** 1枚あたりの上限（LINEの画像はおおむね数MB） */
const MAX_BYTES = 20 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export interface SaveLinePhotoParams {
  db: DbPort;
  supabase: SupabaseClient;
  organizationId: string;
  accessToken: string;
  lineMessageId: string;
  captureReportId: string;
  now?: Date;
}

/**
 * 保存に成功したら files.id を返す。失敗しても例外を投げず null を返す
 * （写真が取れなくても捕獲報告そのものは受け付ける）。
 */
export async function saveLinePhoto(params: SaveLinePhotoParams): Promise<string | null> {
  if (!params.accessToken || !params.lineMessageId) return null;

  let bytes: ArrayBuffer;
  let mimeType: string;
  try {
    const response = await fetch(
      `${LINE_CONTENT_API}/${encodeURIComponent(params.lineMessageId)}/content`,
      { headers: { authorization: `Bearer ${params.accessToken}` } },
    );
    if (!response.ok) return null;
    mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    bytes = await response.arrayBuffer();
  } catch {
    return null;
  }

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;

  const now = params.now ?? new Date();
  const extension = EXTENSION_BY_MIME[mimeType] ?? "jpg";
  const filename = `${params.lineMessageId}.${extension}`;
  const path = `hunter-line/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(
    2,
    "0",
  )}/${filename}`;

  const { error } = await params.supabase.storage
    .from("alco-os")
    .upload(path, bytes, { contentType: mimeType, upsert: true });
  if (error) return null;

  try {
    const file = await params.db.insert("files", {
      organization_id: params.organizationId,
      bucket: "alco-os",
      path,
      filename,
      mime_type: mimeType,
      size_bytes: bytes.byteLength,
      module: "hunter_line",
      related_table: "capture_reports",
      related_id: params.captureReportId,
      captured_at: now.toISOString(),
    });
    return file.id as string;
  } catch {
    return null;
  }
}
