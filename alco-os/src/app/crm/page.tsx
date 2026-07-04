import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, CardTitle, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

const DEAL_STATUS: Record<string, { label: string; color: "gray" | "blue" | "amber" | "green" | "red" }> = {
  lead: { label: "リード", color: "gray" },
  proposal: { label: "提案中", color: "blue" },
  negotiation: { label: "交渉中", color: "amber" },
  won: { label: "成約", color: "green" },
  lost: { label: "失注", color: "red" },
  on_hold: { label: "保留", color: "gray" },
};

export default async function CrmPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="CRM" description="人脈を売上・案件・協業に変換する" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const [{ data: deals }, { data: contacts }] = await Promise.all([
    supabase
      .from("deals")
      .select("id, name, deal_type, status, expected_amount, contacts(name)")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("contacts")
      .select("id, name, company_name, channel")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(30),
  ]);

  return (
    <>
      <PageHeader title="CRM" description="人脈を売上・案件・協業に変換する" />
      <div className="grid gap-4 md:grid-cols-2">
        <section>
          <CardTitle>案件</CardTitle>
          <div className="space-y-2">
            {!deals?.length ? (
              <EmptyState message="案件はまだありません。" />
            ) : (
              deals.map((deal) => {
                const status = DEAL_STATUS[deal.status] ?? DEAL_STATUS.lead;
                const contact = deal.contacts as unknown as { name: string } | null;
                return (
                  <Card key={deal.id} className="py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{deal.name}</p>
                        <p className="text-xs text-stone-400">
                          {contact?.name ?? ""}
                          {deal.expected_amount
                            ? ` ・見込 ${Number(deal.expected_amount).toLocaleString()}円`
                            : ""}
                        </p>
                      </div>
                      <Badge color={status.color}>{status.label}</Badge>
                    </div>
                  </Card>
                );
              })
            )}
          </div>
        </section>
        <section>
          <CardTitle>連絡先</CardTitle>
          <div className="space-y-2">
            {!contacts?.length ? (
              <EmptyState message="連絡先はまだありません。" />
            ) : (
              contacts.map((contact) => (
                <Card key={contact.id} className="py-3">
                  <p className="text-sm font-medium">{contact.name}</p>
                  <p className="text-xs text-stone-400">
                    {contact.company_name ?? ""}
                    {contact.channel ? ` ・${contact.channel}` : ""}
                  </p>
                </Card>
              ))
            )}
          </div>
        </section>
      </div>
    </>
  );
}
