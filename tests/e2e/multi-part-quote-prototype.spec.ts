import { mkdir } from "node:fs/promises";
import { expect, test } from "./fixtures";

const route = "/ui-prototypes/multi-part-quotes";
const evidence = ".local/multi-part-quote-prototype-evidence";

async function hideDevelopmentIndicator(page: import("@playwright/test").Page) {
  await page.locator("nextjs-portal").evaluateAll((portals) => {
    portals.forEach(
      (portal) => ((portal as HTMLElement).style.display = "none"),
    );
  });
}

test.beforeEach(async ({ context, page }) => {
  await mkdir(evidence, { recursive: true });
  await context.addCookies([
    {
      name: "ngt-locale",
      value: "zh",
      url: page.context().browser()?.browserType().name()
        ? "http://127.0.0.1"
        : "http://localhost",
    },
  ]);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(route);
});

test("groups part plans under one project and captures the key prototype views", async ({
  page,
}) => {
  const prices = page.getByTestId("price-management-view");
  await expect(prices.locator('[data-project="screen"]')).toHaveCount(1);
  await expect(prices.getByTestId("plan-lcd")).toBeVisible();
  await expect(prices.getByTestId("plan-oled")).toBeVisible();
  await expect(prices.getByTestId("plan-original")).toBeVisible();
  await page.getByRole("button", { name: "Italiano" }).click();
  await expect(page.getByRole("heading", { name: "Listino" })).toBeVisible();
  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.getByRole("heading", { name: "报价表" })).toBeVisible();
  await hideDevelopmentIndicator(page);
  await page.screenshot({
    path: `${evidence}/quote-management.png`,
    fullPage: true,
  });

  await page.getByRole("button", { name: "新建维修单", exact: true }).click();
  await expect(page.getByTestId("new-view")).toBeVisible();
  await page.screenshot({ path: `${evidence}/new-order.png`, fullPage: true });

  await page.getByRole("button", { name: "维修单详情", exact: true }).click();
  await expect(page.getByText("客户已确认报价")).toBeVisible();
  await page.screenshot({
    path: `${evidence}/order-detail.png`,
    fullPage: true,
  });
});

test("updates suggested prices, protects manual prices, blocks no-stock plans and resets incompatible selections", async ({
  page,
}) => {
  await page.getByRole("button", { name: "新建维修单", exact: true }).click();
  const line = page.getByTestId("quote-line-0");
  const part = line.getByLabel("配件报价方案 1");
  const actual = line.getByLabel("本次报价 1");

  await part.selectOption("oled");
  await expect(line.getByTestId("suggested-0")).toContainText("119");
  await expect(actual).toHaveValue("119.00");

  await actual.fill("105.00");
  await part.selectOption("original");
  await expect(actual).toHaveValue("105.00");
  await expect(line.getByText(/新方案建议价为.*169/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /存在缺货方案/ }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "采用新建议价" }).click();
  await expect(actual).toHaveValue("169.00");

  await line.getByLabel("维修项目 1").selectOption("software");
  await expect(line.locator(".multi-quote-no-part strong")).toHaveText(
    "无需配件",
  );
  await expect(page.getByTestId("quote-total")).toContainText("49");

  await page.getByRole("button", { name: "添加维修项目" }).click();
  await expect(page.locator(".multi-quote-line")).toHaveCount(2);
  await expect(page.getByTestId("quote-total")).toContainText("128");

  await page.getByLabel("设备型号").selectOption("samsung-a55");
  await expect(
    page.getByText("设备已更换，旧设备的维修项目和配件选择已清除。"),
  ).toBeVisible();
  await expect(page.locator(".multi-quote-line")).toHaveCount(1);
  await expect(page.getByTestId("quote-total")).toContainText("129");
});
