import { AdminIndexPage } from "@/app/_shared/admin-index-page";

export default async function ChineseAdminPage() {
  return AdminIndexPage({ locale: "zh" });
}
