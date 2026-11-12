"use client";

import React from "react";
import NanaCard from "@/components/NanaCard";
import { Box, HStack } from "@chakra-ui/react";
import { Card } from "@/types";
import { useGameToast } from "@/lib/use-game-toast";

const HandArea = ({
  isMe = false,
  cards,
}: {
  isMe: boolean;
  cards: Card[] | undefined;
}) => {
  const { toastInfo } = useGameToast();

  return (
    <HStack h="136px" w="-webkit-fill-available" padding="8px">
      {cards?.map((card) => (
        <Box
          key={card.id}
          height="100%"
          width="100%"
          maxWidth="90px"
          position="relative"
        >
          <NanaCard
            style={{
              position: "absolute",
              top: isMe && card.isRevealed ? "-32px" : "0",
            }}
            onClick={() => toastInfo("You can only select a player's lowest or highest card")}
            cardId={card.id}
            isRevealed={isMe ? true : card.isRevealed}
            w="90px"
            h="120px"
          />
        </Box>
      ))}
      <Box height="100%" width="50%" />
    </HStack>
  );
};

export default HandArea;
