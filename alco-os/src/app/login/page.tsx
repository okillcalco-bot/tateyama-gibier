"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Card, PageHeader } from "@/components/ui";
import { isSupabaseConfigured } from "@/lib/env";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm pt-8">
      <PageHeader title="ログイン" description="ALCO OS にサインイン" />
      <Card>
        {!isSupabaseConfigured() ? (
          <p className="text-sm text-amber-800">
            Supabase 未設定のためログインできません。.env.local を設定してください。
          </p>
        ) : (
          <form onSubmit={handleLogin} className="space-y-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="メールアドレス"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="パスワード"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {loading ? "サインイン中…" : "サインイン"}
            </button>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
          </form>
        )}
      </Card>
    </div>
  );
}
