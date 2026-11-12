"use client";

import { PublicCard } from "@/types";
import { Box, HStack, Text } from "@chakra-ui/react";
import { motion } from "framer-motion";
import NanaCard from "@/components/NanaCard";

const CollectionArea = ({ cards }: { cards: PublicCard[] }) => {
  const groupedCards = cards.reduce(
    (acc, card) => {
      if (card.number === undefined) return acc;
      if (!acc[card.number]) {
        acc[card.number] = [];
      }
      acc[card.number].push(card);
      return acc;
    },
    {} as { [key: string]: PublicCard[] },
  );

  return (
    <HStack width="220px" height="-webkit-fill-available">
      {cards.length > 0 && <Text color="white">Collected:</Text>}
      {Object.keys(groupedCards).map((key) => (
        <Box h="64px" w="45px" key={key}>
          {groupedCards[key].map((c, i) => (
            <motion.div
              key={c.id}
              animate={{ y: 4 * i }}
              transition={{ duration: 1 }}
              style={{ position: "absolute" }}
            >
              <NanaCard
                onClick={() => {}}
                cardId={c.id}
                number={c.number}
                isRevealed={true}
                w="45px"
                h="60px"
              />
            </motion.div>
          ))}
        </Box>
      ))}
    </HStack>
  );
};

export default CollectionArea;
