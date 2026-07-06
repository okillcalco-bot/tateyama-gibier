import { NextResponse } from "next/server";
import PptxGenJS from "pptxgenjs";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { presentationOutputSchema, type PresentationOutput } from "@/ai/schemas/media.schema";

export const dynamic = "force-dynamic";

/**
 * 承認済みプレゼン構成 → PowerPoint（.pptx）生成。
 *
 * 承認フローの下流のみ: media_projects.approved_content（人間承認済み）だけを
 * レンダリングする。ここで AI は呼ばない。
 * 認可は RLS（ログインユーザーの organization のみ読める）に委ねる。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase未設定" }, { status: 503 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const { data: project } = await supabase
    .from("media_projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: "案件が見つかりません" }, { status: 404 });
  }
  if (project.kind !== "presentation" || !project.approved_content) {
    return NextResponse.json(
      { error: "承認済みのプレゼン構成がありません（承認センターで承認してください）" },
      { status: 409 },
    );
  }

  const parsed = presentationOutputSchema.safeParse(project.approved_content);
  if (!parsed.success) {
    return NextResponse.json({ error: "確定版の形式が不正です" }, { status: 500 });
  }

  const photos = await loadPhotoData(supabase, id, parsed.data);
  const buffer = await buildPptx(parsed.data, photos, {
    organization: "合同会社アルコ",
  });

  const filename = `${(project.title as string).replace(/[\\/:*?"<>|]/g, "_")}.pptx`;
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Disposition": `attachment; filename="presentation.pptx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}

type SupabaseServer = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/** 構成が参照する写真を Storage から取得（base64）。画像以外・取得失敗はスキップ */
async function loadPhotoData(
  supabase: SupabaseServer,
  projectId: string,
  plan: PresentationOutput,
): Promise<Map<string, string>> {
  const wanted = new Set(
    plan.slides.map((slide) => slide.photo_filename).filter((name): name is string => !!name),
  );
  const photos = new Map<string, string>();
  if (!wanted.size) return photos;

  const { data: files } = await supabase
    .from("files")
    .select("filename, bucket, path, mime_type")
    .eq("related_table", "media_projects")
    .eq("related_id", projectId)
    .is("deleted_at", null);

  for (const file of files ?? []) {
    if (!wanted.has(file.filename) || photos.has(file.filename)) continue;
    if (file.mime_type && !file.mime_type.startsWith("image/")) continue;
    const { data: blob } = await supabase.storage.from(file.bucket).download(file.path);
    if (!blob) continue;
    const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
    photos.set(file.filename, `${file.mime_type || "image/jpeg"};base64,${base64}`);
  }
  return photos;
}

/** 構成 → PPTX バイナリ。16:9、表紙 + 本文 + まとめ（+ 想定Q&A はノート） */
async function buildPptx(
  plan: PresentationOutput,
  photos: Map<string, string>,
  opts: { organization: string },
): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 10, height: 5.625 });
  pptx.layout = "WIDE";

  const GREEN = "1B5E20";
  const STONE = "444444";

  // 表紙
  const cover = pptx.addSlide();
  cover.background = { color: "F5F5F0" };
  cover.addText(plan.title, {
    x: 0.6, y: 1.7, w: 8.8, h: 1.2,
    fontSize: 32, bold: true, color: GREEN,
  });
  if (plan.subtitle) {
    cover.addText(plan.subtitle, { x: 0.6, y: 2.9, w: 8.8, h: 0.6, fontSize: 18, color: STONE });
  }
  cover.addText(opts.organization, { x: 0.6, y: 4.7, w: 8.8, h: 0.4, fontSize: 12, color: "888888" });

  // 本文スライド
  for (const slide of plan.slides) {
    const s = pptx.addSlide();
    const photo = slide.photo_filename ? photos.get(slide.photo_filename) : undefined;
    const textWidth = photo ? 5.4 : 8.8;

    s.addText(slide.title, {
      x: 0.6, y: 0.35, w: 8.8, h: 0.7,
      fontSize: 22, bold: true, color: GREEN,
    });
    s.addShape("line", { x: 0.6, y: 1.1, w: 8.8, h: 0, line: { color: GREEN, width: 1 } });

    if (slide.bullets.length) {
      s.addText(
        slide.bullets.map((bullet) => ({
          text: bullet,
          options: { bullet: { characterCode: "2022", indent: 12 }, breakLine: true },
        })),
        { x: 0.6, y: 1.35, w: textWidth, h: 3.6, fontSize: 15, color: STONE, valign: "top" },
      );
    }
    if (photo) {
      // 元画像の縦横比は不明なため枠内に収める（sizing: contain）
      s.addImage({
        data: photo,
        x: 6.2, y: 1.35, w: 3.3, h: 3.6,
        sizing: { type: "contain", w: 3.3, h: 3.6 },
      });
    }
    if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
  }

  // まとめ（持ち帰りポイント）
  if (plan.key_message_recap.length) {
    const s = pptx.addSlide();
    s.background = { color: "F5F5F0" };
    s.addText("本日お伝えしたいこと", {
      x: 0.6, y: 0.35, w: 8.8, h: 0.7, fontSize: 22, bold: true, color: GREEN,
    });
    s.addText(
      plan.key_message_recap.map((message) => ({
        text: message,
        options: { bullet: { characterCode: "2022", indent: 12 }, breakLine: true },
      })),
      { x: 0.6, y: 1.35, w: 8.8, h: 3.6, fontSize: 17, color: STONE, valign: "top" },
    );
    if (plan.qa_prep.length) {
      s.addNotes(`想定Q&A:\n${plan.qa_prep.map((qa) => `・${qa}`).join("\n")}`);
    }
  }

  const output = await pptx.write({ outputType: "nodebuffer" });
  return output as Buffer;
}
