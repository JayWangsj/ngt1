import type { Metadata } from "next";
import "./globals.css";
import formControlStyles from "@/components/ui/form-controls.module.css";
import statusDropdownStyles from "@/components/status-dropdown.module.css";
import { getLocale } from "@/lib/i18n-server";
import { LanguageProvider } from "@/components/language";
import { ComfortableScrollManager } from "@/components/comfortable-scroll-manager";
import { MOTION_PREFERENCE_KEY } from "@/lib/motion-preference";
import {
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_KEY,
} from "@/lib/sidebar-preference";

const motionPreferenceScript = `try{if(localStorage.getItem(${JSON.stringify(
  MOTION_PREFERENCE_KEY,
)})==="always")document.documentElement.dataset.motion="always"}catch{}`;
const sidebarPreferenceScript = `try{const d=document.documentElement,w=Number(localStorage.getItem(${JSON.stringify(
  SIDEBAR_WIDTH_KEY,
)})||${SIDEBAR_DEFAULT_WIDTH}),c=localStorage.getItem(${JSON.stringify(
  SIDEBAR_COLLAPSED_KEY,
)})==="true",v=c?${SIDEBAR_COLLAPSED_WIDTH}:Math.min(${SIDEBAR_MAX_WIDTH},Math.max(${SIDEBAR_MIN_WIDTH},Number.isFinite(w)?w:${SIDEBAR_DEFAULT_WIDTH}));d.style.setProperty("--sidebar-width",v+"px");d.dataset.sidebarCollapsed=String(c)}catch{}`;
const faviconThemeScript = `try{const l=document.getElementById("ngt-theme-icon");if(l)l.href="/brand/ngt-app-icon.svg?v=yellow-app-2"}catch{}`;

export const metadata: Metadata = {
  title: { default: "NGTManager", template: "%s · NGTManager" },
  description: "Gestione del laboratorio di riparazione",
  applicationName: "NGTManager",
  icons: {
    apple: [
      {
        url: "/brand/ngt-app-icon-256.png",
        sizes: "256x256",
        type: "image/png",
      },
    ],
  },
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  return (
    <html lang={locale === "zh" ? "zh-CN" : "it"} suppressHydrationWarning>
      <head>
        <link
          id="ngt-theme-icon"
          rel="icon"
          type="image/svg+xml"
          href="/brand/ngt-app-icon.svg?v=yellow-app-2"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          media="(prefers-color-scheme: light)"
          href="/brand/ngt-app-icon-32.png?v=yellow-app-2"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          media="(prefers-color-scheme: dark)"
          href="/brand/ngt-app-icon-dark-32.png?v=yellow-app-2"
        />
        <script dangerouslySetInnerHTML={{ __html: faviconThemeScript }} />
        <script dangerouslySetInnerHTML={{ __html: motionPreferenceScript }} />
        <script dangerouslySetInnerHTML={{ __html: sidebarPreferenceScript }} />
      </head>
      <body
        className={`${formControlStyles.scope} ${statusDropdownStyles.scope}`}
      >
        <LanguageProvider initial={locale}>
          <ComfortableScrollManager />
          {children}
        </LanguageProvider>
      </body>
    </html>
  );
}
