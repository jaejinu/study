import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { subjects } from "@/lib/subjects";
import { listNotes } from "@/lib/notes";
import { AskPanel } from "@/components/AskPanel";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Study", template: "%s · Study" },
  description:
    "주제별로 공부하고, 정리하고, 실제로 실험해 보는 개인 학습 사이트",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const notes = Object.fromEntries(
    await Promise.all(
      subjects.map(async (s) => [
        s.id,
        (await listNotes(s.id)).map(({ slug, title, order }) => ({
          slug,
          title,
          order,
        })),
      ]),
    ),
  );
  return (
    <html
      lang="ko"
      data-theme="dark"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("study:theme");if(["light","dark","system"].includes(t))document.documentElement.dataset.theme=t;}catch(e){}`,
          }}
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body className="min-h-full">
        <AppShell notes={notes}>{children}</AppShell>
        <AskPanel />
      </body>
    </html>
  );
}
