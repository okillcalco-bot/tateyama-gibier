import { describe, it, expect, beforeEach } from "vitest";
import {
  csvTemplate,
  describeBankAccount,
  importHunterProfilesCsv,
  maskAccountNumber,
  parseCsv,
  revealBankAccount,
  saveHunterBankAccount,
  saveHunterProfile,
} from "@/domain/hunters/hunter-profile-service";
import {
  describeWeight,
  buildWeightMemo,
  matchWeightMeasure,
  parseWeightKg,
} from "@/domain/hunters/weight-service";
import {
  buildCityMailSubject,
  buildCityMailBody,
  buildCityMailtoUrl,
  CITY_MAIL_TO,
} from "@/domain/hunters/city-mail-service";
import { InMemoryDb } from "../helpers/in-memory-db";

const ORG = "org-1";
const ctx = { organizationId: ORG, actorId: "staff-1" };

describe("体重の3パターン", () => {
  it("ボタンの文言から計測区分を読む", () => {
    expect(matchWeightMeasure("センターで計量")).toBe("center");
    expect(matchWeightMeasure("処理施設で計量")).toBe("facility");
    expect(matchWeightMeasure("だいたいの重さ")).toBe("estimated");
    expect(matchWeightMeasure("推定です")).toBe("estimated");
    expect(matchWeightMeasure("こんにちは")).toBeNull();
  });

  it("数字は全角・単位つきでも読める。読めなければnull", () => {
    expect(parseWeightKg("45")).toBe(45);
    expect(parseWeightKg("45kg")).toBe(45);
    expect(parseWeightKg("４５．５キロ")).toBe(45.5);
    expect(parseWeightKg("約60くらい")).toBe(60);
    expect(parseWeightKg("わからない")).toBeNull();
    expect(parseWeightKg("9999")).toBeNull();
  });

  it("推定のときは表示に必ず「推定値」と出る", () => {
    expect(describeWeight(45, "estimated")).toContain("推定値");
    expect(describeWeight(45, "center")).toContain("ジビエセンターで計量");
    expect(describeWeight(null, "estimated")).toContain("数値未入力");
  });

  it("推定は個体のmemoにも残す（既存の捕獲票の特記事項に出るため）", () => {
    expect(buildWeightMemo(45, "estimated")).toContain("推定値");
    expect(buildWeightMemo(45, "center")).toContain("ジビエセンターで計量");
    expect(buildWeightMemo(45, null)).toBe("");
  });
});

describe("市役所へのメール", () => {
  const params = {
    hunterName: "山田 太郎",
    captureDate: "2026-07-26",
    species: "イノシシ",
    labelId: "仮-ABC",
    sender: "staff" as const,
  };

  it("宛先は農水産課", () => {
    expect(CITY_MAIL_TO).toBe("nousuisanka@city.tateyama.chiba.jp");
    expect(buildCityMailtoUrl(params).startsWith(`mailto:${CITY_MAIL_TO}?`)).toBe(true);
  });

  it("件名に捕獲者・日付・獣種が入る", () => {
    const subject = buildCityMailSubject(params);
    expect(subject).toContain("山田 太郎");
    expect(subject).toContain("2026/07/26");
    expect(subject).toContain("イノシシ");
  });

  it("職員代行と本人送信で文面が変わる", () => {
    expect(buildCityMailBody(params)).toContain("代わり");
    expect(buildCityMailBody({ ...params, sender: "hunter" })).toContain("山田 太郎 です");
  });

  it("本文に添付の案内と尾の提出の注意が入る", () => {
    const body = buildCityMailBody(params);
    expect(body).toContain("PDFを添付");
    expect(body).toContain("尾");
  });
});

describe("口座の取り扱い（B案）", () => {
  let db: InMemoryDb;
  let hunterId: string;

  beforeEach(async () => {
    db = new InMemoryDb();
    const hunter = await db.insert("hunters", { name: "山田 太郎" });
    hunterId = hunter.id as string;
  });

  it("口座番号は下4桁だけ見せる", () => {
    expect(maskAccountNumber("1234567")).toBe("***4567");
    expect(maskAccountNumber("")).toBe("未登録");
    expect(maskAccountNumber("12")).toBe("****12");
  });

  it("一覧の要約に口座番号がそのまま出ない", () => {
    const text = describeBankAccount({ bank_name: "館山銀行", account_number: "1234567" });
    expect(text).toContain("館山銀行");
    expect(text).not.toContain("1234567");
  });

  it("口座は既存 hunters の欄に保存し、監査ログに番号を残さない", async () => {
    await saveHunterBankAccount(db, ctx, {
      hunterId,
      bankName: "館山銀行",
      bankBranch: "本店",
      accountType: "普通",
      accountNumber: "1234567",
      accountHolder: "ヤマダ タロウ",
    });

    const hunter = await db.findById("hunters", hunterId);
    expect(hunter?.account_number).toBe("1234567");
    // 追加情報テーブルには口座を入れない
    expect(db.tables.get("hunter_profiles")).toBeUndefined();

    const log = (db.tables.get("audit_logs") ?? [])[0];
    expect(String(log.note)).not.toContain("1234567");
    expect(String(log.note)).toContain("***4567");
  });

  it("フル表示は監査ログに残る", async () => {
    await revealBankAccount(db, ctx, hunterId);
    const log = (db.tables.get("audit_logs") ?? [])[0];
    expect(log.action).toBe("export");
    expect(String(log.note)).toContain("口座情報を表示");
  });
});

describe("追加情報とCSVインポート", () => {
  let db: InMemoryDb;

  beforeEach(async () => {
    db = new InMemoryDb();
    await db.insert("hunters", { name: "山田 太郎" });
    await db.insert("hunters", { name: "鈴木 花子" });
    await db.insert("hunters", { name: "重複 太郎" });
    await db.insert("hunters", { name: "重複 太郎" });
  });

  it("1捕獲者につき1行（2回保存しても増えない）", async () => {
    const hunter = (await db.findMany("hunters", { name: "山田 太郎" }, 1))[0];
    await saveHunterProfile(db, ctx, { hunterId: hunter.id as string, address: "館山市A" });
    await saveHunterProfile(db, ctx, { hunterId: hunter.id as string, address: "館山市B" });

    const rows = db.tables.get("hunter_profiles") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("館山市B");
  });

  it("CSVの見出しが違えば取り込まない", async () => {
    await expect(importHunterProfilesCsv(db, ctx, "名前,住所\nA,B\n")).rejects.toThrow(
      /見出し行/,
    );
  });

  it("台帳にいる人だけ取り込み、いない人・同名複数は飛ばす", async () => {
    const csv =
      csvTemplate().split("\n")[0] +
      "\n" +
      "山田 太郎,1950-01-02,294-0000,館山市〇〇1-2-3,0470-00-0000,〇〇地区,あり,12345,\n" +
      "いない 人,1960-01-01,,,,,,,\n" +
      "重複 太郎,1970-01-01,,,,,,,\n";

    const { results, savedCount } = await importHunterProfilesCsv(db, ctx, csv);

    expect(savedCount).toBe(1);
    expect(results.find((r) => r.hunterName === "いない 人")?.reason).toContain("いません");
    expect(results.find((r) => r.hunterName === "重複 太郎")?.reason).toContain("複数");
    // 台帳に捕獲者を新規作成しない
    expect((db.tables.get("hunters") ?? []).length).toBe(4);

    const profile = (db.tables.get("hunter_profiles") ?? [])[0];
    expect(profile.address).toBe("館山市〇〇1-2-3");
    expect(profile.has_worker_card).toBe(true);
    expect(profile.source).toBe("csv");
  });

  it("CSVはダブルクォート内のカンマを壊さない", () => {
    const rows = parseCsv('捕獲者名,住所\n"山田, 太郎","館山市 1-2, 3"\n');
    expect(rows[1]).toEqual(["山田, 太郎", "館山市 1-2, 3"]);
  });
});
