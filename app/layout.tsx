import type { Metadata } from "next";
import "./globals.css";
// TSME redesign layer: brand tokens, shell and component styles. Loaded after globals.css so it takes precedence.
import "./tsme-theme.css";

export const metadata: Metadata = {
  title: "Exitwise — Employee Offboarding | TSME",
  description: "Secure every departure. A Microsoft 365 offboarding workspace by TSME with approved plans, data preservation and an audit trail.",
  icons: {
    icon: "/tsme-logo-footer.png",
    shortcut: "/tsme-logo-footer.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
