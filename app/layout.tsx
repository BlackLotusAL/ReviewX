import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReviewX",
  description: "本地 CodeHub Merge Request 代码检视工具",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
