import { defineConfig, devices } from "@playwright/test";

/**
 * 모바일·접근성 자동 검사 (Playwright + axe-core).
 *   로컬:  pnpm e2e                    — 이미 떠 있는 서버(E2E_BASE_URL, 기본 http://localhost:3310)를 검사
 *   CI:    E2E_START=1 pnpm e2e         — 빌드된 앱을 3311 에서 띄워 검사 (.github/workflows/e2e.yml)
 * 결과: reports/e2e (HTML 리포트), 실패한 화면은 스크린샷·트레이스가 남는다.
 */
const port = 3311;
const start = process.env.E2E_START === "1";
const baseURL = process.env.E2E_BASE_URL ?? (start ? `http://localhost:${port}` : "http://localhost:3310");

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "reports/e2e", open: "never" }]],
  outputDir: "reports/e2e-artifacts",
  use: {
    baseURL,
    locale: "ko-KR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    // iPhone 13 화면(390×844, 터치, 모바일 UA)을 Chromium 으로 흉내 낸다 — CI 에 WebKit 을 깔지 않아도 된다
    { name: "iphone-13", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
  webServer: start
    ? {
        command: `pnpm start --port ${port}`,
        url: `${baseURL}/`,
        timeout: 120_000,
        reuseExistingServer: false,
      }
    : undefined,
});
