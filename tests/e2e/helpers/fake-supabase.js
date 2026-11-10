// 画面の監査（tests/e2e/ui-audit.e2e.js）で使う道具。
//   ・respond(): 架空データを返す Supabase のモック。実データは一切使わない（名前・住所・金額はすべて作り物）。
//       select= で頼まれた列名から、それらしい値を作る。長い名前・長いメモ・切れ目の無いURL を混ぜて、
//       折り返しや、はみ出しを起こしやすくしてある。
//       mode: 'stress'（多めの架空データ）/ 'empty'（0件）/ 'error'（すべて通信失敗）
//   ・measure(): 画面の中で実行する測定（横はみ出し・押す場所の大きさ・小さい字・読みにくい色 など）
//   ・STUBS: サンドボックスから取りに行けない外部ライブラリの代わり
const COLS = {
  individuals: 'id,label_id,origin,species,capture_date,weight_total,notes,created_at,serial_number,capture_time,capture_city,weather,capture_method,finishing_method,hit_location,bleed_time,gutting,cooling_method,transport_start,receive_time,process_time,quality,recorder,hunter_name,hunter_health_ok,memo,age_estimate,sex,capture_area,deleted_at,intake_method,intake_staff,organs_use,hide_status,processing_notes,meat_rank,yield_rate,buyback_amount,purchase_payee,image_url,processing_done_at,intake_status,body_length_cm,is_juvenile,trap_number,bait_type,disposal_method,finisher_name,capture_lat,capture_lng,radiation_test_date,radiation_result_date,radiation_result,stopkill_pickup,butcher_staff,capture_koaza,special_notes,stomach_contents,stomach_note,hunter_name_public,capture_category',
  inventory: 'id,individual_id,part_name,barcode_num,weight,ident_code,status,operator,grade,unit_price,created_at,updated_at,individual_code,species,lot_code,processed_by,processed_at,weight_kg,deleted_at,tier,parent_inventory_id,process_type,location_code,scan_code',
  orders: 'id,order_code,customer_id,order_date,delivery_date,status,total_amount,notes,created_at,customer_name,delivery_time_zone,delivery_postal,delivery_address,delivery_building,delivery_name,delivery_phone,price_rank,memo,channel,updated_at,carrier,client_request_id',
  order_items: 'id,order_id,inventory_id,part_name,species,weight,unit_price,amount,created_at,product_id,weight_kg,subtotal,product_name,grade_snapshot,price_rank_applied,price_source,requested_kg,allocated_kg,pick_method,pick_checked_at,pick_checked_by',
  cleaning_logs: 'id,room,staff_name,cleaned_at,items,temperature,note,created_at',
  attendance: 'id,staff_id,staff_name,work_date,clock_in,clock_out,break_minutes,note,created_at,updated_at,health_in,health_out,work_types,stopkill_count,extra_km,extra_km_note',
  sale_event_items: 'id,event_id,kind,inventory_id,ident_code,individual_label,species,part_name,item_name,weight_kg,qty_taken,qty_sold,price_basis,unit_price,amount,note,created_at,lot_code,match_key,member_labels,product_id,stock_moved,qty_sample',
  processing_log: 'id,parent_ident_code,child_ident_code,weight,operator,created_at,process_type,result_weight_kg,individual_id',
  product_movements: 'id,product_id,product_name,movement_type,qty,staff_name,source_ident_code,note,created_at,destination',
  documents: 'id,doc_type,doc_number,customer_id,order_id,issue_date,due_date,total_amount,tax_amount,status,created_at,tax_category,payment_method,billing_status,partner_name,subject,honorific,partner_address,memo,source,snapshot,department',
  shipments: 'id,order_id,customer_id,shipment_date,delivery_date,status,notes,created_at,carrier,size_code,is_cool,freight,package_count',
  staff: 'id,name,color,created_at,is_active,role,phone,hire_date,employment_type,hourly_wage,monthly_salary,social_insurance,employment_insurance,memo,deleted_at,default_break_min,commute_round_km,commute_yen_per_km,stopkill_eligible',
  sale_events: 'id,event_date,end_date,venue_id,venue_name,title,start_time,end_time,weather,staff_names,visitors,booth_fee,other_cost,cash_total,note,status,created_at,updated_at,deleted_at,cashless_total',
  products: 'id,name,category,unit,price,stock_qty,base_item_id,base_url,memo,created_at,updated_at,deleted_at',
  price_master: 'id,species,part_name,barcode_num,grade,price_standard,price_premium,price_wholesale,created_at,price_local,price_startmember',
  waste_weighings: 'id,weighed_on,weighed_time,vehicle_no,trip_no,gross_kg,tare_kg,net_kg,waste_type,manifest_no,vendor_name,site_name,carrier_name,photo_path,note,recorded_by,created_at,updated_at,deleted_at',
  report_docs: 'id,doc_key,doc_title,category,period,status,created_by,approved_by,approved_at,reject_note,output_count,last_output_at,created_at,updated_at',
  hunters: 'id,name,city,trap_area,memo,created_at,updated_at,deleted_at,registry_number,registered_on,document_type,has_gun,furigana,name_public',
  document_orders: 'id,document_id,order_id,created_at',
  waste_checklists: 'id,checked_on,departure_time,staff_name,vehicle,items,all_ok,correction_note,created_at,deleted_at',
  supplies: 'id,name,category,unit,stock_qty,min_qty,supplier,memo,created_at,updated_at,deleted_at',
  shifts: 'id,staff_id,date,shift_type,start_time,end_time,note,created_at,updated_at',
  pest_control_logs: 'id,done_on,method,target,area,vendor,operator,result,measure,note,created_at',
  freezers: 'id,code,name,note,created_at',
  event_venues: 'id,name,kind,address,organizer,memo,is_active,sort_order,created_at,updated_at,deleted_at,lat,lng,consignment,commission_pct,bill_to,bill_to_address',
  equipment: 'id,mgmt_no,name,qty,location,purchased_on,price,funding,note,status,disposed_on,created_at,updated_at,deleted_at',
  data_flags: 'id,target,comment,flagged_by,status,created_at',
  customers: 'id,code,name,contact_name,email,phone,address,price_rank,notes,created_at,kana,building,honorific,default_time_zone,is_active,portal_enabled,is_starred,search_aliases,billing_method,department,mail_name,mail_honorific,mail_address',
  staff_board: 'id,title,body,author,pinned,created_at,deleted_at',
  sale_event_sheets: 'id,event_id,label_id,product_note,story_text,photo_path,updated_at',
  retail_outlets: 'id,name,email,memo,sort_order,is_active,created_at,deleted_at,delivery_notes,commission_pct',
  payments: 'id,document_id,paid_date,amount,method,note,created_at',
  meal_voices: 'id,scan_code,individual_label,nickname,rating,dish,comment,created_at,deleted_at,published_at,stamps,menu_id',
  field_photos: 'id,kind,note,staff_name,photo_path,taken_at,resolved_at,resolved_by,resolved_note,created_at',
  facility_check_logs: 'id,check_date,cycle,room,item,result,value,note,staff_name,created_at',
  city_report_inputs: 'month,kind,data,source,updated_by,updated_at',
  attendance_edits: 'id,attendance_id,staff_id,staff_name,work_date,before_in,before_out,before_break,after_in,after_out,after_break,reason,edited_by,editor_name,created_at',
  area_master: 'id,city,district,district_note,oaza,address_label,yomi,sort_order,created_at,lat,lng,road_km_roundtrip',
};
const TO_MANY = new Set(['order_items', 'shipments', 'document_items', 'document_orders', 'payments', 'inventory_allocations', 'sale_event_items', 'recipe_items', 'portal_product_parts', 'portal_product_prices']);
const NULLS = /^(deleted_at|revoked_at|canceled_at|withdrawn_at|resolved_at|disposed_on|locked_until|temp_expires_at|parent_inventory_id|reject_note|cancel_reason|canceled_by|aging_ended_at)$/;
const JSONB = /^(value|data|snapshot|conditions|allowances|dishes|nutrition|label|results|detail|column_map|before|after|content|approved_content|ai_suggestion|raw|issuer|external_ids|confidence_factors)$/;
const ARR = /^(search_aliases|default_carriers|stomach_contents|weekdays|tags|stamps|member_labels|label_ids|visible_ranks|channels|document_ids|warnings|target_roles|target_tiers|posted_channels)$/;
const BOOL = /^(is_|has_)|(_ok|_enabled|_public|_visible|_eligible)$|^(pinned|consent|consignment|stopkill_pickup|skip_holidays|must_change|all_ok|restricted|notify_delivery|always_available|reserve_only|needs_human_review)$/;
const pad = (n, w) => String(n).padStart(w, '0');
const uuid = n => `00000000-0000-4000-8000-${pad(n, 12)}`;
const TODAY = new Date('2026-11-10T03:00:00Z');
const dayStr = back => new Date(TODAY.getTime() - back * 86400000).toISOString().slice(0, 10);
const PARTS = ['ロース', '肩ロース', 'バラ', 'モモ（ウチ）', 'ペットフード用ミンチ（骨なし）', 'スライス肉（2mm） 300g', 'ヒレ', 'ミンチ用'];
const LONGNAME = ['架空食堂', '架空商店 南房総白浜本店 営業部（テスト用の長い名前）', '架空 太郎', '株式会社カクウフーズ・ホールディングス'];
const LONGTEXT = ['', '架空のメモです。', '架空の長いメモです。これは画面の折り返しや、はみ出しを確かめるための文章で、実際の記録ではありません。https://example.invalid/very/long/url/without/any/break/point/abcdefghijklmnopqrstuvwxyz'];
const STATUS = { inventory: ['在庫', '在庫', '出荷済', '加工済', '予約済'], orders: ['受注', '準備中', '発送済', '発送済'], documents: ['発行済', '下書き', '取消'], shipments: ['出荷済'], sale_events: ['確定', '下書き'], buyback_runs: ['下書き', '確定'], report_docs: ['作成中', '承認済'], equipment: ['使用中'], data_flags: ['open'], receipts: ['未確認', '確認済'] };

function val(table, col, i) {
  if (NULLS.test(col)) return null;
  if (JSONB.test(col)) return null;
  if (col === 'items') return table === 'cleaning_logs' ? '床・作業台・シンク' : [];
  if (ARR.test(col)) return [];
  if (col === 'id') return uuid(i + 1);
  if (col === 'label_id' || col === 'individual_label' || (col === 'individual_id' && /inventory|processing_log/.test(table)) || col === 'individual_code' || col === 'parent_ident_code') return `TGC-08-T9${pad(i % 7, 2)}`;
  if (/_id$/.test(col)) return uuid((i % 5) + 1);
  if (col === 'ident_code' || col === 'child_ident_code' || col === 'source_ident_code') return `TGC-08-T9${pad(i % 7, 2)}-RO-${i + 1}`;
  if (col === 'scan_code') return String(19000000 + i);
  if (col === 'order_code') return `DIR-20261110-${pad(i + 1, 6)}`;
  if (col === 'doc_number') return `INV-202611-9${pad(i, 2)}`;
  if (col === 'lot_code') return `T9${pad(i % 7, 2)}-RO-20261110-00${i % 9 + 1}`;
  if (col === 'code') return table === 'customers' ? `C9${pad(i, 3)}` : `F${i + 1}`;
  if (col === 'status') return (STATUS[table] || ['有効'])[i % (STATUS[table] || ['有効']).length];
  if (col === 'species' || col === 'raw_species') return ['イノシシ', 'シカ', 'キョン'][i % 3];
  if (col === 'part_name' || col === 'part' || col === 'process_type') return PARTS[i % PARTS.length];
  if (/^(grade|meat_rank|grade_snapshot|old_grade|new_grade)$/.test(col)) return ['並', '上', '極上'][i % 3];
  if (col === 'sex') return ['オス', 'メス'][i % 2];
  if (col === 'doc_type') return ['請求書', '納品書', '領収書'][i % 3];
  if (/price_rank/.test(col)) return ['standard', 'local', 'startmember'][i % 3];
  if (col === 'channel') return ['直販（注文なし）', 'メール', 'BASE'][i % 3];
  if (col === 'carrier') return ['ヤマト', '佐川'][i % 2];
  if (/city$/.test(col)) return ['館山市', '南房総市'][i % 2];
  if (col === 'month') return '2026-' + pad(11 - (i % 3), 2);
  if (col === 'color') return ['#3B82F6', '#EF4444', '#10B981'][i % 3];
  if (col === 'employment_type') return ['時給', '月給'][i % 2];
  if (col === 'honorific' || col === 'mail_honorific') return '様';
  if (col === 'movement_type') return ['完成', '店頭販売', '納品'][i % 3];
  if (col === 'radiation_result') return '検出下限値以下';
  if (col === 'intake_method') return ['搬入', '引取'][i % 2];
  if (col === 'capture_method') return ['くくり罠', '箱罠'][i % 2];
  if (col === 'kind') return ['A', 'B'][i % 2];
  if (BOOL.test(col)) return col === 'is_juvenile' || col === 'pinned' ? i % 4 === 0 : true;
  if (/^(clock_in|start_time|capture_time|receive_time|departure_time|weighed_time|before_in|after_in)$/.test(col)) return '08:30';
  if (/^(clock_out|end_time|process_time|before_out|after_out)$/.test(col)) return i % 4 === 3 ? null : '17:00';
  if (/_time$/.test(col)) return '09:15';
  if (/_at$/.test(col)) return new Date(TODAY.getTime() - i * 3600000 * 7).toISOString();
  if (/(_date|_on)$/.test(col) || col === 'date') return dayStr(i);
  if (/phone/.test(col)) return '000-0000-0000';
  if (/email/.test(col)) return 'test@example.invalid';
  if (/postal/.test(col)) return '000-0000';
  if (/address|location$/.test(col)) return '〒000-0000 架空県架空市架空町1-2-3 架空ビルディング 10階';
  if (/url|path$/.test(col)) return null;
  if ((table === 'staff' && col === 'name') || /^(staff_name|recorder|operator|processed_by|intake_staff|butcher_staff|edited_by|editor_name|recorded_by)$/.test(col)) return ['架空 太郎', '架空 花子', '試験 次郎'][i % 3];
  if (/^(name|title|subject)$|_name$|^(author|recorder|operator|processed_by|vendor|supplier|organizer|payee|purchase_payee|nickname|dish|destination|room|bill_to)$/.test(col)) return LONGNAME[i % LONGNAME.length] + (i > 3 ? i : '');
  if (/^(notes?|memo|body|comment|description|special_notes|processing_notes|story_text|reason|delivery_notes|correction_note|price_source|stomach_note|product_note)$/.test(col)) return LONGTEXT[i % LONGTEXT.length];
  if (/lat$/.test(col)) return 34.98 + i * 0.001;
  if (/lng$/.test(col)) return 139.86 + i * 0.001;
  if (col === 'weight_total' || col === 'gross_kg') return 45.5 + i * 3;
  if (/weight|_kg$|^qty_|^grams$/.test(col)) return Math.round((1.23 + i * 0.37) * 100) / 100;
  if (/pct$|^yield_rate$/.test(col)) return 32.5;
  if (/price|amount|total|subtotal|fee$|freight|salary|wage|cost|^balance$/.test(col)) return 1200 + i * 1375;
  if (/count$|^qty$|^stock_qty$|^visitors$|^rating$|^tier$|^round$|^seq$|^copy_no$|^trip_no$|^mgmt_no$/.test(col)) return col === 'tier' ? 2 : col === 'rating' ? 5 - (i % 3) : 3 + i;
  if (/minutes$|_min$/.test(col)) return 60;
  if (/^size_code$/.test(col)) return 100;
  if (/^serial_number$|^sort|^line_no$|^row_no$|^payee_no$|^food_no$/.test(col)) return i + 1;
  if (/km/.test(col)) return 12.5;
  if (/^(age_estimate|tax_rate|fiscal_year|probability|version|priority)$/.test(col)) return col === 'fiscal_year' ? 8 : col === 'tax_rate' ? 8 : 3;
  return 'テスト' + (i + 1);
}
// select= を 列 と 入れ子（rel(cols)）に分ける
function parseSelect(sel) {
  const out = []; let depth = 0, cur = '';
  for (const ch of sel) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; }
  if (cur) out.push(cur);
  return out.map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(?:([\w]+):)?([\w]+)(?:![\w]+)?\((.*)\)$/s);
    if (m) return { alias: m[1] || m[2], rel: m[2], sub: m[3] };
    const p = s.split(':'); const name = (p[1] || p[0]).split('::')[0].split('->')[0];
    return { alias: p[1] ? p[0] : name, col: name };
  });
}
function gen(table, sel, i, parent) {
  const row = {};
  const fields = (!sel || sel === '*') ? (COLS[table] || 'id,name,created_at').split(',').map(c => ({ alias: c, col: c })) : parseSelect(sel);
  for (const f of fields) {
    if (f.col === '*') { Object.assign(row, gen(table, '*', i)); continue; }
    if (f.rel) {
      const many = TO_MANY.has(f.rel) || (table === 'orders' && f.rel === 'documents') || (table === 'customers' && f.rel === 'orders');
      row[f.alias] = many ? [0, 1].map(k => gen(f.rel, f.sub, i * 2 + k, table)) : gen(f.rel, f.sub, i, table);
    } else row[f.alias] = val(table, f.col, i);
  }
  return row;
}
// 返事を作る。mode: stress（多めの架空データ）/ empty（空）/ error（すべて失敗）
function respond(url, method, mode) {
  const u = new URL(url); const path = decodeURIComponent(u.pathname);
  const J = (body, status, headers) => ({ status: status || 200, contentType: 'application/json', headers: Object.assign({ 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' }, headers || {}), body: JSON.stringify(body) });
  if (mode === 'error') return J({ message: 'mock failure', code: '500' }, 500);
  if (/\/auth\/v1\//.test(path)) return J({});
  if (/\/storage\/v1\//.test(path)) return J(method === 'GET' ? [] : { Key: 'mock' });
  if (/\/functions\/v1\//.test(path)) return J({});
  const rpc = path.match(/\/rest\/v1\/rpc\/([\w]+)/);
  if (rpc) {
    const n = rpc[1];
    if (/key_ok$/.test(n)) return J(true);
    if (n === 'tgc_reserve_scan_codes') return J(Array.from({ length: 20 }, (_, k) => String(19500000 + k)));
    if (mode === 'empty') return J([]);
    if (n === 'admin_payroll_list') return J({ lines: [0, 1, 2].map(k => ({ id: uuid(k + 1), month: '2026-10', staff_id: uuid(k + 1), staff_name: LONGNAME[(k + 2) % 4], hourly_wage: 1200, work_days: 20, work_hours: 140.25, stopkill_count: k, stopkill_unit: 3000, commute_round_km: 20, commute_count: 20, commute_yen_per_km: 20 })), staff: [0, 1, 2].map(k => ({ id: uuid(k + 1), name: LONGNAME[(k + 2) % 4], hourly_wage: 1200, is_active: true })), attendance: [], trips: [], trip_rates: [], bonuses: [], rates: {} });
    return J([]);
  }
  const m = path.match(/\/rest\/v1\/([\w]+)/);
  if (!m) return J([]);
  if (method !== 'GET' && method !== 'HEAD') return J([{ id: uuid(999) }], 201);
  if (mode === 'empty') return J([], 200, { 'content-range': '*/0' });
  const table = m[1]; const sel = u.searchParams.get('select');
  let n = 12; const lim = parseInt(u.searchParams.get('limit'), 10); if (lim && lim < n) n = lim;
  if (table === 'app_settings' || table === 'org_settings' || table === 'labor_notice_defaults') return J([]);
  const rows = Array.from({ length: n }, (_, i) => gen(table, sel, i));
  // eq / in / is フィルタに合うように値をそろえる
  for (const [k, v] of u.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'or', 'and'].includes(k)) continue;
    const eq = v.match(/^eq\.(.*)$/s), isn = v.match(/^is\.(null|true|false)$/), inn = v.match(/^in\.\((.*)\)$/s);
    for (const r of rows) {
      if (!(k in r)) continue;
      if (eq) r[k] = /^(true|false)$/.test(eq[1]) ? eq[1] === 'true' : (typeof r[k] === 'number' && !isNaN(+eq[1]) ? +eq[1] : eq[1]);
      else if (isn) r[k] = isn[1] === 'null' ? null : isn[1] === 'true';
      else if (inn) { const opts = inn[1].split(',').map(s => s.replace(/^"|"$/g, '')); r[k] = opts[rows.indexOf(r) % opts.length]; }
    }
  }
  return J(rows, 200, { 'content-range': `0-${rows.length - 1}/${rows.length}` });
}
// CDN の代わり（サンドボックスから外へ出られないため）
const STUBS = [
  [/chart(\.umd)?(\.min)?\.js|Chart\.js/i, 'window.Chart=function(){this.destroy=function(){};this.update=function(){};this.data={datasets:[],labels:[]};this.options={}};Chart.register=function(){};Chart.defaults={font:{},color:"",plugins:{legend:{labels:{}},tooltip:{}},scale:{grid:{}},scales:{}};'],
  [/jsbarcode/i, 'window.JsBarcode=function(){return {init:function(){}}};'],
  [/xlsx/i, 'window.XLSX={utils:{book_new:function(){return{}},aoa_to_sheet:function(){return{}},json_to_sheet:function(){return{}},book_append_sheet:function(){},sheet_to_json:function(){return[]},decode_range:function(){return{s:{r:0,c:0},e:{r:0,c:0}}},encode_cell:function(){return"A1"}},writeFile:function(){},read:function(){return{SheetNames:[],Sheets:{}}}};'],
  [/supabase-js/i, '(function(){function q(){var p={then:function(r){return Promise.resolve({data:[],error:null,count:0}).then(r)}};["select","eq","neq","gte","lte","gt","lt","order","limit","in","is","not","or","range","ilike","like","single","maybeSingle","insert","update","upsert","delete","match","filter","contains","overlaps","csv"].forEach(function(k){p[k]=function(){return p}});return p}window.supabase={createClient:function(){return{from:function(){return q()},rpc:function(){return q()},auth:{getSession:function(){return Promise.resolve({data:{session:null}})},onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}}},storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}},upload:function(){return Promise.resolve({data:{},error:null})},list:function(){return Promise.resolve({data:[],error:null})}}}}}}};})();'],
  [/leaflet.*\.js/i, 'window.L=undefined;'],
];
// ページ内で実行する測定
function measure() {
  const vw = window.innerWidth;
  const desc = el => { const t = (el.innerText || el.value || el.placeholder || el.title || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 24); return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + (t ? ' "' + t + '"' : ''); };
  const visible = el => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const dt = el.closest('details:not([open])'); if (dt && !el.closest('summary')) return false; const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false; for (let p = el; p && p !== document.documentElement; p = p.parentElement) { const s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden') return false; } return true; };
  const scrollBoxed = el => { for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true; } return false; };
  const fixedish = el => { for (let p = el; p && p !== document.documentElement; p = p.parentElement) { const s = getComputedStyle(p).position; if (s === 'fixed' || s === 'sticky') return true; } return false; };
  const res = { hscroll: Math.max(0, document.documentElement.scrollWidth - vw), over: [], smallTap: [], smallTapN: 0, midTapN: 0, tapN: 0, tiny: [], tinyN: 0, clip: [], clipN: 0, lowc: [], lowcN: 0, noLabel: [], noLabelN: 0, noName: [], noNameN: 0, overlap: [], overlapN: 0 };
  const all = [...document.body.querySelectorAll('*')].filter(e => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|BR|HEAD|META|LINK|PATH|G|CIRCLE|RECT|LINE|POLYLINE|POLYGON|DEFS|TITLE)$/i.test(e.tagName));
  const vis = all.filter(visible);
  // 1. 画面の右（左）にはみ出している要素。横スクロールできる箱（auto/scroll）の中は除く。
  //    body が overflow-x:hidden だとページは横に動かず、はみ出した分は見えないまま切れる（clipped）
  const inScroller = el => { for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) return true; } return false; };
  res.offN = 0; res.off = [];
  for (const el of vis) { const r = el.getBoundingClientRect(); if ((r.right > vw + 2 || r.left < -2) && r.width < vw * 4 && !inScroller(el)) { const kids = [...el.children].some(c => { if (!visible(c)) return false; const cr = c.getBoundingClientRect(); return cr.right > vw + 2 || cr.left < -2; }); if (!kids) { res.offN++; if (res.off.length < 6) res.off.push(desc(el) + ' →' + Math.round(Math.max(r.right - vw, -r.left)) + 'px'); } } }
  res.over = res.off;
  // 2. 押す場所の大きさ
  const taps = vis.filter(e => e.matches('button, a[href], input:not([type=hidden]), select, textarea, [onclick], [role=button], summary, label[for]'));
  res.tapN = taps.length;
  for (const el of taps) { const r = el.getBoundingClientRect(); const m = Math.min(r.width, r.height); if (el.matches('input[type=checkbox], input[type=radio]')) { const lab = el.closest('label'); if (lab) { const lr = lab.getBoundingClientRect(); if (Math.min(lr.width, lr.height) >= 24) continue; } } if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.closest('p, li, td, .note, .muted, small')) continue; if (m < 24) { res.smallTapN++; if (res.smallTap.length < 8) res.smallTap.push(desc(el) + ' ' + Math.round(r.width) + '×' + Math.round(r.height)); } else if (m < 32) res.midTapN++; }
  // 3. 小さい字（10px 未満）
  const seenT = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const textEls = [];
  while (walker.nextNode()) { const n = walker.currentNode; if (!n.nodeValue.trim()) continue; const el = n.parentElement; if (!el || seenT.has(el) || /^(SCRIPT|STYLE|OPTION|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue; seenT.add(el); if (visible(el)) textEls.push(el); }
  for (const el of textEls) { const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < 10) { res.tinyN++; if (res.tiny.length < 6) res.tiny.push(desc(el) + ' ' + fs + 'px'); } }
  // 4. 字が切れている（はみ出しを隠していて、…も出していない）
  for (const el of textEls) { const cs = getComputedStyle(el); if (/(hidden|clip)/.test(cs.overflowX) && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) { res.clipN++; if (res.clip.length < 6) res.clip.push(desc(el) + ' ' + el.clientWidth + '/' + el.scrollWidth); } }
  // 5. 読みにくい色（文字と背景のコントラスト比 3 未満）
  const rgb = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] == null ? 1 : p[3] }; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = el => { for (let p = el; p; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; const c = rgb(cs.backgroundColor); if (c && c.a > 0.95) return c; if (c && c.a > 0.05) return null; } return { r: 255, g: 255, b: 255, a: 1 }; };
  for (const el of textEls.slice(0, 900)) { if (el.closest('[disabled], .disabled')) continue; const c = rgb(getComputedStyle(el).color); const bg = bgOf(el); if (!c || !bg || c.a < 0.6) continue; const L1 = lum(c), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); if (ratio < 3) { res.lowcN++; if (res.lowc.length < 6) res.lowc.push(desc(el) + ' ' + ratio.toFixed(1)); } }
  // 6. 名前の無い入力欄・ボタン
  for (const el of vis.filter(e => e.matches('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), select, textarea'))) { const has = el.placeholder || el.getAttribute('aria-label') || el.title || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest('label') || (el.previousElementSibling && /LABEL|SPAN|TH|B|DIV/.test(el.previousElementSibling.tagName) && el.previousElementSibling.innerText.trim()) || (el.closest('td') && el.closest('table')) || (el.closest('.form-group, .field, .row') && el.closest('.form-group, .field, .row').querySelector('label')); if (!has) { res.noLabelN++; if (res.noLabel.length < 5) res.noLabel.push(desc(el)); } }
  for (const el of vis.filter(e => e.matches('button, [role=button]'))) { const name = (el.innerText || '').trim() || el.getAttribute('aria-label') || el.title; if (!name) { res.noNameN++; if (res.noName.length < 5) res.noName.push(desc(el)); } }
  // 7. 押す場所どうしの重なり
  const boxes = taps.filter(e => !fixedish(e)).slice(0, 350).map(e => ({ e, r: e.getBoundingClientRect() }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; if (a.e.contains(b.e) || b.e.contains(a.e)) continue; const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top); if (w > 3 && h > 3) { const area = w * h, small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height); if (area / small > 0.3) { res.overlapN++; if (res.overlap.length < 5) res.overlap.push(desc(a.e) + ' × ' + desc(b.e)); } } }
  // 8. 画面に出ている「失敗」の知らせ（error モードで使う）
  const bodyText = document.body.innerText || '';
  res.errShown = /エラー|失敗|読み込めません|読めません|取得できません|できませんでした|通信|接続|再読み込み|もう一度|error/i.test(bodyText);
  res.textLen = bodyText.replace(/\s+/g, '').length;
  res.lines = [...new Set(bodyText.split('\n').map(x => x.trim().slice(0, 90)).filter(x => x.length > 1))].slice(0, 500);
  res.toast = [...document.querySelectorAll('.toast, #toast, .toast-container, [class*=toast], .status-bar, #statusBar, #msg, .msg, .error, [class*=error], [class*=alert]')].filter(visible).map(e => (e.innerText || '').trim().slice(0, 100)).filter(Boolean).slice(0, 4);
  return res;
}
module.exports = { respond, STUBS, measure };
