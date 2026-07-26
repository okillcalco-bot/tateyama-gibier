import { normalizeKeyword } from "./hunter-keywords";
import { matchWeightMeasure, parseWeightKg, type WeightMeasure } from "./weight-service";

/**
 * 捕獲報告の定型文パーサ（フェーズ3 / 要望2）。
 *
 * 「ラベル：値」を行ごとに読むだけの純関数。**AIは使わない**。
 * 高齢の捕獲者が1回で送れるようにするための仕組みなので、
 * 表記ゆれ（全角/半角コロン・空白・改行・ラベルの言い換え）を広く吸収する。
 *
 * ラベルが1つも取れなければ「型ではない自由文」として扱い、
 * 呼び出し側が従来のAI分類へフォールバックする。
 */

export interface CaptureFormFields {
  species: string | null;
  captureMethod: string | null;
  capturePlace: string | null;
  captureDate: string | null; // ISO (YYYY-MM-DD)
  weightKg: number | null;
  weightMeasure: WeightMeasure | null;
  sex: string | null;
  isJuvenile: boolean | null;
  bodyLengthCm: number | null;
  trapNumber: string | null;
  baitType: string | null;
  trapSetDate: string | null; // ISO
  finishingMethod: string | null;
}

export const EMPTY_FIELDS: CaptureFormFields = {
  species: null,
  captureMethod: null,
  capturePlace: null,
  captureDate: null,
  weightKg: null,
  weightMeasure: null,
  sex: null,
  isJuvenile: null,
  bodyLengthCm: null,
  trapNumber: null,
  baitType: null,
  trapSetDate: null,
  finishingMethod: null,
};

/** 型に出す項目（捕獲者へ見せる順番） */
export const FORM_TEMPLATE_LINES = [
  "獣種：",
  "捕獲方法：",
  "場所：",
  "捕獲日：",
  "体重：",
  "体重の測り方：",
  "性別：",
  "幼獣：",
  "体長：",
  "わな番号：",
  "餌：",
  "わな設置日：",
  "止め刺し：",
] as const;

type FieldKey = keyof CaptureFormFields;

/** ラベルの言い換え表。左から順に照合する */
const LABELS: { key: FieldKey | "weight" | "juvenile"; words: string[] }[] = [
  { key: "species", words: ["獣種", "種類", "動物", "けもの"] },
  { key: "captureMethod", words: ["捕獲方法", "とり方", "方法", "わなの種類"] },
  { key: "capturePlace", words: ["場所", "捕獲場所", "捕獲地", "地区", "大字"] },
  { key: "captureDate", words: ["捕獲日", "捕獲年月日", "日付", "とった日"] },
  { key: "weight", words: ["体重", "重さ", "重量"] },
  { key: "weightMeasure", words: ["体重の測り方", "測り方", "計量", "計測", "はかり方"] },
  { key: "sex", words: ["性別", "オスメス", "雌雄"] },
  { key: "juvenile", words: ["幼獣", "成獣", "幼獣か", "大人か"] },
  { key: "bodyLengthCm", words: ["体長", "長さ"] },
  { key: "trapNumber", words: ["わな番号", "箱わな番号", "罠番号", "番号"] },
  { key: "baitType", words: ["餌", "エサ", "えさ", "餌の種類"] },
  { key: "trapSetDate", words: ["わな設置日", "設置日", "仕掛けた日"] },
  { key: "finishingMethod", words: ["止め刺し", "止め刺し方法", "とめさし"] },
];

const SPECIES_WORDS: Record<string, string> = {
  イノシシ: "イノシシ",
  いのしし: "イノシシ",
  猪: "イノシシ",
  シカ: "シカ",
  しか: "シカ",
  鹿: "シカ",
  ニホンジカ: "シカ",
  キョン: "キョン",
  きょん: "キョン",
};

const METHOD_WORDS: { value: string; words: string[] }[] = [
  { value: "くくり罠", words: ["くくり罠", "くくりわな", "くくり", "括り罠"] },
  { value: "箱罠", words: ["箱罠", "箱わな", "はこわな", "檻"] },
  { value: "銃猟", words: ["銃猟", "銃", "鉄砲", "ライフル", "散弾"] },
];

const FINISHING_WORDS: { value: string; words: string[] }[] = [
  { value: "銃", words: ["銃", "鉄砲", "射殺"] },
  { value: "刺殺", words: ["刺殺", "ナイフ", "竹槍", "刺した"] },
  { value: "既に死亡", words: ["既に死亡", "死んでいた", "死亡"] },
];

/** 「ラベル：値」の区切り。全角コロン・半角コロン・全角読点にも対応 */
const SEPARATOR = /[:：=＝]/;

function splitLine(line: string): { label: string; value: string } | null {
  const match = line.split(SEPARATOR);
  if (match.length < 2) return null;
  const label = normalizeKeyword(match[0]);
  const value = match.slice(1).join(":").trim();
  if (!label) return null;
  return { label, value };
}

function matchLabel(label: string): (FieldKey | "weight" | "juvenile") | null {
  for (const entry of LABELS) {
    if (entry.words.some((word) => label === normalizeKeyword(word))) return entry.key;
  }
  for (const entry of LABELS) {
    if (
      entry.words.some(
        (word) => normalizeKeyword(word).length >= 2 && label.includes(normalizeKeyword(word)),
      )
    ) {
      return entry.key;
    }
  }
  return null;
}

export function normalizeSpecies(value: string): string | null {
  const normalized = normalizeKeyword(value);
  if (!normalized) return null;
  for (const [word, canonical] of Object.entries(SPECIES_WORDS)) {
    if (normalized.includes(word)) return canonical;
  }
  return value.trim() || null;
}

export function normalizeCaptureMethod(value: string): string | null {
  const normalized = normalizeKeyword(value);
  if (!normalized) return null;
  for (const { value: canonical, words } of METHOD_WORDS) {
    if (words.some((word) => normalized.includes(normalizeKeyword(word)))) return canonical;
  }
  return value.trim() || null;
}

export function normalizeFinishingMethod(value: string): string | null {
  const normalized = normalizeKeyword(value);
  if (!normalized) return null;
  for (const { value: canonical, words } of FINISHING_WORDS) {
    if (words.some((word) => normalized.includes(normalizeKeyword(word)))) return canonical;
  }
  return value.trim() || null;
}

export function normalizeSex(value: string): string | null {
  const normalized = normalizeKeyword(value);
  if (!normalized) return null;
  if (/オス|おす|雄|♂/.test(normalized)) return "オス";
  if (/メス|めす|雌|♀/.test(normalized)) return "メス";
  return null;
}

/**
 * 日付3表記に対応する。
 *   令和8年7月1日 / 2026-07-01 / 7/1（年の記載がなければ基準年）
 * 読めなければ null。
 */
export function parseJapaneseDate(value: string, today: Date = new Date()): string | null {
  const text = value
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[／]/g, "/");
  if (!text) return null;

  const iso = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const reiwa = text.match(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (reiwa) return toIso(2018 + Number(reiwa[1]), Number(reiwa[2]), Number(reiwa[3]));

  const jp = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (jp) return toIso(Number(jp[1]), Number(jp[2]), Number(jp[3]));

  const md = text.match(/^(\d{1,2})[/月-](\d{1,2})日?$/);
  if (md) return toIso(today.getFullYear(), Number(md[1]), Number(md[2]));

  return null;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface ParseResult {
  fields: CaptureFormFields;
  /** 値が取れた項目の数。0なら「型ではない」 */
  filledCount: number;
  /** ラベルは見つかったが値が空だった項目 */
  blankLabels: string[];
}

/** 定型文を読む。ラベルが1つも無ければ filledCount = 0 で返す */
export function parseCaptureForm(text: string, today: Date = new Date()): ParseResult {
  const fields: CaptureFormFields = { ...EMPTY_FIELDS };
  const blankLabels: string[] = [];
  let labelCount = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const parts = splitLine(rawLine);
    if (!parts) continue;
    const key = matchLabel(parts.label);
    if (!key) continue;
    labelCount++;
    if (!parts.value) {
      blankLabels.push(parts.label);
      continue;
    }

    switch (key) {
      case "species":
        fields.species = normalizeSpecies(parts.value);
        break;
      case "captureMethod":
        fields.captureMethod = normalizeCaptureMethod(parts.value);
        break;
      case "capturePlace":
        fields.capturePlace = parts.value.trim() || null;
        break;
      case "captureDate":
        fields.captureDate = parseJapaneseDate(parts.value, today);
        break;
      case "weight": {
        fields.weightKg = parseWeightKg(parts.value);
        // 「45kg センターで計量」のように1行で書かれることがある
        const inline = matchWeightMeasure(parts.value);
        if (inline && !fields.weightMeasure) fields.weightMeasure = inline;
        break;
      }
      case "weightMeasure":
        fields.weightMeasure = matchWeightMeasure(parts.value);
        break;
      case "sex":
        fields.sex = normalizeSex(parts.value);
        break;
      case "juvenile": {
        const normalized = normalizeKeyword(parts.value);
        if (/幼獣|こども|子|はい|あり/.test(normalized)) fields.isJuvenile = true;
        else if (/成獣|おとな|大人|いいえ|なし/.test(normalized)) fields.isJuvenile = false;
        break;
      }
      case "bodyLengthCm": {
        const number = parseWeightKg(parts.value); // 数字の読み取りは共通
        fields.bodyLengthCm = number;
        break;
      }
      case "trapNumber":
        fields.trapNumber = parts.value.trim() || null;
        break;
      case "baitType":
        fields.baitType = parts.value.trim() || null;
        break;
      case "trapSetDate":
        fields.trapSetDate = parseJapaneseDate(parts.value, today);
        break;
      case "finishingMethod":
        fields.finishingMethod = normalizeFinishingMethod(parts.value);
        break;
    }
  }

  const filledCount = Object.values(fields).filter((value) => value !== null).length;
  return { fields, filledCount: labelCount === 0 ? 0 : filledCount, blankLabels };
}

// ── 必須項目の判定 ──

export type RequiredField =
  | "species"
  | "captureMethod"
  | "capturePlace"
  | "captureDate"
  | "sex"
  | "weightKg"
  | "weightMeasure"
  | "finishingMethod"
  | "trapNumber";

export const REQUIRED_FIELD_LABELS: Record<RequiredField, string> = {
  species: "獣種（イノシシ・シカ・キョンなど）",
  captureMethod: "捕獲方法（くくり罠・箱罠・銃猟）",
  capturePlace: "捕獲した場所（地区・大字）",
  captureDate: "捕獲日",
  sex: "性別（オス・メス）",
  weightKg: "体重（数字）",
  weightMeasure: "体重の測り方（センター／処理施設／推定）",
  finishingMethod: "止め刺しの方法（銃／刺殺／既に死亡）",
  trapNumber: "箱わなの番号",
};

/** 不足している必須項目。箱罠のときだけ わな番号 も必須 */
export function missingRequiredFields(fields: CaptureFormFields): RequiredField[] {
  const missing: RequiredField[] = [];
  if (!fields.species) missing.push("species");
  if (!fields.captureMethod) missing.push("captureMethod");
  if (!fields.capturePlace) missing.push("capturePlace");
  if (!fields.captureDate) missing.push("captureDate");
  if (!fields.sex) missing.push("sex");
  if (fields.weightKg === null) missing.push("weightKg");
  if (!fields.weightMeasure) missing.push("weightMeasure");
  if (!fields.finishingMethod) missing.push("finishingMethod");
  if (fields.captureMethod === "箱罠" && !fields.trapNumber) missing.push("trapNumber");
  return missing;
}

/** 既に保存済みの行と、今回読み取った値を重ね合わせる（既存値を消さない） */
export function mergeFields(
  saved: Partial<CaptureFormFields>,
  parsed: CaptureFormFields,
): CaptureFormFields {
  const merged: CaptureFormFields = { ...EMPTY_FIELDS };
  for (const key of Object.keys(EMPTY_FIELDS) as (keyof CaptureFormFields)[]) {
    const next = parsed[key];
    const prev = saved[key];
    // @ts-expect-error 同じキー同士の代入
    merged[key] = next !== null && next !== undefined ? next : (prev ?? null);
  }
  return merged;
}
