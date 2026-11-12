"use client";

import React, { useEffect, useEffectEvent } from "react";
import NanaCard from "@/components/NanaCard";
import { HStack, Box } from "@chakra-ui/react";
import { ActionPrefix, Card } from "@/types";
import { useGameSound } from "@/lib/use-game-sound";

const PublicArea = ({
  cards,
  act,
}: {
  cards: Card[];
  act: (action: ActionPrefix, data?: unknown) => void;
}) => {
  const { playWoosh } = useGameSound();
  const revealedCount = cards.filter((card) => card.isRevealed).length;
  const playRevealSound = useEffectEvent(playWoosh);

  useEffect(() => {
    if (revealedCount && revealedCount > 0) playRevealSound();
  }, [revealedCount]);

  return (
    <HStack padding="8px" flexWrap="wrap">
      {cards.map((card, i) =>
        card.id ? (
          <NanaCard
            onClick={() =>
              act("action:reveal-public-card", { cardId: card.id })
            }
            key={card.id}
            cardId={card.id}
            isRevealed={card.isRevealed}
            w="90px"
            h="120px"
          />
        ) : (
          <Box key={`placeholder-${i}`} w="90px" h="120px"></Box>
        ),
      )}
    </HStack>
  );
};

export default PublicArea;
