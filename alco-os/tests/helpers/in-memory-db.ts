import type { DbPort, Row } from "@/lib/db/port";

/**
 * テスト用インメモリ DbPort 実装。
 * 実DBと同様に、返すレコードは常にスナップショット（コピー）にする。
 */
export class InMemoryDb implements DbPort {
  tables = new Map<string, Row[]>();
  private counter = 0;

  private rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  async insert(table: string, row: Row): Promise<Row> {
    const record = structuredClone({ id: `${table}-${++this.counter}`, ...row });
    this.rows(table).push(record);
    return structuredClone(record);
  }

  async update(table: string, id: string, patch: Row): Promise<Row> {
    const record = this.rows(table).find((r) => r.id === id);
    if (!record) throw new Error(`not found: ${table}/${id}`);
    Object.assign(record, structuredClone(patch));
    return structuredClone(record);
  }

  async delete(table: string, id: string): Promise<void> {
    const rows = this.rows(table);
    const index = rows.findIndex((r) => r.id === id);
    if (index === -1) throw new Error(`not found: ${table}/${id}`);
    rows.splice(index, 1);
  }

  async findById(table: string, id: string): Promise<Row | null> {
    const record = this.rows(table).find((r) => r.id === id);
    return record ? structuredClone(record) : null;
  }

  async findMany(table: string, filter: Row, limit = 100): Promise<Row[]> {
    return this.rows(table)
      .filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
}
