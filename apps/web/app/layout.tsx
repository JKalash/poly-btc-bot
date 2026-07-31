import type { Metadata } from "next";
import type { ReactNode } from "react";
import Shell from "../components/Shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "BTC 5m Command Center",
  description: "Polymarket BTC five-minute research, paper trading and observability console",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
