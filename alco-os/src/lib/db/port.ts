/**
 * DBポート（Repositoryの最小インターフェース）。
 *
 * ドメインサービスは Supabase クライアントに直接依存せず、この Port に依存する。
 * - 本番: SupabaseDb（lib/db/supabase-db.ts）
 * - テスト: InMemoryDb（tests/helpers/in-memory-db.ts）
 *
 * 意図的に表面積を小さくしている。複雑なクエリが必要になったら
 * このポートにメソッドを足すのではなく、専用のクエリ関数を
 * features/ 側に書き、書き込み系だけをドメインサービスに通すこと。
 */
export type Row = Record<string, unknown>;

export interface DbPort {
  insert(table: string, row: Row): Promise<Row>;
  update(table: string, id: string, patch: Row): Promise<Row>;
  findById(table: string, id: string): Promise<Row | null>;
  findMany(table: string, filter: Row, limit?: number): Promise<Row[]>;
}
