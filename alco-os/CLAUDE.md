# CLAUDE.md

**Read `docs/00-philosophy.md` FIRST** — it defines the system's purpose
(a regional OS for passing natural capital to the next generation), the AI's
role (proposer — never approver or decision-maker), and the priority order
when in doubt: ① keep field operations running → ② protect data →
③ security → ④ maintainability → ⑤ AI quality → ⑥ UI → ⑦ new features.

## Project

This directory is ALCO OS, an internal business operating system for Godo Kaisha ALCO
(Tateyama, Chiba). The system supports:

- Voice memo to task/document workflows
- Grant application document workflows
- Nature capital and biodiversity evidence management
- CRM and relationship management
- Project management for R.O.K.A. renovation
- SOPs and operational checklists
- Management dashboards
- Gibier processing integration (the production gibier system lives at the
  repository root as static HTML apps — do NOT break it; see docs/09-gibier-integration.md)

## Core principles

1. Human approval is required before any AI-generated draft changes business records.
2. AI outputs must be stored as drafts in `generated_drafts`.
3. All AI runs must be logged in `ai_runs` (success and failure).
4. Important business mutations must be logged in `audit_logs`.
5. Business logic belongs in `src/domain/` services, not React components.
6. UI text is Japanese. Code, database names, and function names are English.
7. Design for mobile-first field usage.
8. Supabase RLS is required for all business tables (`alco_add_member_policy`).
9. Do not introduce new frameworks without updating docs/02-architecture.md.
10. Never hardcode AI model names — use env vars + `src/ai/model-router.ts`.

## Tech stack

Next.js App Router / TypeScript / Tailwind CSS v4 / Supabase (PostgreSQL, Auth,
Storage) / Zod / Vitest / Playwright / pnpm

## Directory rules

- `src/app/` — routes, UI composition, and thin server actions only
- `src/components/` — reusable UI components
- `src/domain/` — business rules and services (depends on `DbPort`, not Supabase)
- `src/lib/` — infrastructure clients and shared utilities (`env.ts` is the only
  place that reads `process.env`)
- `src/ai/` — model adapters, prompts, schemas, and AI workflows
- `supabase/migrations/` — append-only migrations; never edit an existing file
- `docs/` — product, architecture, and maintenance documentation
- `tests/` — unit tests (use `InMemoryDb`); `e2e/` — Playwright smoke tests

## AI implementation rules

All AI calls must go through:

- `src/ai/model-router.ts`
- `src/ai/providers/*`
- `src/ai/workflows/*` (via `runWorkflow`, which enforces logging + draft saving)

Never call a model API directly from a React component or route handler.

Every AI workflow must define: input schema, output schema, prompt file with
`PROMPT_VERSION` and a `[workflow:<name>]` marker, model configuration in
`WORKFLOW_CONFIG`, a mock response in `mock-provider.ts`, and (if it mutates
business data on approval) a case in `draft-service.applyDraft()`.

## Database rules

Every business table includes: `id`, `organization_id`, `created_at`,
`updated_at` (+ trigger), `created_by`; soft delete (`deleted_at`) where
appropriate. New tables get `select alco_add_member_policy('<table>');`.
Do not touch the pre-existing gibier tables (individuals, hunters, staff,
attendance, products, product_movements, orders, customers, area_master).

## Testing rules

Before finishing a task:

1. `pnpm typecheck`
2. `pnpm test`
3. Run relevant e2e tests when UI changed (`pnpm test:e2e`)
4. Update docs when behavior changes

## Maintenance rules for Opus or other future models

Read docs/07-opus-maintenance-guide.md first. In short: do not change the
architecture, do not bypass domain services, do not remove audit/AI-run logging,
do not edit existing migrations, add or update tests, keep changes small, and
report what changed and why.
