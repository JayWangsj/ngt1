"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BatteryCharging,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Edit3,
  Package,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wrench,
} from "lucide-react";
import { money } from "@/lib/domain";
import { useLanguage } from "./language";
import { Button } from "./ui/button";

type Locale = "zh" | "it";
type Copy = { zh: string; it: string };
type PartOption = {
  id: string;
  name: Copy;
  cost: number;
  price: number;
  stock: number;
  reserved: number;
  duration: Copy;
  warranty: Copy;
  default?: boolean;
  enabled?: boolean;
};
type RepairProject = {
  id: string;
  name: Copy;
  basePrice: number;
  options: PartOption[];
};
type Device = {
  id: string;
  category: Copy;
  brand: string;
  model: string;
  projects: RepairProject[];
};
type QuoteLine = {
  key: number;
  projectId: string;
  optionId: string;
  actualPrice: number;
  manual: boolean;
  suggestedAfterSwitch?: number;
};
type View = "prices" | "new" | "detail" | "inspection" | "afterSales";

const c = (zh: string, it: string): Copy => ({ zh, it });
const devices: Device[] = [
  {
    id: "iphone-13",
    category: c("手机", "Smartphone"),
    brand: "Apple",
    model: "iPhone 13",
    projects: [
      {
        id: "screen",
        name: c("更换屏幕", "Sostituzione display"),
        basePrice: 7900,
        options: [
          {
            id: "lcd",
            name: c("普通 LCD 屏幕", "Display LCD standard"),
            cost: 3200,
            price: 7900,
            stock: 8,
            reserved: 2,
            duration: c("约 1 小时", "circa 1 ora"),
            warranty: c("3 个月", "3 mesi"),
            default: true,
            enabled: true,
          },
          {
            id: "oled",
            name: c("高品质 OLED 屏幕", "Display OLED alta qualità"),
            cost: 6500,
            price: 11900,
            stock: 4,
            reserved: 1,
            duration: c("约 1 小时", "circa 1 ora"),
            warranty: c("6 个月", "6 mesi"),
            enabled: true,
          },
          {
            id: "original",
            name: c("原装级屏幕", "Display qualità originale"),
            cost: 11800,
            price: 16900,
            stock: 1,
            reserved: 1,
            duration: c("约 90 分钟", "circa 90 minuti"),
            warranty: c("12 个月", "12 mesi"),
            enabled: true,
          },
        ],
      },
      {
        id: "battery",
        name: c("更换电池", "Sostituzione batteria"),
        basePrice: 5900,
        options: [
          {
            id: "battery-standard",
            name: c("标准容量电池", "Batteria capacità standard"),
            cost: 1800,
            price: 5900,
            stock: 7,
            reserved: 3,
            duration: c("约 45 分钟", "circa 45 minuti"),
            warranty: c("6 个月", "6 mesi"),
            default: true,
            enabled: true,
          },
          {
            id: "battery-premium",
            name: c("高循环电池", "Batteria lunga durata"),
            cost: 2600,
            price: 7900,
            stock: 3,
            reserved: 0,
            duration: c("约 45 分钟", "circa 45 minuti"),
            warranty: c("12 个月", "12 mesi"),
            enabled: true,
          },
        ],
      },
      {
        id: "software",
        name: c("软件维修", "Riparazione software"),
        basePrice: 4900,
        options: [],
      },
    ],
  },
  {
    id: "samsung-a55",
    category: c("手机", "Smartphone"),
    brand: "Samsung",
    model: "Galaxy A55",
    projects: [
      {
        id: "screen-a55",
        name: c("更换屏幕", "Sostituzione display"),
        basePrice: 12900,
        options: [
          {
            id: "a55-service-pack",
            name: c(
              "Samsung Service Pack 屏幕",
              "Display Samsung Service Pack",
            ),
            cost: 8200,
            price: 12900,
            stock: 3,
            reserved: 1,
            duration: c("约 2 小时", "circa 2 ore"),
            warranty: c("12 个月", "12 mesi"),
            default: true,
            enabled: true,
          },
        ],
      },
      {
        id: "cleaning-a55",
        name: c("清洁与除尘", "Pulizia interna"),
        basePrice: 3900,
        options: [],
      },
    ],
  },
];

const text = {
  prototype: c(
    "交互原型 · 不保存正式数据",
    "Prototipo interattivo · nessun dato reale salvato",
  ),
  prices: c("报价表", "Listino"),
  new: c("新建维修单", "Nuova riparazione"),
  detail: c("维修单详情", "Dettaglio riparazione"),
  inspection: c("检测后报价", "Preventivo dopo diagnosi"),
  afterSales: c("返修与售后", "Rientro e post-vendita"),
  device: c("设备型号", "Modello dispositivo"),
  project: c("维修项目", "Intervento"),
  partPlan: c("配件报价方案", "Opzione ricambio"),
  recommended: c("默认推荐", "Consigliato"),
  standardPrice: c("标准报价", "Prezzo standard"),
  currentPrice: c("本次报价", "Prezzo applicato"),
  cost: c("配件成本", "Costo ricambio"),
  actual: c("实际库存", "Scorta reale"),
  reserved: c("已预留", "Riservati"),
  available: c("可用库存", "Disponibili"),
  inStock: c("有货", "Disponibile"),
  outOfStock: c("缺货", "Esaurito"),
  outWarning: c(
    "此方案只能查看报价；可用库存为 0，不能继续预留或提交。",
    "Preventivo consultabile; disponibilità zero, impossibile riservare o continuare.",
  ),
  noPart: c("无需配件", "Nessun ricambio"),
  noPartHelp: c(
    "使用项目基础维修报价，不触发库存预留。",
    "Usa il prezzo base e non crea alcuna prenotazione di magazzino.",
  ),
  addProject: c("添加维修项目", "Aggiungi intervento"),
  remove: c("移除", "Rimuovi"),
  total: c("最终维修报价", "Totale riparazione"),
  continue: c("继续（原型）", "Continua (prototipo)"),
  stockBlocked: c(
    "存在缺货方案，无法继续",
    "Impossibile continuare: ricambio esaurito",
  ),
  changedDevice: c(
    "设备已更换，旧设备的维修项目和配件选择已清除。",
    "Dispositivo cambiato: interventi e ricambi incompatibili sono stati rimossi.",
  ),
  manual: c("人工调整", "Modificato manualmente"),
  switchedManual: c(
    "已切换配件，并保留当前人工报价。新方案建议价为",
    "Ricambio cambiato mantenendo il prezzo manuale. Nuovo prezzo suggerito:",
  ),
  adopt: c("采用新建议价", "Usa il nuovo suggerito"),
  keep: c("保留本次报价", "Mantieni prezzo attuale"),
  duration: c("预计时间", "Tempo previsto"),
  warranty: c("保修", "Garanzia"),
  oneProjectOnce: c(
    "每个维修项目只显示一次，展开后管理多个配件方案。",
    "Ogni intervento appare una sola volta e contiene più opzioni ricambio.",
  ),
  addPlan: c("新增配件方案", "Nuova opzione"),
  edit: c("编辑", "Modifica"),
  disable: c("停用", "Disattiva"),
  enable: c("启用", "Attiva"),
  setDefault: c("设为默认", "Imposta predefinito"),
  delete: c("删除", "Elimina"),
  saveDemo: c("保存模拟方案", "Salva opzione demo"),
  cancel: c("取消", "Annulla"),
  name: c("配件名称", "Nome ricambio"),
  price: c("建议总报价", "Prezzo totale suggerito"),
  quantity: c("数量", "Quantità"),
  quoteOnly: c(
    "报价包含维修服务费用；本页不执行真实库存操作。",
    "Il prezzo comprende il servizio; questa pagina non modifica il magazzino.",
  ),
  confirmed: c("客户已确认报价", "Preventivo confermato dal cliente"),
  paid: c("已收款 €50.00", "Incassati €50,00"),
  protected: c(
    "更换配件不会静默覆盖已确认价格。保存前需明确采用新建议价或保留当前价。",
    "Il cambio ricambio non sovrascrive il prezzo confermato. Prima del salvataggio occorre scegliere il prezzo.",
  ),
  inspectionReady: c(
    "检测结果：需要更换屏幕。选择方案后可保存并发送客户确认。",
    "Diagnosi: display da sostituire. Scegliere l'opzione prima di inviare al cliente.",
  ),
  warrantyCase: c("保修判断", "Valutazione garanzia"),
  freeRework: c("免费返修", "Rientro gratuito"),
  paidRework: c("收费返修", "Rientro a pagamento"),
  afterSalesHelp: c(
    "原维修记录、配件更换记录与库存处理规则会保留；本原型不执行收费或库存动作。",
    "Storico, ricambi sostituiti e regole di magazzino restano separati; il prototipo non registra addebiti o movimenti.",
  ),
} satisfies Record<string, Copy>;

function t(value: Copy, locale: Locale) {
  return value[locale];
}

function defaultLine(
  device: Device,
  projectId = device.projects[0].id,
  key = 1,
): QuoteLine {
  const project =
    device.projects.find((item) => item.id === projectId) ?? device.projects[0];
  const option =
    project.options.find((item) => item.default) ?? project.options[0];
  return {
    key,
    projectId: project.id,
    optionId: option?.id ?? "",
    actualPrice: option?.price ?? project.basePrice,
    manual: false,
  };
}

function ProjectIcon({ projectId }: { projectId: string }) {
  return projectId.includes("battery") ? (
    <BatteryCharging size={19} />
  ) : (
    <Wrench size={19} />
  );
}

export function MultiPartQuotePrototype() {
  const { locale } = useLanguage();
  const [view, setView] = useState<View>("prices");
  const tabs: { id: View; label: Copy }[] = [
    { id: "prices", label: text.prices },
    { id: "new", label: text.new },
    { id: "detail", label: text.detail },
    { id: "inspection", label: text.inspection },
    { id: "afterSales", label: text.afterSales },
  ];

  return (
    <section
      className="multi-quote-prototype"
      data-testid="multi-quote-prototype"
    >
      <div className="multi-quote-prototype-note">
        <span>
          <Check size={15} />
          {t(text.prototype, locale)}
        </span>
        <span>{t(text.quoteOnly, locale)}</span>
      </div>
      <nav
        className="multi-quote-tabs"
        aria-label={t(c("原型页面", "Pagine prototipo"), locale)}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={view === tab.id ? "active" : ""}
            aria-current={view === tab.id ? "page" : undefined}
            onClick={() => setView(tab.id)}
          >
            {t(tab.label, locale)}
          </button>
        ))}
      </nav>
      {view === "prices" ? (
        <PriceManagement locale={locale} />
      ) : (
        <WorkflowPrototype key={view} view={view} locale={locale} />
      )}
    </section>
  );
}

function DevicePicker({
  locale,
  value,
  onChange,
}: {
  locale: Locale;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <label className="multi-quote-device-picker">
      <span>{t(text.device, locale)}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {devices.map((device) => (
          <option key={device.id} value={device.id}>
            {device.brand} · {device.model}
          </option>
        ))}
      </select>
    </label>
  );
}

function PriceManagement({ locale }: { locale: Locale }) {
  const [deviceId, setDeviceId] = useState(devices[0].id);
  const device = devices.find((item) => item.id === deviceId) ?? devices[0];
  const [expanded, setExpanded] = useState<string[]>(["screen"]);
  const [options, setOptions] = useState<Record<string, PartOption[]>>(() =>
    Object.fromEntries(
      devices.flatMap((item) =>
        item.projects.map((project) => [
          `${item.id}:${project.id}`,
          project.options,
        ]),
      ),
    ),
  );
  const [adding, setAdding] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftPrice, setDraftPrice] = useState("99");
  const keyFor = (projectId: string) => `${device.id}:${projectId}`;
  const updateOptions = (projectId: string, next: PartOption[]) =>
    setOptions((current) => ({ ...current, [keyFor(projectId)]: next }));

  return (
    <div className="multi-quote-panel" data-testid="price-management-view">
      <div className="multi-quote-toolbar">
        <div>
          <h2>{t(text.prices, locale)}</h2>
          <p>{t(text.oneProjectOnce, locale)}</p>
        </div>
        <DevicePicker
          locale={locale}
          value={deviceId}
          onChange={(id) => {
            setDeviceId(id);
            setExpanded([]);
            setAdding("");
          }}
        />
      </div>
      <div className="multi-quote-device-title">
        <span>
          <Smartphone size={20} />
        </span>
        <div>
          <small>{t(device.category, locale)}</small>
          <strong>
            {device.brand} {device.model}
          </strong>
        </div>
      </div>
      <div className="multi-quote-project-list">
        {device.projects.map((project) => {
          const rows = options[keyFor(project.id)] ?? [];
          const open = expanded.includes(project.id);
          const activeRows = rows.filter((row) => row.enabled !== false);
          const prices = activeRows.map((row) => row.price);
          const priceLabel =
            prices.length > 1
              ? `${money(Math.min(...prices))} – ${money(Math.max(...prices))}`
              : money(prices[0] ?? project.basePrice);
          return (
            <article
              className="multi-quote-project"
              key={project.id}
              data-project={project.id}
            >
              <button
                type="button"
                className="multi-quote-project-header"
                aria-expanded={open}
                onClick={() =>
                  setExpanded((current) =>
                    current.includes(project.id)
                      ? current.filter((id) => id !== project.id)
                      : [...current, project.id],
                  )
                }
              >
                <span className="multi-quote-project-icon">
                  <ProjectIcon projectId={project.id} />
                </span>
                <span>
                  <strong>{t(project.name, locale)}</strong>
                  <small>
                    {rows.length
                      ? `${rows.length} ${t(c("个配件方案", "opzioni ricambio"), locale)}`
                      : t(text.noPart, locale)}
                  </small>
                </span>
                <b>{priceLabel}</b>
                <ChevronDown size={18} />
              </button>
              {open && (
                <div className="multi-quote-project-body">
                  {rows.length === 0 ? (
                    <div className="multi-quote-no-part">
                      <Package size={20} />
                      <div>
                        <strong>{t(text.noPart, locale)}</strong>
                        <small>{t(text.noPartHelp, locale)}</small>
                      </div>
                      <b>{money(project.basePrice)}</b>
                    </div>
                  ) : (
                    rows.map((option) => {
                      const available = Math.max(
                        0,
                        option.stock - option.reserved,
                      );
                      return (
                        <div
                          className={`multi-quote-plan-row${option.enabled === false ? " is-disabled" : ""}`}
                          key={option.id}
                          data-testid={`plan-${option.id}`}
                        >
                          <span className="multi-quote-radio">
                            {option.default && <Check size={13} />}
                          </span>
                          <div>
                            <strong>
                              {t(option.name, locale)}{" "}
                              {option.default && (
                                <em>{t(text.recommended, locale)}</em>
                              )}
                            </strong>
                            <small>
                              {t(text.cost, locale)} {money(option.cost)} ·{" "}
                              {t(text.quantity, locale)} 1 ·{" "}
                              {t(text.duration, locale)}{" "}
                              {t(option.duration, locale)} ·{" "}
                              {t(text.warranty, locale)}{" "}
                              {t(option.warranty, locale)}
                            </small>
                          </div>
                          <b>{money(option.price)}</b>
                          <span
                            className={`multi-quote-stock ${available > 0 ? "is-ok" : "is-empty"}`}
                          >
                            {available > 0
                              ? t(text.inStock, locale)
                              : t(text.outOfStock, locale)}{" "}
                            · {available}
                          </span>
                          <div className="multi-quote-row-actions">
                            {!option.default && (
                              <button
                                type="button"
                                onClick={() =>
                                  updateOptions(
                                    project.id,
                                    rows.map((row) => ({
                                      ...row,
                                      default: row.id === option.id,
                                    })),
                                  )
                                }
                              >
                                {t(text.setDefault, locale)}
                              </button>
                            )}
                            <button type="button" title={t(text.edit, locale)}>
                              <Edit3 size={15} />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                updateOptions(
                                  project.id,
                                  rows.map((row) =>
                                    row.id === option.id
                                      ? {
                                          ...row,
                                          enabled: row.enabled === false,
                                        }
                                      : row,
                                  ),
                                )
                              }
                            >
                              {option.enabled === false
                                ? t(text.enable, locale)
                                : t(text.disable, locale)}
                            </button>
                            <button
                              type="button"
                              title={t(text.delete, locale)}
                              onClick={() =>
                                updateOptions(
                                  project.id,
                                  rows.filter((row) => row.id !== option.id),
                                )
                              }
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                  {adding === project.id ? (
                    <form
                      className="multi-quote-add-plan"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!draftName.trim()) return;
                        updateOptions(project.id, [
                          ...rows,
                          {
                            id: `demo-${Date.now()}`,
                            name: c(draftName, draftName),
                            cost: 4000,
                            price: Math.round(Number(draftPrice || 0) * 100),
                            stock: 2,
                            reserved: 0,
                            duration: c("约 1 小时", "circa 1 ora"),
                            warranty: c("6 个月", "6 mesi"),
                            enabled: true,
                          },
                        ]);
                        setAdding("");
                        setDraftName("");
                      }}
                    >
                      <label>
                        <span>{t(text.name, locale)}</span>
                        <input
                          value={draftName}
                          onChange={(event) => setDraftName(event.target.value)}
                          autoFocus
                        />
                      </label>
                      <label>
                        <span>{t(text.price, locale)}</span>
                        <input
                          inputMode="decimal"
                          value={draftPrice}
                          onChange={(event) =>
                            setDraftPrice(event.target.value)
                          }
                        />
                      </label>
                      <Button type="submit">
                        <Check size={16} />
                        {t(text.saveDemo, locale)}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setAdding("")}
                      >
                        {t(text.cancel, locale)}
                      </Button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="multi-quote-add-plan-button"
                      onClick={() => setAdding(project.id)}
                    >
                      <Plus size={16} />
                      {t(text.addPlan, locale)}
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function WorkflowPrototype({
  view,
  locale,
}: {
  view: Exclude<View, "prices">;
  locale: Locale;
}) {
  const [deviceId, setDeviceId] = useState(devices[0].id);
  const device = devices.find((item) => item.id === deviceId) ?? devices[0];
  const detailLine = {
    ...defaultLine(device),
    actualPrice: 8500,
    manual: true,
  };
  const initial = view === "detail" ? [detailLine] : [defaultLine(device)];
  const [lines, setLines] = useState<QuoteLine[]>(initial);
  const [notice, setNotice] = useState("");
  const [reworkMode, setReworkMode] = useState<"free" | "paid">("free");
  const title =
    view === "new"
      ? text.new
      : view === "detail"
        ? text.detail
        : view === "inspection"
          ? text.inspection
          : text.afterSales;

  function changeDevice(id: string) {
    const next = devices.find((item) => item.id === id) ?? devices[0];
    setDeviceId(id);
    setLines([defaultLine(next)]);
    setNotice(t(text.changedDevice, locale));
  }

  return (
    <div className="multi-quote-panel" data-testid={`${view}-view`}>
      <div className="multi-quote-toolbar">
        <div>
          <h2>{t(title, locale)}</h2>
          <p>
            {view === "inspection"
              ? t(text.inspectionReady, locale)
              : view === "afterSales"
                ? t(text.afterSalesHelp, locale)
                : t(text.quoteOnly, locale)}
          </p>
        </div>
        <DevicePicker
          locale={locale}
          value={deviceId}
          onChange={changeDevice}
        />
      </div>
      {view === "detail" && (
        <div className="multi-quote-protection">
          <ShieldCheck size={20} />
          <div>
            <strong>
              {t(text.confirmed, locale)} · {t(text.paid, locale)}
            </strong>
            <p>{t(text.protected, locale)}</p>
          </div>
        </div>
      )}
      {view === "afterSales" && (
        <div className="multi-quote-rework-mode">
          <strong>{t(text.warrantyCase, locale)}</strong>
          <div>
            <button
              type="button"
              className={reworkMode === "free" ? "active" : ""}
              onClick={() => setReworkMode("free")}
            >
              {t(text.freeRework, locale)}
            </button>
            <button
              type="button"
              className={reworkMode === "paid" ? "active" : ""}
              onClick={() => setReworkMode("paid")}
            >
              {t(text.paidRework, locale)}
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p className="message warning" role="status">
          {notice}
        </p>
      )}
      <QuoteConfigurator
        locale={locale}
        device={device}
        lines={lines}
        onChange={setLines}
        protectedPrice={view === "detail"}
      />
    </div>
  );
}

function QuoteConfigurator({
  locale,
  device,
  lines,
  onChange,
  protectedPrice,
}: {
  locale: Locale;
  device: Device;
  lines: QuoteLine[];
  onChange: (lines: QuoteLine[]) => void;
  protectedPrice: boolean;
}) {
  const total = useMemo(
    () => lines.reduce((sum, line) => sum + line.actualPrice, 0),
    [lines],
  );
  const hasBlockedStock = lines.some((line) => {
    const project = device.projects.find((item) => item.id === line.projectId);
    const option = project?.options.find((item) => item.id === line.optionId);
    return option ? option.stock - option.reserved <= 0 : false;
  });
  const update = (key: number, next: Partial<QuoteLine>) =>
    onChange(
      lines.map((line) => (line.key === key ? { ...line, ...next } : line)),
    );

  function switchProject(line: QuoteLine, projectId: string) {
    const project =
      device.projects.find((item) => item.id === projectId) ??
      device.projects[0];
    const option =
      project.options.find((item) => item.default) ?? project.options[0];
    update(line.key, {
      projectId,
      optionId: option?.id ?? "",
      actualPrice: option?.price ?? project.basePrice,
      manual: false,
      suggestedAfterSwitch: undefined,
    });
  }
  function switchOption(line: QuoteLine, optionId: string) {
    const project = device.projects.find((item) => item.id === line.projectId)!;
    const option = project.options.find((item) => item.id === optionId)!;
    update(
      line.key,
      line.manual
        ? { optionId, suggestedAfterSwitch: option.price }
        : {
            optionId,
            actualPrice: option.price,
            suggestedAfterSwitch: undefined,
          },
    );
  }

  return (
    <div className="multi-quote-configurator">
      <div className="multi-quote-line-list">
        {lines.map((line, index) => {
          const project =
            device.projects.find((item) => item.id === line.projectId) ??
            device.projects[0];
          const option = project.options.find(
            (item) => item.id === line.optionId,
          );
          const available = option
            ? Math.max(0, option.stock - option.reserved)
            : null;
          const suggested = option?.price ?? project.basePrice;
          return (
            <article
              className="multi-quote-line"
              key={line.key}
              data-testid={`quote-line-${index}`}
            >
              <header>
                <span>
                  <ProjectIcon projectId={project.id} />
                </span>
                <div>
                  <small>
                    {t(text.project, locale)} {index + 1}
                  </small>
                  <strong>{t(project.name, locale)}</strong>
                </div>
                {lines.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      onChange(lines.filter((item) => item.key !== line.key))
                    }
                  >
                    {t(text.remove, locale)}
                  </button>
                )}
              </header>
              <div className="multi-quote-line-grid">
                <label>
                  <span>{t(text.project, locale)}</span>
                  <select
                    aria-label={`${t(text.project, locale)} ${index + 1}`}
                    value={line.projectId}
                    onChange={(event) =>
                      switchProject(line, event.target.value)
                    }
                  >
                    {device.projects.map((item) => (
                      <option key={item.id} value={item.id}>
                        {t(item.name, locale)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t(text.partPlan, locale)}</span>
                  <select
                    aria-label={`${t(text.partPlan, locale)} ${index + 1}`}
                    value={line.optionId}
                    disabled={project.options.length === 0}
                    onChange={(event) => switchOption(line, event.target.value)}
                  >
                    {project.options.length === 0 ? (
                      <option value="">{t(text.noPart, locale)}</option>
                    ) : (
                      project.options
                        .filter((item) => item.enabled !== false)
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {t(item.name, locale)} · {money(item.price)}
                            {item.default
                              ? ` · ${t(text.recommended, locale)}`
                              : ""}
                          </option>
                        ))
                    )}
                  </select>
                </label>
              </div>
              {option ? (
                <div
                  className={`multi-quote-option-summary${available === 0 ? " is-empty" : ""}`}
                >
                  <span className="multi-quote-option-icon">
                    <Package size={20} />
                  </span>
                  <div>
                    <strong>{t(option.name, locale)}</strong>
                    <small>
                      <Clock3 size={13} />
                      {t(option.duration, locale)} <ShieldCheck size={13} />
                      {t(option.warranty, locale)}
                    </small>
                  </div>
                  <dl>
                    <div>
                      <dt>{t(text.actual, locale)}</dt>
                      <dd>{option.stock}</dd>
                    </div>
                    <div>
                      <dt>{t(text.reserved, locale)}</dt>
                      <dd>{option.reserved}</dd>
                    </div>
                    <div>
                      <dt>{t(text.available, locale)}</dt>
                      <dd>{available}</dd>
                    </div>
                  </dl>
                  <span
                    className={`multi-quote-stock ${available! > 0 ? "is-ok" : "is-empty"}`}
                  >
                    {available! > 0
                      ? t(text.inStock, locale)
                      : t(text.outOfStock, locale)}
                  </span>
                </div>
              ) : (
                <div className="multi-quote-no-part compact">
                  <Package size={20} />
                  <div>
                    <strong>{t(text.noPart, locale)}</strong>
                    <small>{t(text.noPartHelp, locale)}</small>
                  </div>
                </div>
              )}
              {available === 0 && (
                <p className="message warning">
                  <AlertTriangle size={16} />
                  {t(text.outWarning, locale)}
                </p>
              )}
              <div className="multi-quote-price-editor">
                <div>
                  <span>{t(text.standardPrice, locale)}</span>
                  <strong data-testid={`suggested-${index}`}>
                    {money(suggested)}
                  </strong>
                </div>
                <label>
                  <span>
                    {t(text.currentPrice, locale)}{" "}
                    {line.manual && <em>{t(text.manual, locale)}</em>}
                  </span>
                  <span className="multi-quote-price-input">
                    <b>€</b>
                    <input
                      aria-label={`${t(text.currentPrice, locale)} ${index + 1}`}
                      inputMode="decimal"
                      value={(line.actualPrice / 100).toFixed(2)}
                      onChange={(event) => {
                        const value = Number(
                          event.target.value.replace(",", "."),
                        );
                        if (Number.isFinite(value))
                          update(line.key, {
                            actualPrice: Math.round(value * 100),
                            manual: true,
                          });
                      }}
                    />
                  </span>
                </label>
              </div>
              {line.suggestedAfterSwitch !== undefined && (
                <div className="multi-quote-price-choice" role="status">
                  <div>
                    <strong>
                      {t(text.switchedManual, locale)}{" "}
                      {money(line.suggestedAfterSwitch)}
                    </strong>
                    {protectedPrice && (
                      <small>{t(text.protected, locale)}</small>
                    )}
                  </div>
                  <Button
                    type="button"
                    onClick={() =>
                      update(line.key, {
                        actualPrice: line.suggestedAfterSwitch,
                        manual: false,
                        suggestedAfterSwitch: undefined,
                      })
                    }
                  >
                    {t(text.adopt, locale)}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      update(line.key, { suggestedAfterSwitch: undefined })
                    }
                  >
                    {t(text.keep, locale)}
                  </Button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      <button
        type="button"
        className="multi-quote-add-project"
        onClick={() => {
          const used = new Set(lines.map((line) => line.projectId));
          const project =
            device.projects.find((item) => !used.has(item.id)) ??
            device.projects[0];
          onChange([
            ...lines,
            defaultLine(
              device,
              project.id,
              Math.max(...lines.map((line) => line.key), 0) + 1,
            ),
          ]);
        }}
      >
        <Plus size={17} />
        {t(text.addProject, locale)}
      </button>
      <aside className="multi-quote-total-card">
        <div>
          <small>
            {lines.length} {t(c("个维修项目", "interventi"), locale)}
          </small>
          <strong>{t(text.total, locale)}</strong>
        </div>
        <b data-testid="quote-total">{money(total)}</b>
        <Button type="button" disabled={hasBlockedStock}>
          {hasBlockedStock
            ? t(text.stockBlocked, locale)
            : t(text.continue, locale)}
          <ChevronRight size={17} />
        </Button>
      </aside>
    </div>
  );
}
