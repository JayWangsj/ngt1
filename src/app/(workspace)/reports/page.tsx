import { redirect } from "next/navigation";

export default async function Reports({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  const requestedDay = (await searchParams).day;
  if (requestedDay && /^\d{4}-\d{2}-\d{2}$/.test(requestedDay))
    redirect(`/?day=${encodeURIComponent(requestedDay)}`);
  redirect("/");
}
