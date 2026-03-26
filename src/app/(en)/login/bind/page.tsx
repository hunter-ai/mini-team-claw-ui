import { OidcBindPage } from "@/app/_shared/oidc-bind-page";

export default async function EnglishOidcBindPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  return OidcBindPage({ locale: "en", searchParams });
}
