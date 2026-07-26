import { describe, it, expect } from "vitest";
import {
  FORM_TEMPLATE_LINES,
  REQUIRED_FIELD_LABELS,
  mergeFields,
  missingRequiredFields,
  parseCaptureForm,
  parseJapaneseDate,
  EMPTY_FIELDS,
} from "@/domain/hunters/capture-form-parser";
import {
  buildShareUrl,
  generateShareToken,
  isShareLinkValid,
  SHARE_TOKEN_DAYS,
} from "@/domain/hunters/capture-share-service";
import {
  buildMapTiles,
  buildRemarks,
  checkbox,
  speciesMatches,
  toEra,
  type CityFormRow,
} from "@/domain/hunters/city-form-view";
import { missingCityFormPhotos } from "@/domain/hunters/capture-photo-service";

const TODAY = new Date("2026-07-26T09:00:00+09:00");

describe("定型文パーサ（AI不使用）", () => {
  it("型がそのまま埋まれば全項目を読む", () => {
    const text = [
      "獣種：イノシシ",
      "捕獲方法：くくり罠",
      "場所：館山市山本",
      "捕獲日：2026-07-25",
      "体重：45",
      "体重の測り方：センターで計量",
      "性別：オス",
      "幼獣：成獣",
      "体長：120",
      "止め刺し：銃",
    ].join("\n");

    const { fields, filledCount } = parseCaptureForm(text, TODAY);
    expect(filledCount).toBeGreaterThan(0);
    expect(fields.species).toBe("イノシシ");
    expect(fields.captureMethod).toBe("くくり罠");
    expect(fields.capturePlace).toBe("館山市山本");
    expect(fields.captureDate).toBe("2026-07-25");
    expect(fields.weightKg).toBe(45);
    expect(fields.weightMeasure).toBe("center");
    expect(fields.sex).toBe("オス");
    expect(fields.isJuvenile).toBe(false);
    expect(fields.bodyLengthCm).toBe(120);
    expect(fields.finishingMethod).toBe("銃");
  });

  it("半角コロン・全角空白・言い換えラベルを吸収する", () => {
    const text = ["種類 :　いのしし", "とり方＝箱わな", "捕獲場所：　富崎", "重さ：60キロ"].join(
      "\r\n",
    );
    const { fields } = parseCaptureForm(text, TODAY);
    expect(fields.species).toBe("イノシシ");
    expect(fields.captureMethod).toBe("箱罠");
    expect(fields.capturePlace).toBe("富崎");
    expect(fields.weightKg).toBe(60);
  });

  it("日付3表記を読む", () => {
    expect(parseJapaneseDate("令和8年7月1日", TODAY)).toBe("2026-07-01");
    expect(parseJapaneseDate("2026-07-01", TODAY)).toBe("2026-07-01");
    expect(parseJapaneseDate("7/1", TODAY)).toBe("2026-07-01");
    expect(parseJapaneseDate("７月１日", TODAY)).toBe("2026-07-01");
    expect(parseJapaneseDate("あした", TODAY)).toBeNull();
  });

  it("体重の行に測り方が混ざっていても読む", () => {
    const { fields } = parseCaptureForm("体重：45kg 推定", TODAY);
    expect(fields.weightKg).toBe(45);
    expect(fields.weightMeasure).toBe("estimated");
  });

  it("空欄のラベルは値なしとして扱い、型として認識する", () => {
    const { fields, filledCount, blankLabels } = parseCaptureForm(
      ["獣種：イノシシ", "体長：", "餌："].join("\n"),
      TODAY,
    );
    expect(filledCount).toBeGreaterThan(0);
    expect(fields.bodyLengthCm).toBeNull();
    expect(blankLabels.length).toBe(2);
  });

  it("ラベルが1つも無ければ「型ではない」（AIへ回す合図）", () => {
    expect(parseCaptureForm("きょうは山の上でとれました", TODAY).filledCount).toBe(0);
    expect(parseCaptureForm("", TODAY).filledCount).toBe(0);
  });

  it("型の見出しには捕獲日が含まれる", () => {
    expect(FORM_TEMPLATE_LINES).toContain("捕獲日：");
  });
});

describe("必須項目の判定", () => {
  const base = {
    ...EMPTY_FIELDS,
    species: "イノシシ",
    captureMethod: "くくり罠" as string | null,
    capturePlace: "館山市山本",
    captureDate: "2026-07-25",
    sex: "オス",
    weightKg: 45,
    weightMeasure: "center" as const,
    finishingMethod: "銃",
  };

  it("そろっていれば不足なし", () => {
    expect(missingRequiredFields(base)).toEqual([]);
  });

  it("箱罠のときだけ わな番号 が必須になる", () => {
    expect(missingRequiredFields({ ...base, captureMethod: "箱罠" })).toEqual(["trapNumber"]);
    expect(
      missingRequiredFields({ ...base, captureMethod: "箱罠", trapNumber: "12" }),
    ).toEqual([]);
  });

  it("体長・餌・わな設置日・幼獣は任意", () => {
    expect(
      missingRequiredFields({
        ...base,
        bodyLengthCm: null,
        baitType: null,
        trapSetDate: null,
        isJuvenile: null,
      }),
    ).toEqual([]);
  });

  it("不足項目には捕獲者向けの分かりやすい説明がある", () => {
    const missing = missingRequiredFields({ ...EMPTY_FIELDS });
    expect(missing.length).toBeGreaterThan(0);
    for (const key of missing) {
      expect(REQUIRED_FIELD_LABELS[key].length).toBeGreaterThan(0);
    }
  });

  it("既に保存済みの値は新しい入力で消えない", () => {
    const merged = mergeFields(
      { species: "イノシシ", weightKg: 45 },
      { ...EMPTY_FIELDS, sex: "オス" },
    );
    expect(merged.species).toBe("イノシシ");
    expect(merged.weightKg).toBe(45);
    expect(merged.sex).toBe("オス");
  });
});

describe("写真は2枚（フェーズ3）", () => {
  it("尻尾の前後だけを必須にする。全体写真は求めない", () => {
    expect(missingCityFormPhotos([])).toEqual(["tail_before", "tail_after"]);
    expect(
      missingCityFormPhotos([
        { id: "1", fileId: "f1", photoKind: "tail_before", sortOrder: 0 },
        { id: "2", fileId: "f2", photoKind: "tail_after", sortOrder: 1 },
      ]),
    ).toEqual([]);
    // 全体写真だけでは足りない
    expect(
      missingCityFormPhotos([{ id: "1", fileId: "f1", photoKind: "whole", sortOrder: 0 }]),
    ).toEqual(["tail_before", "tail_after"]);
  });
});

describe("共有リンク", () => {
  it("トークンは推測しにくい長さで、毎回変わる", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a.length).toBe(32);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("有効・期限切れ・無効を判定する", () => {
    const now = new Date("2026-07-26T00:00:00Z");
    const future = new Date(now.getTime() + 10 * 86400000).toISOString();
    const past = new Date(now.getTime() - 1000).toISOString();

    expect(isShareLinkValid("token", future, now)).toBe(true);
    expect(isShareLinkValid("token", past, now)).toBe(false);
    expect(isShareLinkValid(null, future, now)).toBe(false);
    expect(isShareLinkValid("token", null, now)).toBe(false);
  });

  it("期限は30日", () => {
    expect(SHARE_TOKEN_DAYS).toBe(30);
  });

  it("URLは公開ページの形になる。siteUrl未設定なら空", () => {
    expect(buildShareUrl("https://alco-os.vercel.app", "abc")).toBe(
      "https://alco-os.vercel.app/hunter/city-form/abc",
    );
    expect(buildShareUrl("", "abc")).toBe("");
  });
});

describe("捕獲票の表示（既存様式）", () => {
  const row: CityFormRow = {
    species: "シカ",
    capture_method: "くくり罠",
    capture_date: "2026-07-25",
    capture_lat: 34.99,
    capture_lng: 139.87,
    weight_kg: 45,
    weight_measure: "estimated",
    sex: "オス",
    is_juvenile: false,
    body_length_cm: 120,
    trap_number: null,
    bait_type: null,
    trap_set_date: null,
    finishing_method: "銃",
    disposal_method: "販売（館山ジビエセンター）",
    capture_place: "館山市山本",
    hunter_name: "山田 太郎",
    hunter_phone: "0470-00-0000",
  };

  it("シカは既存様式の「ニホンジカ」にチェックが入る", () => {
    expect(speciesMatches("ニホンジカ", "シカ")).toBe(true);
    expect(speciesMatches("イノシシ", "シカ")).toBe(false);
  });

  it("令和に変換する。日付が無ければ空欄", () => {
    expect(toEra("2026-07-25")).toEqual(["8", "7", "25"]);
    expect(toEra(null)).toEqual(["　", "　", "　"]);
  });

  it("推定体重は特記事項に必ず出る", () => {
    expect(buildRemarks(row)).toContain("推定");
    expect(buildRemarks({ ...row, weight_measure: "center" })).not.toContain("推定");
  });

  it("チェックボックスの記号", () => {
    expect(checkbox(true)).toBe("■");
    expect(checkbox(false)).toBe("□");
  });

  it("地図タイルは地理院タイルを組み立てる", () => {
    const tiles = buildMapTiles(34.99, 139.87);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles[0].url).toContain("cyberjapandata.gsi.go.jp");
  });
});
