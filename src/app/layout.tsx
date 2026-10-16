import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "highlight.js/styles/github-dark.css";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Study", template: "%s · Study" },
  description: "주제별로 공부하고, 정리하고, 실제로 실험해 보는 개인 학습 사이트",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="min-w-0 flex-1 px-5 py-6 md:px-10 md:py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
