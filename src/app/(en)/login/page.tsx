import { LoginPage } from "@/app/_shared/login-page";

export default async function EnglishLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  return LoginPage({ locale: "en", searchParams });
}
