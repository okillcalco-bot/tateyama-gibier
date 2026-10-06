// DB への接続。専用ロール seamalt_mcp（order_link.api_* の実行権限だけを持つ）で接続し、
// 許可した5関数以外は呼ばない。service_role・SUPABASE_DB_URL（管理者権限）は使わない。

const ALLOWED = new Set(['api_orders_search', 'api_orders_get', 'api_import_preview', 'api_import_commit', 'api_import_status']);

// pool: node-postgres 互換（query(text, params) → { rows }）
export function createDb(pool, { statementTimeoutMs = 15000 } = {}) {
  return {
    async callApi(fn, ctx, args) {
      if (!ALLOWED.has(fn)) throw new Error('function not allowed');
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`set local statement_timeout = ${Number(statementTimeoutMs) | 0}`);
        const { rows } = await client.query(`select order_link.${fn}($1::jsonb, $2::jsonb) as r`, [JSON.stringify(ctx), JSON.stringify(args)]);
        await client.query('commit');
        return rows[0].r;
      } catch (e) {
        try { await client.query('rollback'); } catch (_) {}
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
