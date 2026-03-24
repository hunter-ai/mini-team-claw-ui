import type { Metadata } from "next";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: "MiniTeamClawUI",
  description: "面向 OpenClaw 的移动优先团队界面，支持成员隔离会话。",
};

export default function ChineseRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="min-h-full antialiased">
      <body className="min-h-screen bg-transparent text-[color:var(--text-primary)]">{children}</body>
    </html>
  );
}
