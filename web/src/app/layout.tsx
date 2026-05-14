import type { Metadata } from "next";
import type { Viewport } from "next";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "AI Chat",
  description: "ChatGPT-like UI backed by Groq streaming",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-visual",
};

const THEME_INIT_SCRIPT = `(() => {
  try {
    const key = "theme";
    const stored = localStorage.getItem(key);
    const hasStored = stored === "light" || stored === "dark";
    const prefersDark =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = hasStored ? stored : prefersDark ? "dark" : "light";

    const root = document.documentElement;
    if (hasStored) root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");

    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
  } catch {}
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full overflow-hidden antialiased" suppressHydrationWarning>
      <body className="h-full overflow-hidden flex flex-col">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
