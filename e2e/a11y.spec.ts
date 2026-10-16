import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { PAGES } from "./pages";

/**
 * 화면마다 세 가지를 본다 (데스크톱 1280×800 · iPhone 13 390×844 두 프로젝트로 각각 실행)
 *  1) 열린다 — HTTP < 400, 브라우저 콘솔에 잡히지 않은 예외(pageerror)가 없다
 *  2) 가로로 넘치지 않는다 — 문서 폭이 화면 폭을 넘으면 모바일에서 좌우로 흔들린다
 *  3) axe-core WCAG 2.1 A·AA 검사 — serious·critical 위반이 없다 (moderate 이하는 리포트에만 남김)
 */

async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const over = document.documentElement.scrollWidth - vw;
    if (over <= 1) return null;
    // 범인 찾기: 화면 밖으로 삐져나간 요소 중 가장 바깥 것 몇 개 (스스로 스크롤하는 영역 안쪽은 제외)
    const culprits: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.right <= vw + 1 || r.width === 0) continue;
      let p = el.parentElement, clipped = false;
      while (p && p !== document.body) {
        const o = getComputedStyle(p).overflowX;
        if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") { clipped = true; break; }
        p = p.parentElement;
      }
      if (clipped) continue;
      culprits.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className).split(" ").slice(0, 3).join(".")} (right=${Math.round(r.right)})`);
      if (culprits.length >= 5) break;
    }
    return { over, culprits };
  });
}

for (const p of PAGES) {
  test.describe(p.name, () => {
    test(`${p.path} — 열림 · 가로 넘침 없음 · axe`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));

      const res = await page.goto(p.path, { waitUntil: "domcontentloaded" });
      expect(res?.status(), "HTTP 상태").toBeLessThan(400);
      await page.waitForLoadState("networkidle").catch(() => {});
      await expect(page.locator("main, [role=main]").first()).toBeVisible();

      const overflow = await horizontalOverflow(page);
      expect(overflow, `가로 넘침 ${overflow?.over}px — ${overflow?.culprits.join(", ")}`).toBeNull();

      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const blocking = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      await info.attach("axe.json", { body: JSON.stringify(axe.violations, null, 2), contentType: "application/json" });
      const summary = blocking.map((v) => `[${v.impact}] ${v.id} — ${v.help} (${v.nodes.length}곳: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")})`);
      expect(summary, "axe serious·critical 위반").toEqual([]);

      expect(errors, "페이지 예외").toEqual([]);
    });
  });
}
