"use client";

import { Box } from "@chakra-ui/react";
import React, { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import GameMain from "@/components/GameMain";
import GameRuleButton from "@/components/GameRuleButton";
import FullScreenButton from "@/components/FullScreenButton";
import VolumeButton from "@/components/VolumeButton";
import { toaster } from "@/components/ui/toaster";
import { gameApi, GameApiError } from "@/lib/client-api";
import type { MinMax } from "@/lib/game-helper";
import type { MultiplayerAction, PublicGameState } from "@/types";

const GameRoomPage = () => {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [serverState, setServerState] = useState<PublicGameState>();
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const state = await gameApi.poll(id);
        if (!active) return;
        setServerState(state);
        timer = setTimeout(poll, 1000);
      } catch (error) {
        if (!active) return;
        if (error instanceof GameApiError && error.status === 429) {
          timer = setTimeout(poll, Math.max(1, error.retryAfterSeconds ?? 1) * 1000);
          return;
        }
        toaster.create({
          title: "Unable to load the room",
          description: error instanceof Error ? error.message : "The request failed",
          type: "error",
          duration: 6000,
          closable: true,
        });
        router.push("/");
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, router]);

  const act = useCallback(async (action: MultiplayerAction, data?: unknown) => {
    if (actionPending) return;
    setActionPending(true);
    try {
      const payload = (data ?? {}) as Record<string, string>;
      const next = action === "start"
        ? await gameApi.start(id)
        : action === "reveal-public"
          ? await gameApi.revealPublic(id, payload.cardId)
          : action === "reveal-player"
            ? await gameApi.revealPlayer(id, payload.targetPlayerId, payload.minMax as MinMax)
            : await gameApi.chat(id, payload.message);
      setServerState(next);
    } catch (error) {
      toaster.create({
        title: "Action failed",
        description: error instanceof Error ? error.message : "The request failed",
        type: "error",
        duration: 3000,
        closable: true,
      });
    } finally {
      setActionPending(false);
    }
  }, [actionPending, id]);

  return (
    <>
      {serverState && (
        <GameMain serverState={serverState} act={act} actionPending={actionPending} />
      )}
      <Box
        position="fixed"
        top="16px"
        left="16px"
        display="flex"
        flexDirection="column"
        gap="8px"
      >
        <FullScreenButton />
        <VolumeButton />
        <GameRuleButton />
      </Box>
    </>
  );
};

export default GameRoomPage;
