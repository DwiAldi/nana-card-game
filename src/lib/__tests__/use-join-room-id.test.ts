// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useJoinRoomId } from "@/lib/use-join-room-id";

describe("useJoinRoomId", () => {
  it("updates when client navigation changes the deep-link room", () => {
    const { result, rerender } = renderHook(
      ({ joinParam }) => useJoinRoomId(joinParam),
      { initialProps: { joinParam: "room-a" as string | null } },
    );

    rerender({ joinParam: "room-b" });

    expect(result.current.joinRoomId).toBe("room-b");
  });

  it("clears a displayed deep link when client navigation removes it", () => {
    const { result, rerender } = renderHook(
      ({ joinParam }) => useJoinRoomId(joinParam),
      { initialProps: { joinParam: "room-a" as string | null } },
    );

    rerender({ joinParam: null });

    expect(result.current.joinRoomId).toBe("");
  });

  it("preserves deliberate input when client navigation removes a deep link", () => {
    const { result, rerender } = renderHook(
      ({ joinParam }) => useJoinRoomId(joinParam),
      { initialProps: { joinParam: "room-a" as string | null } },
    );

    act(() => result.current.setJoinRoomId("manually-entered"));
    rerender({ joinParam: null });

    expect(result.current.joinRoomId).toBe("manually-entered");
  });
});
