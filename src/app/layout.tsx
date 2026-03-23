import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MiniTeamClawUI",
  description: "Mobile-first team UI for OpenClaw with isolated member sessions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="min-h-full antialiased">
      <body className="min-h-screen bg-transparent text-stone-50">{children}</body>
    </html>
  );
}
