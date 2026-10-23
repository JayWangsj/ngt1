"use client";
import { useMessages } from "@/components/language";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  const it = useMessages();
  return (
    <section className="standalone">
      <h1>{it.errorTitle}</h1>
      <p>{it.connectionError}</p>
      <Button onClick={reset}>{it.retry}</Button>
    </section>
  );
}
