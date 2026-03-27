import { AdminLayout } from "@/app/_shared/admin-layout";

export default function ChineseAdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <AdminLayout locale="zh">{children}</AdminLayout>;
}
