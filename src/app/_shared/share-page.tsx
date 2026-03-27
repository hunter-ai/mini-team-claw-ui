import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SessionShareView } from "@/components/session-share-view";
import { SharePasswordGate } from "@/components/share-password-gate";
import { getDictionary } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/config";
import { getPublicSessionShareSnapshot, isShareSnapshot } from "@/lib/session-share";

export async function generateSharePageMetadata(locale: Locale): Promise<Metadata> {
  const messages = await getDictionary(locale);
  return {
    title: messages.share.metadataTitle,
    description: messages.share.metadataDescription,
    robots: {
      index: false,
      follow: false,
    },
  };
}

export async function SharePage({
  locale,
  params,
}: {
  locale: Locale;
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const messages = await getDictionary(locale);
  const result = await getPublicSessionShareSnapshot(publicId);

  if (!result) {
    notFound();
  }

  return (
    <main className="min-h-[100dvh] bg-transparent">
      {result.requiresPassword || !result.snapshot || !isShareSnapshot(result.snapshot) ? (
        <SharePasswordGate publicId={publicId} locale={locale} messages={messages} />
      ) : (
        <SessionShareView snapshot={result.snapshot} locale={locale} messages={messages} />
      )}
    </main>
  );
}
