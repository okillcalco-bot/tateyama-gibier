import { test, expect } from "@playwright/test";

/**
 * スモークテスト: 主要画面が描画されること。
 * Supabase 未設定環境ではセットアップ案内が表示されることを確認する。
 */
const PAGES = [
  { path: "/", title: "ダッシュボード" },
  { path: "/memos", title: "音声メモ" },
  { path: "/tasks", title: "タスク" },
  { path: "/drafts", title: "承認待ちドラフト" },
  { path: "/grants", title: "補助金" },
  { path: "/nature", title: "自然資本" },
  { path: "/crm", title: "CRM" },
  { path: "/projects", title: "プロジェクト" },
  { path: "/gibier", title: "ジビエ基幹システム" },
];

for (const page of PAGES) {
  test(`${page.path} が描画される`, async ({ page: browser }) => {
    await browser.goto(page.path);
    await expect(browser.getByRole("heading", { name: page.title })).toBeVisible();
  });
}
