import type { Metadata } from "next";
import "@/app/globals.css";
import { LanguagePrompt } from "@/components/language-prompt";
import { getDictionary } from "@/lib/i18n/dictionary";

export const metadata: Metadata = {
  title: "MiniTeamClawUI",
  description: "Mobile-first team UI for OpenClaw with isolated member sessions.",
};

export default async function EnglishRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const messages = await getDictionary("en");

  return (
    <html lang="en" className="min-h-full antialiased">
      <body className="min-h-screen bg-transparent text-[color:var(--text-primary)]">
        {children}
        <LanguagePrompt messages={messages} />
      </body>
    </html>
  );
}
