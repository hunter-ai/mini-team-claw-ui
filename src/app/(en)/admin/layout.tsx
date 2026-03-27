import { AdminLayout } from "@/app/_shared/admin-layout";

export default function EnglishAdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <AdminLayout locale="en">{children}</AdminLayout>;
}
