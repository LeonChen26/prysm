import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WorkBuddy Agent",
  description: "基于 pi-agent-core 的自主任务助手",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
