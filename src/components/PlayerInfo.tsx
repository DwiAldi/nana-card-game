"use client";

import React from "react";
import { Avatar, Box, Heading, HStack, Text } from "@chakra-ui/react";
import { Player } from "@/types";

const PlayerInfo = ({
  seatNumber,
  player,
}: {
  seatNumber: number;
  player: Player | undefined;
}) => {
  return (
    <HStack width="200px" gap="4">
      <Avatar.Root bg={player?.isPlaying ? "green.500" : "gray.500"}>
        <Avatar.Fallback name={player?.name ?? `Player ${seatNumber}`} />
        {player?.isWinner && <Avatar.Image src="/img/player/winner.png" />}
      </Avatar.Root>
      <Box>
        <Heading color="white" size="sm">
          Player {seatNumber} {player?.isPlaying && " - Playing"}{" "}
          {player?.isWinner && " - Winner"}
        </Heading>
        <Text color="white">{player ? player.name : "Waiting for a player..."} </Text>
      </Box>
    </HStack>
  );
};

export default PlayerInfo;
