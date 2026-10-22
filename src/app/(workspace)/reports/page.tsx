import { redirect } from "next/navigation";
import {
  canViewReceiptData,
  normalizeReceiptMonth,
} from "@/lib/business-metrics";
import { validBusinessDate, getBusinessDay } from "@/lib/business-date";
import { monthParts } from "@/lib/date-picker";
import { requireActor } from "@/lib/session";

export default async function Reports({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; month?: string }>;
}) {
  const [query, actor, businessToday] = await Promise.all([
    searchParams,
    requireActor(),
    getBusinessDay(),
  ]);
  if (!canViewReceiptData(actor.role)) redirect("/");

  const requestedDay =
    query.day && validBusinessDate(query.day) ? query.day : undefined;
  const currentMonth = businessToday.slice(0, 7);
  const requestedMonth =
    query.month && monthParts(query.month) && query.month <= currentMonth
      ? query.month
      : requestedDay?.slice(0, 7);
  const receiptMonth = normalizeReceiptMonth(requestedMonth, businessToday);
  const destination = new URLSearchParams({ receipts: receiptMonth });
  if (requestedDay) destination.set("day", requestedDay);
  redirect(`/?${destination.toString()}`);
}
