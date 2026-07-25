import type { Row } from "@/lib/db/port";

/**
 * 称号・実績（里山OS 設計書 10章）。
 *
 * 設計上の禁止事項をコードで守る:
 * - 投稿数の単純競争を煽らない（「たくさん投稿した人」の称号は作らない）
 * - 希少種の発見・投稿を報酬対象にしない（乱獲・位置暴露の誘発を防ぐ）
 * - 個人ランキングではなく、質・継続・共同達成を評価する
 */

export interface Achievement {
  key: string;
  name: string;
  description: string;
  icon: string;
  /** 応援者向けの称号か（調査者向けか） */
  audience: "observer" | "supporter" | "community";
}

export const ACHIEVEMENTS: Achievement[] = [
  {
    key: "four_seasons",
    name: "季節をつなぐ者",
    description: "同じ対象地で春夏秋冬すべての観察を記録した",
    icon: "🍀",
    audience: "observer",
  },
  {
    key: "evidence_bridge",
    name: "証拠の橋渡し",
    description: "同じテーマについて写真・音声・痕跡など3種類の証拠を集めた",
    icon: "🔗",
    audience: "observer",
  },
  {
    key: "careful_observer",
    name: "丁寧な観察者",
    description: "レビュー承認率が高い記録を積み重ねた（数ではなく質）",
    icon: "🔍",
    audience: "observer",
  },
  {
    key: "gap_filler",
    name: "空白を埋めた人",
    description: "誰も記録していなかった分類群×季節のマスを最初に埋めた",
    icon: "🧩",
    audience: "observer",
  },
  {
    key: "first_supporter",
    name: "はじまりの応援者",
    description: "クエストの最初の応援者になった",
    icon: "🌱",
    audience: "supporter",
  },
  {
    key: "quest_completer",
    name: "クエスト達成を支えた人",
    description: "応援したクエストが目標を達成した",
    icon: "🏅",
    audience: "supporter",
  },
  {
    key: "continuous_supporter",
    name: "里山の伴走者",
    description: "3回以上にわたって応援した",
    icon: "🤝",
    audience: "supporter",
  },
  {
    key: "community_season",
    name: "みんなで一season",
    description: "地域全体で、ある季節の必要調査をすべて満たした（共同達成）",
    icon: "🎉",
    audience: "community",
  },
];

export const ACHIEVEMENT_BY_KEY = new Map(ACHIEVEMENTS.map((a) => [a.key, a]));

/**
 * 応援者の称号判定（ルールベース）。
 * 「金額の大きさ」ではなく「関わりの継続と成果」で判定する。
 */
export function evaluateSupporterAchievements(input: {
  confirmedPledgeCount: number;
  isFirstSupporterOfAnyQuest: boolean;
  supportedCompletedQuestCount: number;
}): string[] {
  const keys: string[] = [];
  if (input.isFirstSupporterOfAnyQuest) keys.push("first_supporter");
  if (input.supportedCompletedQuestCount > 0) keys.push("quest_completer");
  if (input.confirmedPledgeCount >= 3) keys.push("continuous_supporter");
  return keys;
}

/** 観察者の称号判定。件数の多さではなく、季節・証拠の多様性・承認率で評価する */
export function evaluateObserverAchievements(observations: Row[]): string[] {
  const keys: string[] = [];
  const approved = observations.filter((o) => o.review_status === "approved");

  // 季節をつなぐ者: 同一サイトで4季
  const bySite = new Map<string, Set<string>>();
  for (const o of approved) {
    const month = Number(String(o.observed_at ?? "").slice(5, 7));
    const season =
      month >= 3 && month <= 5
        ? "spring"
        : month >= 6 && month <= 8
          ? "summer"
          : month >= 9 && month <= 11
            ? "autumn"
            : "winter";
    const site = (o.site_id as string) ?? "";
    if (!bySite.has(site)) bySite.set(site, new Set());
    bySite.get(site)!.add(season);
  }
  if ([...bySite.values()].some((seasons) => seasons.size >= 4)) keys.push("four_seasons");

  // 証拠の橋渡し: 3種類以上の証拠タイプ
  const evidenceTypes = new Set(
    approved.map((o) => (o.evidence_type as string) ?? "").filter(Boolean),
  );
  if (evidenceTypes.size >= 3) keys.push("evidence_bridge");

  // 丁寧な観察者: 承認率90%以上（母数10件以上）。件数だけでは付かない
  if (observations.length >= 10 && approved.length / observations.length >= 0.9) {
    keys.push("careful_observer");
  }

  return keys;
}

/** 地域レベル（共同達成の可視化）。個人ランキングの代わりに前面に出す */
export function communityLevel(input: {
  approvedObservations: number;
  filledCells: number;
  completedQuests: number;
}): { level: number; title: string; nextThreshold: number; progressPercent: number } {
  const points =
    input.approvedObservations * 1 + input.filledCells * 10 + input.completedQuests * 25;
  const thresholds = [0, 50, 150, 350, 700, 1200, 2000];
  let level = 1;
  for (let i = 1; i < thresholds.length; i++) {
    if (points >= thresholds[i]) level = i + 1;
  }
  const titles = [
    "はじまりの里山",
    "歩きはじめた里山",
    "記録が集まる里山",
    "季節が見えてきた里山",
    "つながりが見える里山",
    "語れる里山",
    "未来へ渡せる里山",
  ];
  const nextThreshold = thresholds[Math.min(level, thresholds.length - 1)];
  const prevThreshold = thresholds[level - 1] ?? 0;
  const span = Math.max(1, nextThreshold - prevThreshold);
  return {
    level,
    title: titles[Math.min(level - 1, titles.length - 1)],
    nextThreshold,
    progressPercent:
      level >= thresholds.length
        ? 100
        : Math.min(100, Math.round(((points - prevThreshold) / span) * 100)),
  };
}
