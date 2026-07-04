-- ============================================================
-- ALCO OS  0008: Dashboard 用ビュー
-- 集計はビューに寄せ、画面側に集計SQLを書かない。
-- ジビエ基幹（individuals / products / product_movements 等）のKPIは
-- 同一DBに統合した時点で v_gibier_* ビューとして追加する
-- （docs/09-gibier-integration.md 参照）。
-- ============================================================

-- 未処理タスク数（担当者別）
create or replace view v_open_tasks as
select
  t.organization_id,
  t.assignee_id,
  p.display_name as assignee_name,
  count(*) filter (where t.status = 'open') as open_count,
  count(*) filter (where t.status = 'in_progress') as in_progress_count,
  count(*) filter (where t.due_date < current_date and t.status in ('open','in_progress')) as overdue_count
from tasks t
left join profiles p on p.id = t.assignee_id
where t.deleted_at is null
group by t.organization_id, t.assignee_id, p.display_name;

-- 承認待ちドラフト
create or replace view v_pending_drafts as
select
  organization_id,
  draft_type,
  count(*) as pending_count,
  min(created_at) as oldest_created_at
from generated_drafts
where status = 'draft'
group by organization_id, draft_type;

-- 補助金パイプライン
create or replace view v_grant_pipeline as
select
  organization_id,
  status,
  count(*) as project_count,
  sum(coalesce(requested_amount, 0)) as total_requested,
  sum(coalesce(adopted_amount, 0)) as total_adopted
from grant_projects
where deleted_at is null
group by organization_id, status;

-- CRM 案件パイプライン
create or replace view v_deal_pipeline as
select
  organization_id,
  status,
  count(*) as deal_count,
  sum(coalesce(expected_amount, 0)) as total_expected
from deals
where deleted_at is null
group by organization_id, status;

-- 自然資本: サイト別の観察・作業件数
create or replace view v_site_activity as
select
  s.organization_id,
  s.id as site_id,
  s.name as site_name,
  s.oecm_status,
  (select count(*) from biodiversity_observations o where o.site_id = s.id) as observation_count,
  (select count(*) from management_actions m where m.site_id = s.id) as action_count,
  (select max(o.observed_at) from biodiversity_observations o where o.site_id = s.id) as last_observed_at
from sites s
where s.deleted_at is null;

-- AI 実行状況（直近30日）
create or replace view v_ai_usage as
select
  organization_id,
  workflow,
  count(*) as run_count,
  count(*) filter (where status = 'failed') as failed_count,
  sum(coalesce(input_tokens,0)) as total_input_tokens,
  sum(coalesce(output_tokens,0)) as total_output_tokens
from ai_runs
where created_at > now() - interval '30 days'
group by organization_id, workflow;

-- ビューは security_invoker で RLS を通す（Postgres 15+ / Supabase 対応）
alter view v_open_tasks set (security_invoker = true);
alter view v_pending_drafts set (security_invoker = true);
alter view v_grant_pipeline set (security_invoker = true);
alter view v_deal_pipeline set (security_invoker = true);
alter view v_site_activity set (security_invoker = true);
alter view v_ai_usage set (security_invoker = true);
