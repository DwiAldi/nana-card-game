"use client";

import { useEffect, useRef, useState } from "react";

export function useJoinRoomId(joinParam: string | null) {
  const [joinRoomId, setJoinRoomId] = useState(joinParam ?? "");
  const previousJoinParam = useRef(joinParam);

  useEffect(() => {
    const previousDeepLink = previousJoinParam.current;

    // Synchronizing controlled input state with client-side URL navigation.
    setJoinRoomId((currentRoomId) => {
      if (joinParam !== null) return joinParam;
      return previousDeepLink !== null && currentRoomId === previousDeepLink
        ? ""
        : currentRoomId;
    });
    previousJoinParam.current = joinParam;
  }, [joinParam]);

  return { joinRoomId, setJoinRoomId };
}
