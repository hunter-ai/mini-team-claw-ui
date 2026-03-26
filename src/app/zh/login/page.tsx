import { LoginPage } from "@/app/_shared/login-page";

export default async function ChineseLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  return LoginPage({ locale: "zh", searchParams });
}
