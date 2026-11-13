"use client";

import { useEffect, useState } from "react";

type WindowSizeSource = Pick<Window, "innerWidth" | "innerHeight">;

export type WindowSize = {
  width: number;
  height: number;
};

export function getWindowSize(source?: WindowSizeSource): WindowSize {
  if (!source) return { width: 0, height: 0 };

  return {
    width: source.innerWidth,
    height: source.innerHeight,
  };
}

export function useWindowSize(): WindowSize {
  const [size, setSize] = useState<WindowSize>(() =>
    getWindowSize(typeof window === "undefined" ? undefined : window),
  );

  useEffect(() => {
    const updateSize = () => setSize(getWindowSize(window));

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  return size;
}
