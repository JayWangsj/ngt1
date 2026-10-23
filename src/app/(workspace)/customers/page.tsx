import { NewCustomerDialog } from "@/components/forms";
import { CustomerList } from "@/components/customers";
import { db } from "@/lib/db";
import { requireActor } from "@/lib/session";
import { PageHeader } from "@/components/common";
import { getMessages } from "@/lib/i18n-server";
export default async function Customers() {
  const it = await getMessages();
  await requireActor();
  const customers = await db.customer.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      phone: true,
      phones: { select: { phone: true } },
      devices: {
        where: { deletedAt: null },
        select: {
          orders: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { createdAt: true },
          },
        },
      },
      _count: { select: { devices: { where: { deletedAt: null } } } },
    },
    orderBy: { name: "asc" },
  });
  return (
    <div className="workspace-list-page customers-page">
      <PageHeader
        title={it.nav.customers}
        description={it.customersDescription}
        actionNode={<NewCustomerDialog />}
      />
      <CustomerList
        customers={customers.map(({ devices, ...customer }) => ({
          ...customer,
          lastRepairAt:
            devices
              .flatMap((device) => device.orders)
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
              ?.createdAt.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
