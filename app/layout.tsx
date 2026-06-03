import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Creator Video Comparator — RAG + Gemini",
  description: "Compare YouTube and Instagram Reel metrics with LangChain RAG powered by Gemini.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
