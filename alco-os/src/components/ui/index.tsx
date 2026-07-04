import type { ReactNode } from "react";

/**
 * 最小限のUI部品。
 * 本格的なコンポーネントが必要になったら shadcn/ui を導入し、
 * ここから段階的に置き換える（docs/02-architecture.md 参照）。
 */

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-stone-200 bg-white p-4 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-sm font-semibold text-stone-500">{children}</h2>;
}

const BADGE_STYLES: Record<string, string> = {
  green: "bg-green-100 text-green-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
  blue: "bg-blue-100 text-blue-800",
  gray: "bg-stone-100 text-stone-600",
};

export function Badge({
  children,
  color = "gray",
}: {
  children: ReactNode;
  color?: keyof typeof BADGE_STYLES;
}) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_STYLES[color]}`}
    >
      {children}
    </span>
  );
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-4">
      <h1 className="text-xl font-bold">{title}</h1>
      {description ? <p className="mt-1 text-sm text-stone-500">{description}</p> : null}
    </header>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 p-8 text-center text-sm text-stone-400">
      {message}
    </div>
  );
}

/** Supabase 未設定時のセットアップ案内 */
export function SetupNotice() {
  return (
    <Card className="border-amber-300 bg-amber-50">
      <p className="text-sm text-amber-900">
        Supabase が未設定です。<code className="mx-1 rounded bg-amber-100 px-1">.env.local</code>
        に <code className="mx-1 rounded bg-amber-100 px-1">NEXT_PUBLIC_SUPABASE_URL</code> と
        <code className="mx-1 rounded bg-amber-100 px-1">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
        を設定してください（README のセットアップ手順参照）。
      </p>
    </Card>
  );
}
