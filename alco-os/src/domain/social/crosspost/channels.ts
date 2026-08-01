/**
 * FB横展開システムの媒体定義（0029）。
 *
 * 実データは social_channels テーブル（画面から追加・非表示できる）。
 * ここにあるのは既定値と型で、DBに行が無いときのフォールバックにも使う。
 */

export type CrosspostChannelKey =
  | "instagram"
  | "threads"
  | "line_official"
  | "google_business"
  | "web"
  | "x"
  | "reels"
  | "facebook_page";

export interface ChannelSpec {
  key: CrosspostChannelKey;
  label: string;
  enabled: boolean;
  sortOrder: number;
  minChars: number | null;
  maxChars: number | null;
  maxHashtags: number;
  ctaPolicy: string;
  guidance: string;
}

export const DEFAULT_CHANNELS: ChannelSpec[] = [
  {
    key: "instagram",
    label: "Instagram",
    enabled: true,
    sortOrder: 10,
    minChars: 600,
    maxChars: 1200,
    maxHashtags: 5,
    ctaPolicy: "CTAは1つ",
    guidance: "写真中心。カルーセルは各ページの見出しも作る",
  },
  {
    key: "threads",
    label: "Threads",
    enabled: true,
    sortOrder: 20,
    minChars: 300,
    maxChars: 500,
    maxHashtags: 3,
    ctaPolicy: "詳細はFacebookかWebへ誘導",
    guidance: "一つの問い・気づき・葛藤に絞る",
  },
  {
    key: "line_official",
    label: "LINE公式",
    enabled: true,
    sortOrder: 30,
    minChars: 250,
    maxChars: 500,
    maxHashtags: 0,
    ctaPolicy: "CTAは1つだけ",
    guidance:
      "読者に関係する要点を先に。配信対象と目的を明示。承認なしで配信しない",
  },
  {
    key: "google_business",
    label: "Googleビジネスプロフィール",
    enabled: true,
    sortOrder: 40,
    minChars: 150,
    maxChars: 700,
    maxHashtags: 0,
    ctaPolicy: "来店・問い合わせのいずれか1つ",
    guidance:
      "地域・店舗・サービス・イベント中心。営業日時・価格・場所は確認できないものを書かない",
  },
  {
    key: "web",
    label: "Web（お知らせ・ブログ）",
    enabled: true,
    sortOrder: 50,
    minChars: 800,
    maxChars: 3000,
    maxHashtags: 0,
    ctaPolicy: "関連ページへの導線",
    guidance:
      "原文を削りすぎない。見出しと背景説明を足してよい。SEOより事実と読みやすさ",
  },
  {
    key: "x",
    label: "X",
    enabled: true,
    sortOrder: 60,
    minChars: 100,
    maxChars: 280,
    maxHashtags: 2,
    ctaPolicy: "リンク1つ",
    guidance: "一つの事実と一つの問い。長ければスレッド案にする。煽らない",
  },
  {
    key: "reels",
    label: "Reels・Shorts台本",
    enabled: true,
    sortOrder: 70,
    minChars: 300,
    maxChars: 900,
    maxHashtags: 3,
    ctaPolicy: "最後に問いか案内",
    guidance: "45〜60秒。冒頭3秒のフック。映像・写真の表示順も提案する",
  },
  {
    key: "facebook_page",
    label: "Facebook（会社ページ）",
    // 個人投稿と内容が重なるため、運用確認後に設定画面から有効化する
    enabled: false,
    sortOrder: 80,
    minChars: 400,
    maxChars: 1500,
    maxHashtags: 3,
    ctaPolicy: "CTAは1つ",
    guidance: "個人の語り口を残しつつ、初見の人にも文脈が分かる書き出しにする",
  },
];

export const CHANNEL_LABELS: Record<string, string> = Object.fromEntries(
  DEFAULT_CHANNELS.map((c) => [c.key, c.label]),
);

export function isCrosspostChannelKey(value: unknown): value is CrosspostChannelKey {
  return DEFAULT_CHANNELS.some((c) => c.key === value);
}

/**
 * 1回のAI呼び出しで扱う媒体の数。
 * 8媒体を一度に生成させると出力が長くなり、タイムアウトと部分失敗の影響が大きい。
 * 2〜3媒体ずつに分けることで、失敗しても他のバッチは残る。
 */
export const CHANNELS_PER_BATCH = 3;

export function splitIntoBatches<T>(items: T[], size = CHANNELS_PER_BATCH): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/** 下書きの状態 */
export type DraftStatus =
  | "not_generated"
  | "draft"
  | "needs_review"
  | "editing"
  | "approved"
  | "queued"
  | "published"
  | "rejected"
  | "error";

export const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  not_generated: "未生成",
  draft: "下書き",
  needs_review: "要確認",
  editing: "修正中",
  approved: "承認済み",
  queued: "投稿待ち",
  published: "投稿済み",
  rejected: "却下",
  error: "エラー",
};

/** 状態を色だけで示さないための記号 */
export const DRAFT_STATUS_MARKS: Record<DraftStatus, string> = {
  not_generated: "－",
  draft: "●",
  needs_review: "！",
  editing: "✎",
  approved: "✓",
  queued: "→",
  published: "✔",
  rejected: "✕",
  error: "⚠",
};
