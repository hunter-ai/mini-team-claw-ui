import { SharePage, generateSharePageMetadata } from "@/app/_shared/share-page";

export const generateMetadata = async () => generateSharePageMetadata("zh");

export default function ChineseSharePage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  return <SharePage locale="zh" params={params} />;
}
