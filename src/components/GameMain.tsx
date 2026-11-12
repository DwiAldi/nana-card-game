"use client";

import React, { useEffect, useEffectEvent } from "react";
import {
  Box,
  Button,
  Center,
  HStack,
  Tag,
  Text,
  VStack,
} from "@chakra-ui/react";
import { ActionPrefix, ServerState } from "@/types";
import PlayerArea from "@/components/PlayerArea";
import CardDeck from "@/components/CardDeck";
import PublicArea from "@/components/PublicArea";
import { calculateDisplayPlayerIndices } from "@/lib/game-helper";
import { useGameToast } from "@/lib/use-game-toast";
import Confetti from "react-confetti";
import { useWindowSize } from "@/lib/use-window-size";
import ChatArea from "@/components/ChatArea";
import BigToast from "@/components/BigToast";
import { useGameSound } from "@/lib/use-game-sound";
import { useGameSettingsStore } from "@/store/setting-store";

export default function GameMain({
  serverState,
  act,
}: {
  serverState: ServerState;
  act: (action: ActionPrefix, data?: unknown) => void;
}) {
  // hooks
  const { playerId } = useGameSettingsStore();
  const { width, height } = useWindowSize();

  const { toastInfo } = useGameToast();
  const { playWoosh, playWin, playDingDong } = useGameSound();

  // calculations
  const playingPlayer = serverState.players.find((p) => p.isPlaying);
  const isMePlaying = playingPlayer?.id === playerId;
  const gameBgColor = isMePlaying ? "green.700" : "gray.700";
  const displayPlayerIndices = calculateDisplayPlayerIndices(
    playerId,
    serverState.players,
  );

  const announceCurrentPlayer = useEffectEvent(() => {
    if (isMePlaying) {
      playDingDong();
    }
  });

  const announceGameStage = useEffectEvent(() => {
    if (serverState.gameStage === "stage:game-over") {
      playWin();
    }
    if (serverState.gameStage === "stage:in-game") {
      playWoosh();
    }
  });

  const bigToastMessage =
    serverState.gameStage === "stage:game-over"
      ? "Game over"
      : playingPlayer
        ? isMePlaying
          ? "Your turn"
          : `${playingPlayer.name}'s turn`
        : undefined;

  // effects
  useEffect(() => {
    announceCurrentPlayer();
  }, [playingPlayer?.id]);

  useEffect(() => {
    announceGameStage();
  }, [serverState.gameStage]);

  // render
  return (
    <Center
      w="100vw"
      h="100vh"
      bgColor={gameBgColor}
      position="relative"
      justifyContent="space-evenly"
    >
      <VStack position="fixed" top="16px" right="16px">
        <HStack>
          <Text color="white">Game ID:</Text>
          <Tag.Root
            colorPalette="gray"
            cursor="pointer"
            onClick={() => {
              const joinUrl = `${window.location.origin}?join=${serverState.gameId}`;
              navigator.clipboard.writeText(joinUrl);
              toastInfo("Invite link copied to clipboard");
            }}
          >
            <Tag.Label>{serverState.gameId}</Tag.Label>
          </Tag.Root>
        </HStack>
        <Button
          colorPalette="blue"
          onClick={() => act("action:start-game")}
        >
          Start game
        </Button>
      </VStack>

      <VStack h="100vh" flex={3} gap="16px" justifyContent="center">
        <PlayerArea
          player={serverState.players[displayPlayerIndices[2]]}
          act={act}
        ></PlayerArea>
        <PlayerArea
          player={serverState.players[displayPlayerIndices[1]]}
          act={act}
        ></PlayerArea>
      </VStack>

      <VStack flex={4} h="100vh" justifyContent="center">
        <PlayerArea
          player={serverState.players[displayPlayerIndices[3]]}
          act={act}
        ></PlayerArea>

        <VStack
          // w="576px"
          w="100%"
          h="400px"
          padding="24px"
          bgColor={gameBgColor}
          borderRadius="16px"
          justifyContent="center"
        >
          <Text color="white">Public area</Text>
          {serverState?.cardDeck && serverState.cardDeck.length > 0 && (
            <VStack>
              <CardDeck cards={serverState.cardDeck}></CardDeck>
            </VStack>
          )}

          {serverState?.publicCards && (
            <PublicArea cards={serverState?.publicCards} act={act}></PublicArea>
          )}
        </VStack>

        <PlayerArea
          isMe={true}
          player={serverState.players[displayPlayerIndices[0]]}
          act={act}
        ></PlayerArea>
      </VStack>

      <VStack flex={3} h="100vh" gap="16px" justifyContent="center">
        <PlayerArea
          player={serverState.players[displayPlayerIndices[4]]}
          act={act}
        ></PlayerArea>
        <PlayerArea
          player={serverState.players[displayPlayerIndices[5]]}
          act={act}
        ></PlayerArea>
      </VStack>

      <Box position="fixed" bottom="2" left="2">
        {/*<Text color="white">*/}
        {/*  Server state: {serverState.gameStage} - {serverState.gameSubStage} -{" "}*/}
        {/*  {serverState.timestamp}*/}
        {/*</Text>*/}
        <ChatArea messages={serverState.messages} act={act}></ChatArea>
      </Box>

      <Confetti
        width={width}
        height={height}
        recycle={false}
        run={serverState?.gameStage === "stage:game-over"}
        // onConfettiComplete={() => setRoundStage("")}
      />

      <BigToast message={bigToastMessage}></BigToast>
    </Center>
  );
}
