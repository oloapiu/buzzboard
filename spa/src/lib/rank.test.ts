import { describe, expect, it } from "vitest";
import { rankBetween } from "./rank.ts";

describe("rankBetween", () => {
  it("seeds a first rank between open bounds", () => {
    const r = rankBetween("", "");
    expect(r.length).toBeGreaterThan(0);
  });

  it("stays strictly between its bounds", () => {
    const a = rankBetween("", "");
    const b = rankBetween(a, "");
    const mid = rankBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
  });

  it("survives 200 nested top-half splits without violating order", () => {
    let low = "";
    for (let i = 0; i < 200; i++) {
      const r = rankBetween(low, "");
      if (low) expect(r > low).toBe(true);
      low = r;
    }
  });

  it("survives 200 nested bottom-half splits without violating order", () => {
    let high = rankBetween("", "");
    for (let i = 0; i < 200; i++) {
      const r = rankBetween("", high);
      expect(r < high).toBe(true);
      high = r;
    }
  });

  it("survives alternating insertions between two fixed neighbors", () => {
    let a = rankBetween("", "");
    let b = rankBetween(a, "");
    for (let i = 0; i < 100; i++) {
      const mid = rankBetween(a, b);
      expect(a < mid && mid < b).toBe(true);
      if (i % 2 === 0) a = mid;
      else b = mid;
    }
  });

  it("is deterministic", () => {
    expect(rankBetween("a3", "a7")).toBe(rankBetween("a3", "a7"));
  });
});
