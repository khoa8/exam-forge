import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "ExamForge — adaptive exam coach",
  description:
    "Turn study material into an adaptive exam coach: diagnostic, practice, mock exam and a readiness dashboard. Grounded in your material.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        <header className="border-b bg-white">
          <div className="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between">
            <Link href="/" className="font-semibold text-lg tracking-tight">
              Exam<span className="text-indigo-600">Forge</span>
            </Link>
            <span className="text-xs text-slate-500 hidden sm:block">
              Material → Diagnostic → Practice → Mock Exam → Readiness
            </span>
          </div>
        </header>
        <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-8">{children}</main>
        <footer className="border-t bg-white">
          <div className="mx-auto max-w-5xl px-4 py-4 text-xs text-slate-500 flex flex-wrap gap-x-4 justify-between">
            <span>Your material and progress stay on this machine — nothing is uploaded without a configured LLM key.</span>
            <span>Readiness scores are internal heuristic estimates, not exam predictions.</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
