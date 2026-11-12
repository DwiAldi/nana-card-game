// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getWindowSize, useWindowSize } from "@/lib/use-window-size";

const setViewport = (width: number, height: number) => {
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: width },
    innerHeight: { configurable: true, value: height },
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("useWindowSize", () => {
  it("reads the initial viewport size on mount", () => {
    setViewport(1024, 768);

    const { result, unmount } = renderHook(() => useWindowSize());

    expect(result.current).toEqual({ width: 1024, height: 768 });
    unmount();
  });

  it("updates after the viewport is resized", () => {
    setViewport(800, 600);
    const { result, unmount } = renderHook(() => useWindowSize());

    act(() => {
      setViewport(1440, 900);
      window.dispatchEvent(new Event("resize"));
    });

    expect(result.current).toEqual({ width: 1440, height: 900 });
    unmount();
  });

  it("removes its resize listener on unmount", () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useWindowSize());

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function),
    );
  });
});
