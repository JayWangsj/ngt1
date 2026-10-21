export const categories = {
  PHONE: ["Telefono", "手机"],
  TABLET: ["Tablet", "平板"],
  LAPTOP: ["Notebook", "笔记本电脑"],
  DESKTOP: ["Computer desktop", "台式电脑"],
  CONSOLE: ["Console", "游戏机"],
  SMARTWATCH: ["Smartwatch", "智能手表"],
  SMARTBAND: ["Smartband", "智能手环"],
  OTHER: ["Altro", "其他设备"],
} as const;
export type Category = keyof typeof categories;
export function normalizeBrand(
  value: string,
  catalog: string[] = Object.values(brands).flat(),
) {
  const brand = value.trim().replace(/\s+/g, " ");
  const exact = catalog.find(
    (candidate) =>
      candidate.toLocaleLowerCase("it") === brand.toLocaleLowerCase("it"),
  );
  if (exact) return exact;
  return brand ? brand[0].toLocaleUpperCase("it") + brand.slice(1) : "";
}
export function modelKey(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("it")
    .replace(/[\s-]+/g, "");
}
export function normalizeModel(value: string, catalog: string[] = []) {
  const exact = catalog.find(
    (candidate) => modelKey(candidate) === modelKey(value),
  );
  if (exact) return exact;
  let model = value.trim().replace(/[\s-]+/g, " ");
  if (!model) return "";
  const iphone = model.match(/^i\s*phone\s*(.*)$/i);
  if (iphone) {
    const suffix = iphone[1].trim();
    model = `iPhone ${suffix.replace(
      /(pro|max|ultra|plus|mini|duo)/gi,
      " $1 ",
    )}`;
  }
  const knownSeries = ["Galaxy", "Pixel", "Xperia", "Moto", "Redmi Note"];
  const series = knownSeries.find((name) =>
    modelKey(model).startsWith(modelKey(name)),
  );
  if (series)
    model = `${series} ${modelKey(model).slice(modelKey(series).length)}`;
  model = model
    .replace(/^([a-z]+)(\d+)([45]g)$/i, "$1$2 $3")
    .replace(/(\d)(pro|max|ultra|plus|lite|mini)$/i, "$1 $2")
    .replace(/([a-z]+\d+)([45]g)$/i, "$1 $2");
  model = model
    .replace(/\biphone\b/gi, "iPhone")
    .replace(/(\d)(pro|max|ultra)$/i, "$1 $2")
    .replace(/([a-z])(\d)/i, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  model = model.replace(/\b(j\d{1,2})(20\d{2})\b/i, "$1 $2");
  return model
    .split(" ")
    .map((token) =>
      token === "iPhone"
        ? token
        : token.toLocaleLowerCase("it") === "macbook"
          ? "MacBook"
          : /^[45]g$/i.test(token)
            ? token.toLocaleUpperCase("it")
            : /^(?:[A-Za-z]+\d+|\d+[A-Za-z]+)$/.test(token)
              ? token[0].toLocaleUpperCase("it") + token.slice(1)
              : token
                ? token[0].toLocaleUpperCase("it") +
                  token.slice(1).toLocaleLowerCase("it")
                : token,
    )
    .join(" ");
}

export function normalizeDeviceModel(
  _brand: string,
  value: string,
  catalog: string[] = [],
) {
  return normalizeModel(value, catalog);
}
export const brands: Record<Category, string[]> = {
  PHONE: [
    "Apple",
    "Samsung",
    "Xiaomi",
    "Huawei",
    "Honor",
    "OPPO",
    "vivo",
    "realme",
    "OnePlus",
    "Motorola",
    "Google",
    "Nokia",
  ],
  TABLET: [
    "Apple",
    "Samsung",
    "Huawei",
    "Honor",
    "Xiaomi",
    "Lenovo",
    "Microsoft",
  ],
  LAPTOP: ["Apple", "Lenovo", "HP", "Dell", "ASUS", "Acer", "MSI", "Samsung"],
  DESKTOP: ["Assemblato", "Lenovo", "HP", "Dell", "ASUS", "Acer", "Apple"],
  CONSOLE: ["Sony", "Microsoft", "Nintendo"],
  SMARTWATCH: ["Apple", "Samsung", "Huawei", "Xiaomi", "Garmin"],
  SMARTBAND: ["Xiaomi", "Huawei", "Honor", "Fitbit"],
  OTHER: [],
};
export const models: Partial<Record<Category, Record<string, string[]>>> = {
  PHONE: {
    Apple: [
      "iPhone 11",
      "iPhone 12",
      "iPhone 13",
      "iPhone 13 Pro",
      "iPhone 14",
      "iPhone 14 Pro",
      "iPhone 15",
      "iPhone 15 Pro",
      "iPhone 16",
      "iPhone 16 Pro",
    ],
    Samsung: ["Galaxy S23", "Galaxy S24", "Galaxy A54", "Galaxy A55"],
    Google: ["Pixel 8", "Pixel 9"],
  },
  TABLET: {
    Apple: [
      "iPad (10a generazione)",
      "iPad Air (M2)",
      "iPad Pro (M4)",
      "iPad mini (6a generazione)",
    ],
    Samsung: ["Galaxy Tab S9", "Galaxy Tab A9"],
  },
  LAPTOP: {
    Apple: ["MacBook Air 13 M1", "MacBook Air 13 M2", "MacBook Pro 14 M3"],
  },
  CONSOLE: {
    Sony: ["PlayStation 4", "PlayStation 5", "PlayStation 5 Slim"],
    Microsoft: ["Xbox Series S", "Xbox Series X"],
    Nintendo: ["Switch", "Switch Lite", "Switch OLED"],
  },
};
const general = [
  ["Non si accende", "无法开机"],
  ["Alimentazione / ricarica", "充电／供电异常"],
  ["Riavvio improvviso", "自动关机／重启"],
  ["Lento / bloccato", "运行慢／卡顿"],
  ["Surriscaldamento", "过热"],
  ["Danno da liquido", "进液"],
  ["Danno da caduta", "跌落损坏"],
  ["Da diagnosticare", "故障待检测"],
];
const mobile = [
  ["Display rotto", "屏幕破裂"],
  ["Display nero / anomalo", "黑屏／显示异常"],
  ["Touch non funzionante", "触摸失灵"],
  ["Batteria dura poco", "续航差"],
  ["Fotocamera difettosa", "摄像头异常"],
  ["Audio / microfono", "扬声器／麦克风异常"],
  ["Tasti difettosi", "按键失灵"],
  ["SIM / rete mobile", "SIM／移动网络异常"],
  ["Wi-Fi / Bluetooth", "Wi-Fi／蓝牙异常"],
];
const computer = [
  ["Sistema non si avvia", "无法进入系统"],
  ["Schermata blu / blocco", "蓝屏／死机"],
  ["Display anomalo", "显示异常"],
  ["Tastiera / mouse", "键盘／鼠标异常"],
  ["Porte difettose", "接口异常"],
  ["Disco / memoria", "硬盘／存储异常"],
  ["Ventola rumorosa", "风扇异响"],
  ["Problemi di rete", "网络异常"],
];
export function faultPresets(category: Category): string[][] {
  return [
    ...general,
    ...(["PHONE", "TABLET"].includes(category)
      ? mobile
      : ["LAPTOP", "DESKTOP"].includes(category)
        ? computer
        : category === "CONSOLE"
          ? [
              ["Nessun segnale video", "无画面输出"],
              ["Controller non collegato", "手柄连接异常"],
              ["Deriva joystick", "摇杆漂移"],
              ["Gioco non leggibile", "无法读取游戏"],
            ]
          : []),
  ];
}
export function faultLabel(value: string, locale: "it" | "zh") {
  if (locale === "it") return value;
  const all = Object.keys(categories).flatMap((c) =>
    faultPresets(c as Category),
  );
  return value
    .split("; ")
    .map((v) => all.find(([it]) => it === v)?.[1] ?? v)
    .join("；");
}
