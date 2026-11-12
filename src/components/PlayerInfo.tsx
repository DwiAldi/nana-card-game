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
      <Avatar
        bg={player?.isPlaying ? "green.500" : "gray.500"}
        src={player?.isWinner ? "/img/player/winner.png" : ""}
      />
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
