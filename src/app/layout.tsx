import type { Metadata } from "next";
import "./globals.css";
import { PwaRegister } from "@/components/pwa-register";

export const metadata: Metadata = {
  title: "MiniTeamClawUI",
  description: "Mobile-first team UI for OpenClaw with isolated member sessions.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "MiniTeamClawUI",
    statusBarStyle: "black-translucent",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="min-h-full antialiased">
      <body className="min-h-screen bg-transparent text-stone-50">
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
