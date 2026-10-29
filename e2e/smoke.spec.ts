import { expect, test } from "@playwright/test";

test("홈 화면이 열리고 시뮬레이터 상태 표시가 보인다", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Roadster Simulator");
  await expect(page.getByTestId("simulator")).toBeVisible();
  await expect(page.getByTestId("mode")).toContainText("주행");
});
