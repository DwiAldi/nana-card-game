"use client";

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Button,
  Center,
  HStack,
  VStack,
  Text,
} from "@chakra-ui/react";
import NanaCard from "@/components/NanaCard";
import { shuffle } from "@/lib/random";
import { toaster } from "@/components/ui/toaster";

// const ALL_CARDS = Array.from({ length: 9 }, (_, index) => index + 1);
const ALL_GAME_CARDS = [
  "1-a",
  "1-b",
  "1-c",
  "2-a",
  "2-b",
  "2-c",
  // "3-a",
  // "3-b",
  // "3-c",
];

export default function App() {
  const [cardDeck, setCardDeck] = useState(ALL_GAME_CARDS);
  const [myCards, setMyCards] = useState<string[]>([]);
  const [botCards, setBotCards] = useState<string[]>([]);
  const [publicCards, setPublicCards] = useState<string[]>([]);
  const [revealedCardNumbers, setRevealedCardNumbers] = useState<string[]>([]);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
        resetTimer.current = null;
      }
    },
    [],
  );

  const shuffleCards = () => {
    setCardDeck((prev) => shuffle(prev));
    console.log(cardDeck);
  };

  const dealRandomCard = (target: string) => {
    if (cardDeck.length === 0) return;
    const optCards = [...cardDeck];
    const randomIndex = Math.floor(Math.random() * optCards.length);
    const [removedCard] = optCards.splice(randomIndex, 1);
    setCardDeck(optCards);
    if (target === "me") {
      setMyCards((prev) => [...prev, removedCard]);
    } else if (target === "bot") {
      setBotCards((prev) => [...prev, removedCard]);
    } else if (target === "public") {
      setPublicCards((prev) => [...prev, removedCard]);
    }
  };

  const resetAll = () => {
    setMyCards([]);
    setBotCards([]);
    setPublicCards([]);
    setRevealedCardNumbers([]);
    setCardDeck(ALL_GAME_CARDS);
  };

  const onFlipToFront = (cardId: string) => {
    const cardNumber = cardId.split("-")[0];
    if (revealedCardNumbers.length === 0) {
      setRevealedCardNumbers([cardNumber]);
    } else if (revealedCardNumbers.includes(cardNumber)) {
      setRevealedCardNumbers((prev) => [...prev, cardNumber]);
    } else {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        resetTimer.current = null;
        resetAll();
        toaster.create({
          title: "Challenge failed",
          description: "Try to reveal three matching numbers in a row",
          type: "error",
          duration: 9000,
          closable: true,
        });
      }, 1000);
    }
  };

  return (
    <VStack w="100vw" h="100vh" bgColor="gray.100">
      <VStack w="600px" bgColor="#333" borderRadius="24px">
        <Text color="white">Computer</Text>
        <HStack h="136px" padding="8px" flexWrap="wrap">
          {botCards.map((cardId) => (
            <NanaCard
              onClick={onFlipToFront}
              key={cardId}
              cardId={cardId}
              number={Number(cardId.split("-")[0])}
              isRevealed={revealedCardNumbers.includes(cardId.split("-")[0])}
              w="90px"
              h="120px"
            />
          ))}
        </HStack>
      </VStack>

      <HStack
        // w="800px"
        // h="400px"
        padding="24px"
        border="24px solid "
        bgColor="#333"
        borderRadius="96px"
        justifyContent="center"
      >
        <Center w="140px" h="180px" borderRadius="24px" bgColor="#fff">
          <AnimatePresence>
            {cardDeck.map((cardId, index) => (
              <motion.div
                key={cardId}
                // layoutId={`card-${number}`}
                initial={{ opacity: 0, x: -200, y: -100 * index }}
                animate={{ opacity: 1, x: 2 + index, y: 2 + index }}
                transition={{ duration: 1 }}
                style={{ position: "absolute" }}
              >
                <NanaCard
                  onClick={onFlipToFront}
                  key={cardId}
                  cardId={cardId}
                  number={Number(cardId.split("-")[0])}
                  isRevealed={revealedCardNumbers.includes(cardId.split("-")[0])}
                  w="90px"
                  h="120px"
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </Center>
        <VStack w="600px" h="320px" bgColor="#fff" borderRadius="24px">
          <p>Public area</p>
          <HStack padding="8px" flexWrap="wrap">
            {publicCards.map((cardId) => (
              <NanaCard
                onClick={onFlipToFront}
                key={cardId}
                cardId={cardId}
                number={Number(cardId.split("-")[0])}
                isRevealed={revealedCardNumbers.includes(cardId.split("-")[0])}
                w="90px"
                h="120px"
              />
            ))}
          </HStack>
        </VStack>

        <VStack>
          <Button colorPalette="cyan" onClick={() => shuffleCards()}>
            Shuffle
          </Button>
          <Button colorPalette="cyan" onClick={() => dealRandomCard("bot")}>
            Deal to bot
          </Button>
          <Button colorPalette="cyan" onClick={() => dealRandomCard("public")}>
            Deal to public area
          </Button>
          <Button colorPalette="cyan" onClick={() => dealRandomCard("me")}>
            Deal to me
          </Button>
          <Button colorPalette="cyan" onClick={() => resetAll()}>
            Reset
          </Button>
        </VStack>
      </HStack>

      <HStack>
        <Button colorPalette="cyan">Lowest</Button>
        <VStack w="600px" bgColor="#333" borderRadius="24px">
          <Text color="white">Revealed cards: {revealedCardNumbers}</Text>
          <Text color="white">My cards</Text>
          <HStack h="136px" padding="8px" flexWrap="wrap">
            {myCards.map((cardId) => (
              <NanaCard
                onClick={onFlipToFront}
                key={cardId}
                cardId={cardId}
                number={Number(cardId.split("-")[0])}
                isRevealed={revealedCardNumbers.includes(cardId.split("-")[0])}
                w="90px"
                h="120px"
              />
            ))}
          </HStack>
        </VStack>
        <Button colorPalette="cyan">Highest</Button>
      </HStack>
    </VStack>
  );
}
