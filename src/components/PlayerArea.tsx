"use client";

import React, { useEffect, useEffectEvent } from "react";
import {
  VStack,
  HStack,
  Button,
  Center,
  Text,
} from "@chakra-ui/react";
import PlayerInfo from "@/components/PlayerInfo";
import HandArea from "@/components/HandArea";
import CollectionArea from "@/components/CollectionArea";
import { MultiplayerAction, PublicPlayer } from "@/types";
import { useGameSound } from "@/lib/use-game-sound";

const PlayerArea = ({
  isMe = false,
  player,
  act,
  disabled = false,
}: {
  isMe?: boolean;
  player: PublicPlayer | undefined;
  act: (action: MultiplayerAction, data?: unknown) => void;
  disabled?: boolean;
}) => {
  const { playWoosh, playSuccess } = useGameSound();
  // Every card in the viewer's own hand is visible in their private
  // projection. Only opponent/table reveals should drive the reveal sound.
  const revealedCount = isMe ? 0 : player?.hand.filter((card) => card.isRevealed).length;
  const collectionCount = player?.collection?.length;
  const playRevealSound = useEffectEvent(playWoosh);
  const playCollectionSound = useEffectEvent(playSuccess);

  useEffect(() => {
    if (revealedCount && revealedCount > 0) playRevealSound();
  }, [revealedCount]);

  useEffect(() => {
    if (collectionCount && collectionCount > 0) playCollectionSound();
  }, [collectionCount]);

  if (!player) {
    return (
      <Center
        css={{
          // width: "576px",
          width: "100%",
          height: "256px",
          backgroundColor: "transparent",
          padding: "8px",
          borderRadius: "8px",
        }}
      >
        <Text color="white" fontSize="xl">
          Waiting for a player
        </Text>
      </Center>
    );
  }

  return (
    <VStack
      css={{
        // width: "576px",
        width: "100%",
        height: "256px",
        backgroundColor: "transparent",
        padding: "8px",
        borderRadius: "8px",
      }}
    >
      <Center
        css={{
          width: "-webkit-fill-available",
          height: "78px",
          paddingX: "12px",
        }}
      >
        <PlayerInfo seatNumber={player.seat} player={player}></PlayerInfo>
        <CollectionArea cards={player.collection} />
      </Center>

      {player.hand && player.hand.length > 0 && (
        <HStack w="-webkit-fill-available">
          <Button
            colorPalette="gray"
            size="sm"
            whiteSpace="normal"
            width="32px"
            height="90px"
            writingMode="vertical-rl"
            onClick={() =>
              act("reveal-player", {
                targetPlayerId: player?.id,
                minMax: "min",
              })
            }
            disabled={disabled}
          >
            Lowest
          </Button>
          <HandArea isMe={isMe} cards={player.hand}></HandArea>
          <Button
            colorPalette="gray"
            size="sm"
            whiteSpace="normal"
            width="32px"
            height="90px"
            writingMode="vertical-rl"
            onClick={() =>
              act("reveal-player", {
                targetPlayerId: player?.id,
                minMax: "max",
              })
            }
            disabled={disabled}
          >
            Highest
          </Button>
        </HStack>
      )}
    </VStack>
  );
};

export default PlayerArea;
