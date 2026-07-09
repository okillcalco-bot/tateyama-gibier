"use client";

import { useRef, useState, useTransition } from "react";
import type { VideoPlanOutput } from "@/ai/schemas/media.schema";
import { registerYoutubeVideoAction } from "./actions";

/**
 * 動画編集ツール（段階1: ブラウザ内レンダラー）。
 *
 * 承認済みの台本（video_plan）と添付素材から、Canvas + MediaRecorder で
 * 1280x720 の WebM 動画を書き出す。サーバー不要・追加コストゼロで動く「軸」。
 * 音声は含まない（ナレーション原稿・SRT字幕を一緒に出力するので、
 * ナレーション録音や TTS・高品質レンダリングは段階2で差し替える）。
 * 段階2で ffmpeg / Remotion 等のサーバーレンダラーに置き換える場合も、
 * 入力（video_plan の script 構造）はそのまま使える。
 */

const W = 1280;
const H = 720;

export interface VideoAsset {
  filename: string;
  url: string; // 署名付きURL（Supabase Storage は CORS 許可済み）
  mimeType: string | null;
}

// ── 台本 → SRT / ナレーション原稿（クライアント側で生成） ──

function srtTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const ms = Math.round((totalSeconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function buildSrt(plan: VideoPlanOutput): string {
  let t = 0;
  return plan.script
    .map((cut, i) => {
      const start = t;
      t += cut.seconds;
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(t)}\n${cut.narration.trim()}\n`;
    })
    .join("\n");
}

export function buildNarrationScript(plan: VideoPlanOutput): string {
  return plan.script
    .map((cut) => `【${cut.section}｜${cut.seconds}秒】\n${cut.narration.trim()}\n`)
    .join("\n");
}

function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Canvas 描画ヘルパー ──

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text.replace(/\s+/g, " ")) {
    if (ctx.measureText(line + ch).width > maxWidth) {
      lines.push(line);
      line = ch === " " ? "" : ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sw: number,
  sh: number,
  zoom: number,
) {
  if (!sw || !sh) return;
  const scale = Math.max(W / sw, H / sh) * zoom;
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function drawOverlays(
  ctx: CanvasRenderingContext2D,
  cut: VideoPlanOutput["script"][number],
) {
  // セクション名（左上）
  ctx.font = "bold 28px sans-serif";
  const sectionWidth = ctx.measureText(cut.section).width;
  ctx.fillStyle = "rgba(27,94,32,0.85)";
  ctx.fillRect(32, 32, sectionWidth + 32, 48);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(cut.section, 48, 66);

  // ナレーション字幕（下部帯）
  ctx.font = "bold 34px sans-serif";
  const lines = wrapText(ctx, cut.narration, W - 160).slice(0, 3);
  const bandHeight = lines.length * 46 + 36;
  ctx.fillStyle = "rgba(0,0,0,0.62)";
  ctx.fillRect(0, H - bandHeight, W, bandHeight);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  lines.forEach((line, i) => {
    ctx.fillText(line, W / 2, H - bandHeight + 46 * (i + 1) - 6);
  });
  ctx.textAlign = "left";
}

function drawFallbackBackground(ctx: CanvasRenderingContext2D, cut: { section: string }) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#14532d");
  grad.addColorStop(1, "#1c1917");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "bold 64px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(cut.section, W / 2, H / 2);
  ctx.textAlign = "left";
}

function pickMimeType(): string {
  for (const t of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

// ── レンダラー本体 ──

export function VideoRenderer({ plan, assets }: { plan: VideoPlanOutput; assets: VideoAsset[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const assetByName = new Map(assets.map((a) => [a.filename, a]));
  const totalSeconds = plan.script.reduce((sum, cut) => sum + cut.seconds, 0);

  const loadImage = (url: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous"; // 署名URLはCORS許可。汚染するとcaptureStreamが失敗する
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("素材画像の読み込みに失敗しました"));
      img.src = url;
    });

  const loadVideo = (url: string) =>
    new Promise<HTMLVideoElement>((resolve, reject) => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.onloadeddata = () => resolve(video);
      video.onerror = () => reject(new Error("素材動画の読み込みに失敗しました"));
      video.src = url;
    });

  async function render(testMode: boolean) {
    const canvas = canvasRef.current;
    if (!canvas || rendering) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    setRendering(true);
    setResultUrl(null);
    setStatus("素材を読み込み中…");
    try {
      // 使う素材を事前ロード
      const media = new Map<string, HTMLImageElement | HTMLVideoElement>();
      for (const cut of plan.script) {
        if (!cut.asset_filename || media.has(cut.asset_filename)) continue;
        const asset = assetByName.get(cut.asset_filename);
        if (!asset) continue;
        media.set(
          cut.asset_filename,
          asset.mimeType?.startsWith("video/")
            ? await loadVideo(asset.url)
            : await loadImage(asset.url),
        );
      }

      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, {
        mimeType: pickMimeType() || undefined,
        videoBitsPerSecond: 6_000_000,
      });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start(250);

      for (const [index, cut] of plan.script.entries()) {
        setStatus(`書き出し中… ${index + 1}/${plan.script.length} 「${cut.section}」`);
        const seconds = testMode ? Math.min(cut.seconds, 2) : cut.seconds;
        const source = cut.asset_filename ? media.get(cut.asset_filename) : undefined;
        const video = source instanceof HTMLVideoElement ? source : null;
        if (video) {
          video.currentTime = 0;
          await video.play();
        }
        const startedAt = performance.now();
        await new Promise<void>((resolve) => {
          const frame = () => {
            const elapsed = (performance.now() - startedAt) / 1000;
            if (elapsed >= seconds) {
              resolve();
              return;
            }
            ctx.clearRect(0, 0, W, H);
            if (video) {
              drawCover(ctx, video, video.videoWidth, video.videoHeight, 1);
            } else if (source instanceof HTMLImageElement) {
              // ゆっくり寄る（ケンバーンズ）。静止画でも動画らしく見せる
              drawCover(ctx, source, source.naturalWidth, source.naturalHeight, 1 + 0.06 * (elapsed / seconds));
            } else {
              drawFallbackBackground(ctx, cut);
            }
            drawOverlays(ctx, cut);
            requestAnimationFrame(frame);
          };
          frame();
        });
        video?.pause();
      }

      recorder.stop();
      await stopped;
      setResultUrl(URL.createObjectURL(new Blob(chunks, { type: "video/webm" })));
      setStatus(testMode ? "テスト書き出し完了（各カット最大2秒）" : "書き出し完了");
    } catch (e) {
      setStatus(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRendering(false);
    }
  }

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="w-full rounded-lg border border-stone-200 bg-stone-900"
      />
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => render(true)}
          disabled={rendering}
          className="rounded-lg border border-green-700 px-3 py-2 text-sm font-semibold text-green-700 disabled:opacity-50"
        >
          テスト書き出し（短縮版）
        </button>
        <button
          onClick={() => render(false)}
          disabled={rendering}
          className="rounded-lg bg-green-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {rendering ? "書き出し中…" : `フル書き出し（約${Math.ceil(totalSeconds / 60)}分・実時間かかります）`}
        </button>
        <button
          onClick={() => downloadText("narration.srt", buildSrt(plan))}
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-600"
        >
          ⬇ 字幕（SRT）
        </button>
        <button
          onClick={() => downloadText("narration.txt", buildNarrationScript(plan))}
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-600"
        >
          ⬇ ナレーション原稿
        </button>
      </div>
      {status ? <p className="text-sm text-stone-600">{status}</p> : null}
      {resultUrl ? (
        <div className="space-y-1">
          <video src={resultUrl} controls className="w-full rounded-lg" />
          <a
            href={resultUrl}
            download="video.webm"
            className="block rounded-lg bg-green-700 px-4 py-2 text-center text-sm font-semibold text-white"
          >
            ⬇ 動画（.webm）を保存
          </a>
        </div>
      ) : null}
      <p className="text-xs text-stone-400">
        書き出しは映像のみ（音声なし）。ナレーション原稿を元に音声を載せる場合は
        YouTube Studio やスマホの編集アプリで合成してください。
        高品質レンダリング・TTS・自動アップロードは段階2で追加予定です。
      </p>
    </div>
  );
}

/** YouTubeへ手動アップロード後、動画IDを登録してステータスを進める */
export function RegisterYoutubeForm({
  projectId,
  currentVideoId,
}: {
  projectId: string;
  currentVideoId: string | null;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <form
      action={(formData) => {
        setError(null);
        setSaved(false);
        startTransition(async () => {
          const result = await registerYoutubeVideoAction(
            projectId,
            String(formData.get("video_id") ?? ""),
            String(formData.get("status") ?? "uploaded"),
          );
          if (!result.ok) setError(result.error);
          else setSaved(true);
        });
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input
        name="video_id"
        defaultValue={currentVideoId ?? ""}
        required
        placeholder="YouTube動画ID（例: dQw4w9WgXcQ）"
        className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
      />
      <select name="status" className="rounded-lg border border-stone-300 px-3 py-2 text-sm">
        <option value="uploaded">アップ済（非公開）</option>
        <option value="published">公開済</option>
      </select>
      <button
        type="submit"
        disabled={isPending}
        className="rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {isPending ? "保存中…" : "登録"}
      </button>
      {saved ? <span className="text-sm text-green-700">保存しました</span> : null}
      {error ? <span className="text-sm text-red-600">{error}</span> : null}
    </form>
  );
}
