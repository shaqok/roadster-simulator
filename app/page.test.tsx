import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import Home from "@/app/page";

test("홈 화면은 접속 즉시 시뮬레이터의 상태 표시와 조작 안내를 보여준다", () => {
  render(<Home />);

  expect(screen.getByRole("heading", { level: 1, name: /Roadster Simulator/i })).toBeInTheDocument();
  expect(screen.getByTestId("mode")).toHaveTextContent("주행");
  expect(screen.getByRole("progressbar", { name: "추진 공기" })).toHaveAttribute(
    "aria-valuenow",
    "100"
  );
  expect(screen.getByRole("button", { name: "재시작" })).toBeInTheDocument();
  expect(screen.getByText("Space")).toBeInTheDocument();
});
