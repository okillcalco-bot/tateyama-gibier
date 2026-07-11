"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * アプリ共通シェル。
 * モバイル: 下部タブ + 上部ヘッダー / PC: 左サイドバー。
 * 現場（解体室・里山・移動中）でのスマホ入力を最優先する。
 */

const NAV_ITEMS = [
  { href: "/", label: "ホーム", icon: "🏠" },
  { href: "/board", label: "共有ボード", icon: "📋" },
  { href: "/memos", label: "メモ", icon: "🎙" },
  { href: "/tasks", label: "タスク", icon: "✅" },
  { href: "/drafts", label: "承認", icon: "📝" },
  { href: "/grants", label: "補助金", icon: "📄" },
  { href: "/nature", label: "自然資本", icon: "🌱" },
  { href: "/crm", label: "CRM", icon: "🤝" },
  { href: "/projects", label: "プロジェクト", icon: "🏗" },
  { href: "/media", label: "メディア", icon: "🎬" },
  { href: "/social", label: "発信", icon: "📣" },
  { href: "/hr", label: "勤怠・シフト", icon: "🕒" },
  { href: "/orders", label: "受注", icon: "📦" },
  { href: "/gibier", label: "ジビエ", icon: "🐗" },
  { href: "/manual", label: "使い方", icon: "📖" },
];

// モバイル下部タブは主要5つに絞る（スタッフの日常導線を優先し ジビエ → 共有ボード）
const MOBILE_NAV = NAV_ITEMS.filter((item) =>
  ["/", "/board", "/memos", "/tasks", "/drafts"].includes(item.href),
);

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  // 飲食店向けページ（/portal）は社内ナビを出さない
  if (pathname.startsWith("/portal")) {
    return <main className="min-h-dvh">{children}</main>;
  }

  return (
    <div className="min-h-dvh md:flex">
      {/* PC サイドバー */}
      <aside className="hidden w-56 shrink-0 border-r border-stone-200 bg-white md:block">
        <div className="p-4">
          <Link href="/" className="text-lg font-bold text-green-800">
            ALCO OS
          </Link>
          <p className="text-xs text-stone-400">合同会社アルコ 業務OS</p>
        </div>
        <nav className="space-y-1 px-2">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                isActive(item.href)
                  ? "bg-green-50 font-semibold text-green-800"
                  : "text-stone-600 hover:bg-stone-100"
              }`}
            >
              <span>{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-h-dvh flex-1 flex-col">
        {/* モバイルヘッダー */}
        <header className="sticky top-0 z-10 border-b border-stone-200 bg-white px-4 py-3 md:hidden">
          <Link href="/" className="font-bold text-green-800">
            ALCO OS
          </Link>
        </header>

        <main className="flex-1 p-4 pb-20 md:p-6">{children}</main>

        {/* モバイル下部タブ */}
        <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-stone-200 bg-white md:hidden">
          {MOBILE_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] ${
                isActive(item.href) ? "font-semibold text-green-800" : "text-stone-500"
              }`}
            >
              <span className="text-base leading-none">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
