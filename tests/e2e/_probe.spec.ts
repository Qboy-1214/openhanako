import { test } from "@playwright/test";

/**
 * 临时探查：打印应用外壳内的关键可点击元素文本，便于编写稳健的导航 E2E。
 * 运行后从终端输出读取，确认后删除本文件。
 */
test("probe: dump nav-labelled buttons and headings", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell", { timeout: 30_000 });

  const buttons = await page.$$eval("button", (els) =>
    els
      .map((e) => (e.textContent ?? "").trim())
      .filter((t) => t.length > 0 && t.length < 30)
      .slice(0, 60),
  );
  // eslint-disable-next-line no-console
  console.log("BUTTONS:", JSON.stringify(buttons, null, 0));

  const headings = await page.$$eval("h1,h2,h3,[role=heading]", (els) =>
    els.map((e) => (e.textContent ?? "").trim()).filter((t) => t.length > 0).slice(0, 40),
  );
  // eslint-disable-next-line no-console
  console.log("HEADINGS:", JSON.stringify(headings, null, 0));

  if (errors.length) console.log("PAGEERRORS:", JSON.stringify(errors.slice(0, 5)));
});
