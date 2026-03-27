import { SharePage, generateSharePageMetadata } from "@/app/_shared/share-page";

export const generateMetadata = async () => generateSharePageMetadata("en");

export default function EnglishSharePage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  return <SharePage locale="en" params={params} />;
}
