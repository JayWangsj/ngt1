import { describe, expect, it } from "vitest";
import {
  modelKey,
  normalizeBrand,
  normalizeDeviceModel,
  normalizeModel,
} from "@/lib/catalog";

describe("model normalization", () => {
  it("preserves catalog casing for lowercase brand names", () => {
    expect(normalizeBrand("VIVO")).toBe("vivo");
    expect(normalizeBrand("Realme")).toBe("realme");
  });
  it("prefers the current brand catalog display name", () => {
    expect(normalizeModel("galaxy-a17", ["Galaxy A17"])).toBe("Galaxy A17");
    expect(modelKey("Pixel 9 Pro")).toBe(modelKey("pixel-9pro"));
  });

  it("formats only high-confidence custom names", () => {
    expect(normalizeModel("iphoneduo")).toBe("iPhone Duo");
    expect(normalizeModel("iphone18promax")).toBe("iPhone 18 Pro Max");
    expect(normalizeModel("galaxys24ultra")).toBe("Galaxy S24 Ultra");
    expect(normalizeModel("X200")).toBe("X200");
    expect(normalizeModel("13T")).toBe("13T");
    expect(normalizeDeviceModel("Samsung", "galaxya265g")).toBe(
      "Galaxy A26 5G",
    );
    expect(normalizeDeviceModel("Apple", "iphone18promax")).toBe(
      "iPhone 18 Pro Max",
    );
    expect(normalizeDeviceModel("Apple", "iphone 13 inline")).toBe(
      "iPhone 13 Inline",
    );
  });

  it("keeps MacBook casing and separates Galaxy J model years", () => {
    expect(normalizeDeviceModel("Apple", "Macbook Pro")).toBe("MacBook Pro");
    expect(normalizeDeviceModel("Samsung", "Galaxy J52017")).toBe(
      "Galaxy J5 2017",
    );
  });
});
