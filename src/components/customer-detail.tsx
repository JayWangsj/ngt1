import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { OrderTable } from "./common";
import { CustomerDevices, CustomerSummary } from "./customers";
import { CustomerDetailDialog } from "./customer-detail-dialog";
import { getMessages } from "@/lib/i18n-server";
import { Button } from "./ui/button";

export async function CustomerDetail({
  id,
  query,
  dialog = false,
}: {
  id: string;
  query: string;
  dialog?: boolean;
}) {
  const it = await getMessages();
  const returnTo = query
    ? `/customers?q=${encodeURIComponent(query)}`
    : "/customers";
  const customer = await db.customer.findUnique({
    where: { id },
    include: { phones: true, devices: { where: { deletedAt: null } } },
  });
  if (!customer) notFound();
  const orders = await db.workOrder.findMany({
    where: { device: { customerId: id } },
    include: {
      device: { include: { customer: true } },
      items: true,
      products: true,
      payments: true,
    },
    orderBy: { createdAt: "desc" },
  });
  const content = (
    <>
      <CustomerSummary
        customer={{
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          phones: customer.phones.map((phone) => ({ phone: phone.phone })),
        }}
        query={query}
        deleted={Boolean(customer.deletedAt)}
        showHeading
        dialog={dialog}
      />
      <CustomerDevices
        customerId={customer.id}
        devices={customer.devices.map((device) => ({
          id: device.id,
          category: device.category,
          brand: device.brand,
          model: device.model,
          imei: device.imei,
        }))}
        readOnly={Boolean(customer.deletedAt)}
      />
      <h2 className="spaced">{it.customerHistory}</h2>
      <section className="panel table-panel">
        <OrderTable orders={orders} hideCustomer compact />
      </section>
    </>
  );

  if (dialog)
    return (
      <CustomerDetailDialog title={it.customerDetails}>
        {content}
      </CustomerDetailDialog>
    );

  return (
    <>
      <Button asChild variant="outline" className="customer-back">
        <Link href={returnTo}>← {it.backCustomers}</Link>
      </Button>
      {content}
    </>
  );
}
