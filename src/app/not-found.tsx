"use client";
import Link from "next/link";
import { useMessages } from "@/components/language";
import { Button } from "@/components/ui/button";
export default function NotFound() {
  const it = useMessages();
  return (
    <main className="standalone">
      <h1>404</h1>
      <p>{it.notFound}</p>
      <Button asChild variant="outline">
        <Link href="/">{it.backHome}</Link>
      </Button>
    </main>
  );
}
