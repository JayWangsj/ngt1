import { redirect } from "next/navigation";

export default function SystemUpdatePage() {
  redirect("/?open-update=1");
}
