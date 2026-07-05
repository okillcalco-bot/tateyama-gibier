import type { SupabaseClient } from "@supabase/supabase-js";
import type { DbPort, Row } from "./port";

/** Supabase 実装の DbPort。RLS はクライアント側の認証状態に従う。 */
export class SupabaseDb implements DbPort {
  constructor(private client: SupabaseClient) {}

  async insert(table: string, row: Row): Promise<Row> {
    const { data, error } = await this.client.from(table).insert(row).select().single();
    if (error) throw new Error(`insert(${table}) failed: ${error.message}`);
    return data as Row;
  }

  async update(table: string, id: string, patch: Row): Promise<Row> {
    const { data, error } = await this.client
      .from(table)
      .update(patch)
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(`update(${table}) failed: ${error.message}`);
    return data as Row;
  }

  async findById(table: string, id: string): Promise<Row | null> {
    const { data, error } = await this.client.from(table).select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`findById(${table}) failed: ${error.message}`);
    return (data as Row) ?? null;
  }

  async findMany(table: string, filter: Row, limit = 100): Promise<Row[]> {
    let query = this.client.from(table).select("*");
    for (const [key, value] of Object.entries(filter)) {
      query = query.eq(key, value);
    }
    const { data, error } = await query.limit(limit);
    if (error) throw new Error(`findMany(${table}) failed: ${error.message}`);
    return (data ?? []) as Row[];
  }
}
