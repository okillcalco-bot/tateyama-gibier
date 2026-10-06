// 小さな JSON Schema 検証器（このMCPのツール入力で使う範囲だけ: type / properties / required /
// additionalProperties:false / enum / const / minLength / maxLength / pattern / minimum / maximum /
// exclusiveMinimum / minItems / maxItems / items / format:uuid,date,date-time）。
// 依存パッケージを増やさないため自前で持つ。検証に失敗したら成功扱いにせず、どこが違うかを返す。

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function typeOk(v, t) {
  const actual = typeOf(v);
  if (Array.isArray(t)) return t.some(x => typeOk(v, x));
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}
function validDate(s) {
  if (!DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100;
}

export function validate(schema, value, path = '$', errors = []) {
  if (errors.length >= 20) return errors;
  if (schema.const !== undefined && value !== schema.const) { errors.push(`${path}: must be ${JSON.stringify(schema.const)}`); return errors; }
  if (schema.type && !typeOk(value, schema.type)) { errors.push(`${path}: expected ${[].concat(schema.type).join('|')}`); return errors; }
  if (value === null) return errors;
  if (schema.enum && !schema.enum.includes(value)) { errors.push(`${path}: must be one of ${schema.enum.join(', ')}`); return errors; }
  if (typeof value === 'string') {
    // 文字数は Unicode のコードポイントで数える（日本語を1文字として）
    const len = [...value].length;
    if (schema.minLength != null && len < schema.minLength) errors.push(`${path}: too short (min ${schema.minLength})`);
    if (schema.maxLength != null && len > schema.maxLength) errors.push(`${path}: too long (max ${schema.maxLength})`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: invalid format`);
    if (schema.format === 'uuid' && !UUID.test(value)) errors.push(`${path}: must be a UUID`);
    if (schema.format === 'date' && !validDate(value)) errors.push(`${path}: must be a real date YYYY-MM-DD`);
    if (schema.format === 'date-time' && (!DATETIME.test(value) || isNaN(Date.parse(value)))) errors.push(`${path}: must be ISO 8601 with time zone`);
    // 制御文字（改行・タブ以外）は受け付けない
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) errors.push(`${path}: control characters are not allowed`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(`${path}: must be finite`);
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errors.push(`${path}: must be > ${schema.exclusiveMinimum}`);
    if (schema['x-maxDecimals'] != null) {
      const dec = (String(value).split('.')[1] || '').length;
      if (dec > schema['x-maxDecimals']) errors.push(`${path}: at most ${schema['x-maxDecimals']} decimal places`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: at least ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: at most ${schema.maxItems} items`);
    if (schema.items) value.slice(0, 200).forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}.${k}: required`);
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: unknown property`);
    }
  }
  return errors;
}
