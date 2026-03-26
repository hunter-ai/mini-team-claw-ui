import { OidcBindPage } from "@/app/_shared/oidc-bind-page";

export default async function ChineseOidcBindPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  return OidcBindPage({ locale: "zh", searchParams });
}
