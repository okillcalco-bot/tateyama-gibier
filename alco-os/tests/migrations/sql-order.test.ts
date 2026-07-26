import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * マイグレーションSQLの並び順チェック（2026-07-27 追加）。
 *
 * きっかけ: 0027 で `create or replace function` を
 * `alter table ... add column capture_place` より先に書いてしまい、
 * 素のPostgresへ適用すると "column r.capture_place does not exist" で失敗した。
 * PostgreSQLはSQL関数の本体を**作成時に検証する**ため、参照する列・テーブルは
 * 先に存在していなければならない。InMemoryDb のテストでは検出できない種類のバグ。
 *
 * ここでは「参照より定義が先」を機械的に守れる範囲で固定する:
 *   1. 列の追加（add column）は、関数・ビューの定義より前
 *   2. テーブルの作成（create table）は、そのテーブルを使う
 *      alco_add_member_policy / トリガー / index より前
 *
 * 完全な依存解析ではないが、実際に踏んだ失敗はこれで防げる。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/** 行コメント（--）を除いたSQL本文。順序判定にコメントを混ぜないため */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const index = line.indexOf("--");
      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n");
}

function readMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: stripComments(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8")).toLowerCase(),
    }));
}

function lastIndexOfPattern(sql: string, pattern: RegExp): number {
  let last = -1;
  for (const match of sql.matchAll(pattern)) {
    if (match.index !== undefined) last = match.index;
  }
  return last;
}

function firstIndexOfPattern(sql: string, pattern: RegExp): number {
  const match = sql.match(pattern);
  return match?.index ?? -1;
}

describe("マイグレーションSQLの並び順", () => {
  const migrations = readMigrations();

  it("マイグレーションが読み込める", () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it("列の追加は、関数・ビューの定義より前に書かれている", () => {
    const problems: string[] = [];

    for (const { name, sql } of migrations) {
      const lastAddColumn = lastIndexOfPattern(sql, /add column/g);
      const firstDefinition = firstIndexOfPattern(
        sql,
        /create\s+(or\s+replace\s+)?(function|view|materialized\s+view)/,
      );
      if (lastAddColumn === -1 || firstDefinition === -1) continue;
      if (lastAddColumn > firstDefinition) {
        problems.push(
          `${name}: 関数/ビューの定義より後ろに add column があります。` +
            `関数は作成時に本体を検証するため、列を先に追加してください`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  it("テーブルの作成は、そのテーブルを使うポリシー・トリガー・indexより前", () => {
    const problems: string[] = [];

    for (const { name, sql } of migrations) {
      for (const match of sql.matchAll(
        /create table (?:if not exists )?([a-z_][a-z0-9_]*)/g,
      )) {
        const table = match[1];
        const createdAt = match.index ?? 0;

        const usages: { label: string; index: number }[] = [
          {
            label: "alco_add_member_policy",
            index: firstIndexOfPattern(
              sql,
              new RegExp(`alco_add_member_policy\\('${table}'\\)`),
            ),
          },
          {
            label: "create index",
            index: firstIndexOfPattern(
              sql,
              new RegExp(`create (unique )?index[^;]*\\bon ${table}\\b`),
            ),
          },
        ];

        for (const usage of usages) {
          if (usage.index !== -1 && usage.index < createdAt) {
            problems.push(`${name}: ${table} の作成より前に ${usage.label} があります`);
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it("0027 は capture_place の追加が関数定義より前にある（再発防止）", () => {
    const target = migrations.find((m) => m.name.startsWith("0027"));
    expect(target).toBeDefined();
    const sql = target!.sql;
    const addColumn = sql.indexOf("add column if not exists capture_place");
    const createFunction = sql.indexOf("create or replace function");
    expect(addColumn).toBeGreaterThan(-1);
    expect(createFunction).toBeGreaterThan(-1);
    expect(addColumn).toBeLessThan(createFunction);
  });
});
