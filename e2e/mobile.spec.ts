import { expect, test } from "@playwright/test";

/** 모바일 전용 동작 — iPhone 13 프로젝트에서만 */
test.describe("모바일 내비게이션", () => {
  test.skip(({ isMobile }) => !isMobile, "모바일 프로젝트 전용");

  test("☰ 버튼으로 사이드바를 열고 주제로 이동한다", async ({ page }) => {
    await page.goto("/");
    const menu = page.getByRole("button", { name: "메뉴 열기" });
    await expect(menu).toBeVisible();
    await menu.click();
    const link = page.getByRole("link", { name: /Redis/ }).first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/redis/);
  });

  test("노트는 모바일 목차(접힘)를 보여 주고 본문 글자가 너무 작지 않다", async ({ page }) => {
    await page.goto("/redis/notes/06-pipelining");
    await expect(page.locator("details.reader-mobile-toc")).toBeVisible();
    const size = await page.locator("article p").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(14);
  });

  test("상단 바의 버튼·선택 상자는 손가락으로 누를 만한 크기다 (24px 이상, WCAG 2.2 2.5.8)", async ({ page }) => {
    await page.goto("/");
    const controls = page.locator("header button:visible, header select:visible, header a:visible");
    const n = await controls.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const c = controls.nth(i);
      const box = await c.boundingBox();
      const name = (await c.getAttribute("aria-label")) ?? (await c.innerText()).trim();
      expect(box, name).not.toBeNull();
      expect(Math.min(box!.width, box!.height), `"${name}" 의 짧은 변`).toBeGreaterThanOrEqual(24);
    }
  });
});
