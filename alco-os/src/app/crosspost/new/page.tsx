import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { Card, PageHeader, SetupNotice } from "@/components/ui";
import { NewSourceForm } from "../crosspost-forms";

export const dynamic = "force-dynamic";

/** ② 新規投稿入力 */
export default function NewCrosspostPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="投稿を登録" />
        <SetupNotice />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="投稿を登録"
        description="Facebookの原文と写真を貼り付けてください。自動取得はしません。"
      />
      <Card>
        <NewSourceForm />
      </Card>
      <Link
        href="/crosspost"
        className="mt-4 flex min-h-[56px] w-full items-center justify-center rounded-xl border-2 border-stone-400 px-4 text-base font-bold text-stone-700"
      >
        ← 一覧へもどる
      </Link>
    </>
  );
}
