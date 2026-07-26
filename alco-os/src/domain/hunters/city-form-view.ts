import { describeWeight } from "./weight-service";

/**
 * 有害鳥獣捕獲票の表示用データ整形（館山有害鳥獣対策協議会様式）。
 *
 * 既存アプリ（capture-form.html の cityFormPrint）と**同じ様式**をALCO OS側で
 * 出すための純関数。判定ロジックだけを切り出してテストできるようにしている。
 */

export interface CityFormRow {
  species: string | null;
  capture_method: string | null;
  capture_date: string | null;
  capture_lat: number | null;
  capture_lng: number | null;
  weight_kg: number | null;
  weight_measure: string | null;
  sex: string | null;
  is_juvenile: boolean | null;
  body_length_cm: number | null;
  trap_number: string | null;
  bait_type: string | null;
  trap_set_date: string | null;
  finishing_method: string | null;
  disposal_method: string | null;
  capture_place: string | null;
  hunter_name: string | null;
  hunter_phone: string | null;
}

/** 既存様式の獣種チェック欄（並び順も既存に合わせる） */
export const SPECIES_LIST = [
  "イノシシ",
  "ニホンジカ",
  "キョン",
  "ハクビシン",
  "アライグマ",
  "アカゲザル",
  "ニホンザル",
  "タヌキ",
  "ノウサギ",
] as const;

export function speciesMatches(name: string, species: string | null): boolean {
  if (!species) return false;
  return species === name || (name === "ニホンジカ" && species === "シカ");
}

/** 令和の年月日に分解する。日付が無ければ全角スペース */
export function toEra(date: string | null): [string, string, string] {
  if (!date) return ["　", "　", "　"];
  const parts = String(date).split("-");
  if (parts.length < 3) return ["　", "　", "　"];
  const year = Number(parts[0]) - 2018;
  return [String(year), String(Number(parts[1])), String(Number(parts[2]))];
}

export function checkbox(condition: boolean): string {
  return condition ? "■" : "□";
}

/** 「その他特記事項」に入れる文言（体重が推定ならその旨を必ず出す） */
export function buildRemarks(row: CityFormRow): string {
  const parts: string[] = [];
  const weight = describeWeight(row.weight_kg, row.weight_measure);
  if (row.weight_measure === "estimated") {
    parts.push(`体重 ${weight}（計量していません）`);
  } else if (row.weight_kg !== null) {
    parts.push(`体重 ${weight}`);
  }
  return parts.join(" / ");
}

/** 地理院タイルの座標変換（既存 capture-form.html と同じ計算） */
export const TILE_SIZE = 256;

export function lngToX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * Math.pow(2, zoom);
}

export function latToY(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, zoom);
}

export interface MapTile {
  url: string;
  left: number;
  top: number;
}

/** 中心座標のまわりのタイルを並べる（外部ライブラリなし・既存と同じ地理院タイル） */
export function buildMapTiles(
  lat: number,
  lng: number,
  options: { zoom?: number; width?: number; height?: number } = {},
): MapTile[] {
  const zoom = options.zoom ?? 15;
  const width = options.width ?? 640;
  const height = options.height ?? 400;
  const cx = lngToX(lng, zoom) * TILE_SIZE;
  const cy = latToY(lat, zoom) * TILE_SIZE;
  const tiles: MapTile[] = [];

  for (let tx = Math.floor((cx - width / 2) / TILE_SIZE); tx <= Math.floor((cx + width / 2) / TILE_SIZE); tx++) {
    for (let ty = Math.floor((cy - height / 2) / TILE_SIZE); ty <= Math.floor((cy + height / 2) / TILE_SIZE); ty++) {
      tiles.push({
        url: `https://cyberjapandata.gsi.go.jp/xyz/std/${zoom}/${tx}/${ty}.png`,
        left: Math.round(tx * TILE_SIZE - (cx - width / 2)),
        top: Math.round(ty * TILE_SIZE - (cy - height / 2)),
      });
    }
  }
  return tiles;
}
