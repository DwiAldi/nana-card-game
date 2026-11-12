import { describe, expect, it } from "vitest";

import { getWindowSize } from "@/lib/use-window-size";

describe("getWindowSize", () => {
  it("returns zero dimensions when no browser window is available", () => {
    expect(getWindowSize()).toEqual({ width: 0, height: 0 });
  });

  it("reads the current browser viewport dimensions", () => {
    expect(getWindowSize({ innerWidth: 1280, innerHeight: 720 })).toEqual({
      width: 1280,
      height: 720,
    });
  });
});
