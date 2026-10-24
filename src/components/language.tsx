"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { messages, type Locale } from "@/lib/i18n";
import styles from "./language-switch.module.css";
const Context = createContext<{
  locale: Locale;
  change: (locale: Locale) => void;
}>({
  locale: "it",
  change: () => {},
});
export function LanguageProvider({
  initial,
  children,
}: {
  initial: Locale;
  children: ReactNode;
}) {
  const [locale, setLocale] = useState(initial);
  const router = useRouter();
  function change(next: Locale) {
    document.cookie =
      "ngt-locale=" + next + "; Path=/; Max-Age=31536000; SameSite=Lax";
    document.documentElement.lang = next === "zh" ? "zh-CN" : "it";
    setLocale(next);
    router.refresh();
  }
  return (
    <Context.Provider value={{ locale, change }}>{children}</Context.Provider>
  );
}
export function useLanguage() {
  return useContext(Context);
}
export function useMessages() {
  return messages[useLanguage().locale];
}
export function LanguageSwitch() {
  const { locale, change } = useLanguage();
  return (
    <div
      className={`language-switch ${styles.switch}`}
      role="group"
      aria-label="Lingua / 语言"
    >
      <button
        type="button"
        aria-pressed={locale === "it"}
        onClick={() => change("it")}
      >
        Italiano
      </button>
      <button
        type="button"
        aria-pressed={locale === "zh"}
        onClick={() => change("zh")}
      >
        中文
      </button>
    </div>
  );
}
