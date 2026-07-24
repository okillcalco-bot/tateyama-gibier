import type { Row } from "@/lib/db/port";

/**
 * ジビエ在庫管理システムとの品目カタログ連携。
 * - products: 完成品マスタ（在庫数 stock_qty が正 — docs/09）
 * - price_master: 部位単価（standard / premium / wholesale の3ランク）
 * - customers.price_rank: 顧客ごとの適用ランク
 * ALCO OS は読み取り専用で参照し、在庫の増減は既存システムに任せる。
 */

export interface CatalogItem {
  key: string;
  kind: "product" | "part"; // 完成品 / 部位（kg単価）
  productId: string | null; // products.id（部位は null）
  name: string;
  unit: string; // 個・パック等 / kg
  price: number; // 適用ランクの単価
  stockQty: number | null; // 完成品のみ
  species: string | null;
  partName: string | null;
}

export type PriceRank = "standard" | "premium" | "wholesale";

/** price_master の行から顧客ランクに応じた単価を選ぶ */
export function priceForRank(row: Row, rank: PriceRank): number {
  const map: Record<PriceRank, unknown> = {
    standard: row.price_standard,
    premium: row.price_premium,
    wholesale: row.price_wholesale,
  };
  const price = Number(map[rank]);
  // ランク価格が未設定(0)なら standard にフォールバック
  return price > 0 ? price : Number(row.price_standard) || 0;
}

/** products + price_master → 帳票・伝票の品目ピッカー用カタログ */
export function buildGibierCatalog(
  products: Row[],
  priceMaster: Row[],
  rank: PriceRank = "standard",
): CatalogItem[] {
  const productItems: CatalogItem[] = products
    .filter((p) => !p.deleted_at)
    .map((p) => ({
      key: `product:${p.id}`,
      kind: "product" as const,
      productId: p.id as string,
      name: p.name as string,
      unit: (p.unit as string) || "個",
      price: Number(p.price) || 0,
      stockQty: Number(p.stock_qty) || 0,
      species: null,
      partName: null,
    }));

  const partItems: CatalogItem[] = priceMaster.map((row) => ({
    key: `part:${row.id}`,
    kind: "part" as const,
    productId: null,
    name: `${row.species} ${row.part_name}`,
    unit: "kg",
    price: priceForRank(row, rank),
    stockQty: null,
    species: (row.species as string) ?? null,
    partName: (row.part_name as string) ?? null,
  }));

  return [...productItems, ...partItems];
}
