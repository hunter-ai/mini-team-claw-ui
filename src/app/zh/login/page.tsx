import { LoginPage } from "@/app/_shared/login-page";

export default async function ChineseLoginPage() {
  return LoginPage({ locale: "zh" });
}
