import { notFound } from "next/navigation";
import {
  Boxes,
  FileText,
  LayoutDashboard,
  Settings,
  Users,
  Wrench,
} from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { PageHeader } from "@/components/common";
import { LanguageSwitch } from "@/components/language";
import { MultiPartQuotePrototype } from "@/components/multi-part-quote-prototype";
import { getLocale } from "@/lib/i18n-server";
import { isTestToolsEnabled } from "@/lib/test-tools-guard";

export default async function MultiPartQuotePrototypePage() {
  if (!isTestToolsEnabled()) notFound();
  const locale = await getLocale();
  const zh = locale === "zh";
  const navigation = [
    [LayoutDashboard, zh ? "总览" : "Panoramica"],
    [Wrench, zh ? "服务单" : "Riparazioni"],
    [Boxes, zh ? "库存" : "Magazzino"],
    [Users, zh ? "客户" : "Clienti"],
    [FileText, zh ? "报价表" : "Listino"],
    [Settings, zh ? "设置" : "Impostazioni"],
  ] as const;

  return (
    <div className="prototype-app-shell">
      <aside
        className="prototype-sidebar"
        aria-label={zh ? "原型导航" : "Navigazione prototipo"}
      >
        <BrandLogo className="prototype-brand-logo" />
        <small>{zh ? "业务管理" : "GESTIONE"}</small>
        <nav>
          {navigation.map(([Icon, label]) => (
            <span
              className={label === (zh ? "报价表" : "Listino") ? "active" : ""}
              key={label}
            >
              <Icon size={19} />
              {label}
            </span>
          ))}
        </nav>
        <LanguageSwitch />
      </aside>
      <main className="prototype-main-content">
        <PageHeader
          title={
            zh ? "多配件报价交互原型" : "Prototipo preventivi multi-ricambio"
          }
          description={
            zh
              ? "仅使用模拟数据，用于确认报价表与维修单交互。"
              : "Usa solo dati dimostrativi per validare listino e commessa."
          }
        />
        <MultiPartQuotePrototype />
        <footer className="footer">
          NGT · {zh ? "维修管理系统" : "Laboratorio riparazioni"}
          <span>Europe/Rome · EUR</span>
        </footer>
      </main>
    </div>
  );
}
