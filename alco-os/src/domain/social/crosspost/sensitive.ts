/**
 * センシティブ判定（指示書の18分類）。
 *
 * **サーバー側の辞書判定が最終権限。** AIが「問題なし」と言っても、
 * 辞書に当たれば要確認にする（parse-field-note.ts と同じ思想）。
 *
 * 判定した理由は文言のまま保存し、画面にそのまま出す。
 * 承認後も理由は消さない（誰がどの理由を確認して承認したかを残すため）。
 */

export interface SensitiveRule {
  category: string;
  words: string[];
  reason: string;
}

export const SENSITIVE_RULES: SensitiveRule[] = [
  {
    category: "life",
    words: [
      "止め刺し", "とめさし", "捕獲", "死亡", "死体", "血", "解体", "内臓",
      "ウリ坊", "うり坊", "幼獣", "廃棄", "殺処分", "屠体",
    ],
    reason: "命の扱いに触れる内容です。表現が軽くなっていないか確認してください",
  },
  {
    category: "disaster",
    words: ["災害", "台風", "大雨", "地震", "事故", "けが", "怪我", "病気", "感染"],
    reason: "災害・事故・健康に関わります。事実確認と配慮が必要です",
  },
  {
    category: "public",
    words: ["市役所", "県庁", "行政", "補助金", "交付金", "条例", "議会", "政治", "選挙"],
    reason: "行政・政治に関わる記述です。事実と立場を確認してください",
  },
  {
    category: "personal",
    words: ["さん", "様", "氏", "顔写真", "電話番号", "住所"],
    reason: "個人が特定される可能性があります。公開してよい相手か確認してください",
  },
  {
    category: "research",
    words: ["研究", "調査結果", "統計", "有意", "相関", "％", "%"],
    reason: "研究・統計に関わる主張です。根拠のある数値か確認してください",
  },
  {
    category: "commerce",
    words: [
      "価格", "円", "販売", "値段", "営業時間", "定休日", "募集", "求人",
      "イベント", "開催日", "申込",
    ],
    reason: "価格・営業・募集・イベントの情報です。実際の内容と一致するか確認してください",
  },
  {
    category: "contract",
    words: ["契約", "覚書", "クレーム", "苦情", "批判", "訴訟"],
    reason: "契約や批判に関わります。相手方への影響を確認してください",
  },
];

export interface SensitiveHit {
  category: string;
  word: string;
  reason: string;
}

/** 本文から該当する語を拾う。理由は重複させない */
export function detectSensitive(text: string): SensitiveHit[] {
  if (!text) return [];
  const hits: SensitiveHit[] = [];
  const seen = new Set<string>();
  for (const rule of SENSITIVE_RULES) {
    for (const word of rule.words) {
      if (text.includes(word) && !seen.has(rule.category)) {
        seen.add(rule.category);
        hits.push({ category: rule.category, word, reason: rule.reason });
        break;
      }
    }
  }
  return hits;
}

/** 画面に出す理由の一覧（語も添えて、なぜ引っかかったか分かるようにする） */
export function buildReviewReasons(hits: SensitiveHit[]): string[] {
  return hits.map((hit) => `${hit.reason}（該当: ${hit.word}）`);
}

export interface ReviewInput {
  /** 元原稿 */
  sourceBody: string;
  /** 生成された本文 */
  channelBody: string;
  /** 写真に人物が写っている */
  hasPersonPhoto: boolean;
  /** 公開確認が必要な写真がある */
  needsPublicCheck: boolean;
  /** 文字数の上限（超えたら要確認。生成全体は失敗させない） */
  maxChars: number | null;
  /** AIが自分で気づいた懸念（参考情報。判定の権限はサーバー側） */
  aiFlags?: string[];
  /** AIが伏せた箇所（画面に出して人が確認する） */
  anonymizedNotes?: string[];
}

/**
 * 要確認にすべきか判定する。
 * 元原稿と生成本文の両方を見る（生成で新しく出た語も拾う）。
 */
export function evaluateReview(input: ReviewInput): {
  needsReview: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  reasons.push(...buildReviewReasons(detectSensitive(input.sourceBody)));

  for (const reason of buildReviewReasons(detectSensitive(input.channelBody))) {
    if (!reasons.includes(reason)) reasons.push(reason);
  }

  if (input.hasPersonPhoto) {
    reasons.push("人物が写っている写真があります。公開してよいか確認してください");
  }
  if (input.needsPublicCheck) {
    reasons.push("公開の確認が必要と登録された写真があります");
  }

  const length = input.channelBody.length;
  if (input.maxChars !== null && length > input.maxChars) {
    reasons.push(`文字数が上限を超えています（${length}字 / 上限${input.maxChars}字）`);
  }

  for (const flag of input.anonymizedNotes ?? []) {
    reasons.push(`AIが伏せた箇所があります：${flag}`);
  }
  for (const flag of input.aiFlags ?? []) {
    const reason = `AIが気づいた懸念：${flag}`;
    if (!reasons.includes(reason)) reasons.push(reason);
  }

  return { needsReview: reasons.length > 0, reasons };
}
