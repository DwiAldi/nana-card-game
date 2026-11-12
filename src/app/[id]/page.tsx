"use client";
import { Box } from "@chakra-ui/react";
import React from "react";
import { useRequest } from "ahooks";
import GameMain from "@/components/GameMain";
import { ActionPrefix, ServerState } from "@/types";
import { useParams, useRouter } from "next/navigation";
import GameRuleButton from "@/components/GameRuleButton";
import FullScreenButton from "@/components/FullScreenButton";
import VolumeButton from "@/components/VolumeButton";
import { useGameSettingsStore } from "@/store/setting-store";
import { toaster } from "@/components/ui/toaster";

const GameRoomPage = () => {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const { playerId } = useGameSettingsStore();

  const gameStateFetcher = async (): Promise<ServerState> => {
    const res = await fetch(
      `/api/game-state?id=${id}&playerId=${playerId}`,
      {
        cache: "no-cache",
      },
    );
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  };

  const {
    data: serverState,
    // refresh: refreshServerState,
    mutate: mutateServerState,
  } = useRequest(gameStateFetcher, {
    pollingInterval: 1000,
    onError: (error) => {
      toaster.create({
        title: "Unable to load the room",
        description: error.message,
        type: "error",
        duration: 6000,
        closable: true,
      });
      router.push("/");
    },
  });

  const actionExecutor = async (
    actionType: ActionPrefix,
    data?: unknown,
  ): Promise<ServerState> => {
    if (actLoading) {
      console.log("Action is currently loading, skipping fetch.");
      return Promise.reject("Action is currently loading.");
    }
    const res = await fetch("/api/action", {
      method: "POST",
      body: JSON.stringify({
        gameId: id,
        playerId: playerId,
        action: actionType,
        data: data,
      }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }
    return res.json();
  };

  const { run: act, loading: actLoading } = useRequest(actionExecutor, {
    manual: true,
    onSuccess: (result) => {
      mutateServerState(result);
      toaster.create({
        title: `Action completed`,
        // description: `${JSON.stringify(params)}`,
        type: "success",
        duration: 2000,
        closable: true,
      });
    },
    onError: (error) => {
      toaster.create({
        title: `Action failed`,
        description: error.message,
        type: "error",
        duration: 2000,
        closable: true,
      });
    },
  });

  return (
    <>
      {serverState && <GameMain serverState={serverState} act={act} />}

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
