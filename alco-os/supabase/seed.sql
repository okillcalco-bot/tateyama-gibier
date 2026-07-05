-- ============================================================
-- ALCO OS  seed data（開発用ダミーデータ）
-- ※ 実在の顧客情報・個人情報は入れない。設計段階はダミーで検証する。
-- ※ 本番DB（ジビエ基幹と共有）には投入しない。組織・ロールの初期投入は
--    マイグレーション 0009 が行うため、本番はマイグレーションのみでよい。
-- ※ profiles は初回ログイン時に provision_profile()（0009）が自動作成する。
-- ============================================================

insert into organizations (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', '合同会社アルコ', 'alco')
on conflict (slug) do nothing;

insert into roles (organization_id, key, name, permissions) values
  ('00000000-0000-0000-0000-000000000001', 'owner',   '代表',        '{"all": true}'),
  ('00000000-0000-0000-0000-000000000001', 'manager', 'マネージャー', '{"approve_drafts": true, "manage_grants": true}'),
  ('00000000-0000-0000-0000-000000000001', 'staff',   'スタッフ',    '{"field_entry": true}')
on conflict (organization_id, key) do nothing;

-- ── サンプル: 対象地 ──
insert into sites (id, organization_id, name, site_type, address, area_ha, oecm_status, description) values
  ('00000000-0000-0000-0001-000000000001', '00000000-0000-0000-0000-000000000001',
   '南房総里山未来拠点（サンプル）', 'own_field', '千葉県館山市（ダミー住所）', 3.2, 'preparing',
   '里山保全のモデル地。湿地・雑木林・竹林を含む（開発用ダミー）'),
  ('00000000-0000-0000-0001-000000000002', '00000000-0000-0000-0000-000000000001',
   'サンプル企業社有林', 'client_site', '千葉県南房総市（ダミー住所）', 12.0, 'none',
   '自然共生サイト認証支援の候補地（開発用ダミー）')
on conflict (id) do nothing;

insert into survey_points (organization_id, site_id, name, habitat_type) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'P-01 湿地北側', '湿地'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'P-02 雑木林中央', '雑木林')
on conflict do nothing;

insert into biodiversity_observations
  (organization_id, site_id, observed_at, species_name, taxon_group, count, observer, note) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001',
   '2026-05-10 09:30+09', 'ニホンアカガエル', '両生類', 3, 'ダミー調査員', '湿地にて目視（ダミーデータ）'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001',
   '2026-05-10 10:15+09', 'サシバ', '鳥類', 1, 'ダミー調査員', '上空を旋回（ダミーデータ）')
on conflict do nothing;

insert into management_actions
  (organization_id, site_id, action_date, action_type, description, hours) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001',
   '2026-05-20', '草刈り', '湿地周辺の下草刈り（ダミーデータ）', 4)
on conflict do nothing;

-- ── サンプル: 補助金 ──
insert into grant_opportunities
  (id, organization_id, name, agency, summary, max_amount, subsidy_rate, application_deadline, status) values
  ('00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0000-000000000001',
   'サンプル地域資源活用補助金', 'サンプル県', '地域資源を活用した施設整備への補助（ダミー）',
   5000000, '2/3', '2026-09-30', 'preparing')
on conflict (id) do nothing;

insert into grant_projects
  (id, organization_id, opportunity_id, name, target_business, status, requested_amount) values
  ('00000000-0000-0000-0002-000000000002', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0002-000000000001',
   'R.O.K.A. 改修 補助金申請（サンプル）', 'roka', 'preparing', 4500000)
on conflict (id) do nothing;

insert into grant_requirements
  (organization_id, grant_project_id, requirement_text, category, is_met, sort_order) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0002-000000000002',
   '県内に主たる事業所を有すること', '資格', true, 1),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0002-000000000002',
   '見積書2社以上の添付', '書類', null, 2),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0002-000000000002',
   '事業計画書（様式3）の提出', '書類', null, 3)
on conflict do nothing;

-- ── サンプル: CRM ──
insert into contacts (id, organization_id, contact_type, name, company_name, channel, note) values
  ('00000000-0000-0000-0003-000000000001', '00000000-0000-0000-0000-000000000001',
   'person', 'サンプル 太郎', '株式会社サンプル商事', 'BNI', '開発用ダミー連絡先'),
  ('00000000-0000-0000-0003-000000000002', '00000000-0000-0000-0000-000000000001',
   'company', 'サンプル建設株式会社', null, '同友会', '自然共生サイト候補企業（ダミー）')
on conflict (id) do nothing;

insert into deals (organization_id, contact_id, name, deal_type, status, expected_amount) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0003-000000000002',
   '社有林 自然共生サイト認証支援（サンプル）', 'nature_consulting', 'proposal', 1200000)
on conflict do nothing;

-- ── サンプル: プロジェクト ──
insert into projects (id, organization_id, name, project_type, status, description) values
  ('00000000-0000-0000-0004-000000000001', '00000000-0000-0000-0000-000000000001',
   'R.O.K.A. リノベーション（サンプル）', 'renovation', 'active',
   '館山ジビエラボ・地域拠点としての改修プロジェクト（開発用ダミー）')
on conflict (id) do nothing;

insert into project_phases (organization_id, project_id, name, status, sort_order) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0004-000000000001', '水道引込', 'in_progress', 1),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0004-000000000001', '内装工事', 'planned', 2),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0004-000000000001', '保健所協議', 'planned', 3)
on conflict do nothing;

-- ── サンプル: 音声メモ ──
insert into voice_memos (organization_id, title, raw_text, source_type, status) values
  ('00000000-0000-0000-0000-000000000001', '現場メモ（サンプル）',
   '今日の午前、湿地の北側でアカガエルの卵塊を3つ確認。来週の草刈りは南側の竹が伸びてるので先にやったほうがいい。あと、サンプル商事の田中さんに補助金の件で金曜までに連絡すること。',
   'voice_transcript', 'new')
on conflict do nothing;

-- ── サンプル: SOP / チェックリスト ──
insert into sops (organization_id, title, category, body) values
  ('00000000-0000-0000-0000-000000000001', '解体室 作業前準備（サンプル）', 'hygiene',
   E'# 作業前準備\n\n1. 白衣・帽子・長靴を着用する\n2. 手指を洗浄・消毒する\n3. 器具の消毒液を確認する\n\n（開発用ダミー）')
on conflict do nothing;

insert into checklists (organization_id, title, category, frequency, items) values
  ('00000000-0000-0000-0000-000000000001', '解体室 作業前チェック（サンプル）', 'hygiene', 'daily',
   '[{"key":"uniform","label":"作業着・長靴の着用","required":true},
     {"key":"hands","label":"手指の洗浄・消毒","required":true},
     {"key":"tools","label":"器具の消毒液確認","required":true}]')
on conflict do nothing;

-- ── サンプル: ナレッジ ──
insert into knowledge_docs (organization_id, title, doc_type, module, body, tags, is_ai_reference) values
  ('00000000-0000-0000-0000-000000000001', '補助金申請の基本方針（サンプル）', 'policy', 'grants',
   E'# 補助金申請の基本方針\n\n- 事実と異なる記載は絶対にしない\n- 数字は必ず根拠資料と紐付ける\n- AI生成文は必ず人間がレビューしてから提出する\n\n（開発用ダミー）',
   array['補助金','方針'], true)
on conflict do nothing;
