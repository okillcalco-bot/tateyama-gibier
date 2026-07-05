import { Card, CardTitle, PageHeader } from "@/components/ui";

/**
 * ジビエ基幹システムへの入口。
 * 個体管理・解体・在庫・受注・打刻などの現場アプリは、既存のジビエ基幹
 * システム（リポジトリルートの静的アプリ群）が本番稼働中。
 * ALCO OS への統合方針は docs/09-gibier-integration.md を参照。
 */
export default function GibierPage() {
  return (
    <>
      <PageHeader
        title="ジビエ基幹システム"
        description="個体 → 解体 → 製品 → 在庫 → 受注 → 納品"
      />
      <Card>
        <CardTitle>既存システム（本番稼働中）</CardTitle>
        <p className="text-sm text-stone-600">
          ジビエ現場アプリ（個体登録・加工処理・在庫・受注・打刻・帳票）は既存の
          館山ジビエセンター業務アプリで稼働しています。現場業務はそちらを継続利用してください。
        </p>
        <ul className="mt-3 list-disc pl-5 text-sm text-stone-600">
          <li>個体・捕獲者・台帳管理（individuals / hunters）</li>
          <li>加工処理・完成品在庫（products / product_movements）</li>
          <li>受注・顧客・送り状（orders / customers）</li>
          <li>出退勤・シフト（staff / attendance）</li>
        </ul>
        <p className="mt-3 text-xs text-stone-400">
          統合ステップ: ①同一Supabaseプロジェクトでの共存（現状） →
          ②ダッシュボードKPIビューの追加 → ③organization_id 付与とRLS統一。
          詳細は docs/09-gibier-integration.md。
        </p>
      </Card>
    </>
  );
}
