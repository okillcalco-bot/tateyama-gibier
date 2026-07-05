import { describe, it, expect } from "vitest";
import {
  voiceMemoInputSchema,
  voiceMemoOutputSchema,
} from "@/ai/schemas/voice-memo.schema";

describe("voiceMemoInputSchema", () => {
  it("正常な入力を受け付ける", () => {
    const result = voiceMemoInputSchema.parse({
      raw_text: "湿地でアカガエルを確認",
      source_type: "field_note",
    });
    expect(result.raw_text).toContain("アカガエル");
  });

  it("空のメモ本文を拒否する", () => {
    expect(() =>
      voiceMemoInputSchema.parse({ raw_text: "", source_type: "text_memo" }),
    ).toThrow();
  });

  it("不正な source_type を拒否する", () => {
    expect(() =>
      voiceMemoInputSchema.parse({ raw_text: "メモ", source_type: "unknown" }),
    ).toThrow();
  });
});

describe("voiceMemoOutputSchema", () => {
  const valid = {
    summary: "要約",
    detected_category: "task",
    suggested_tasks: [{ title: "連絡する", due_date: null, priority: "high" }],
    generated_draft: "ドラフト",
    confidence: 0.9,
    needs_human_review: true,
    warnings: [],
  };

  it("正常な出力を受け付け、省略項目にデフォルトを入れる", () => {
    const result = voiceMemoOutputSchema.parse(valid);
    expect(result.nature_records).toEqual([]);
    expect(result.suggested_tasks[0].priority).toBe("high");
  });

  it("未知のカテゴリを拒否する", () => {
    expect(() =>
      voiceMemoOutputSchema.parse({ ...valid, detected_category: "invalid_category" }),
    ).toThrow();
  });

  it("confidence の範囲外を拒否する", () => {
    expect(() => voiceMemoOutputSchema.parse({ ...valid, confidence: 1.5 })).toThrow();
  });
});
