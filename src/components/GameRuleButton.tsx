"use client";

import React from "react";
import { BsQuestionCircle } from "react-icons/bs";
import {
  IconButton,
  Modal,
  Button,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalCloseButton,
  ModalBody,
  Text,
  ModalFooter,
  VStack,
  useDisclosure,
} from "@chakra-ui/react";

const GameRuleButton = () => {
  const { isOpen, onOpen, onClose } = useDisclosure();

  return (
    <>
      <IconButton
        variant="outline"
        color="white"
        colorScheme="none"
        aria-label="Mute"
        size="sm"
        fontSize="20px"
        onClick={() => onOpen()}
        icon={<BsQuestionCircle />}
      />

      <Modal isOpen={isOpen} onClose={onClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>Game rules</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack alignItems="start">
              <Text>Collect sets of three cards with the same number.</Text>
              <Text>The deck has 36 cards: three copies of each number from 1 to 12.</Text>
              <Text>Starting a challenge:</Text>
              <Text>
                On your turn, reveal any player's lowest or highest card, or any card in the public area.
              </Text>
              <Text>A challenge has two possible outcomes:</Text>
              <Text>
                1. If you reveal a different number, the challenge fails and play passes to the next player.
              </Text>
              <Text>
                2. If you reveal three matching numbers in a row, collect the set. In online play, play passes to the next player; in single-player mode, you continue your turn.
              </Text>
              <Text>You win when you meet any of these conditions:</Text>
              <Text>1. Collect three sets.</Text>
              <Text>
                2.
                Collect two sets whose numbers add up to 7 or differ by 7 (for example, 2 + 5 = 7 or 11 - 4 = 7).
              </Text>
              <Text>3. Collect all three 7s to win immediately.</Text>
              <Text>
                Note: With two players, remove 11s and 12s. With three players, remove 12s. With four to six players, use all 36 cards.
              </Text>
            </VStack>
          </ModalBody>

          <ModalFooter>{/*<Button variant="ghost">OK</Button>*/}</ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
};

export default GameRuleButton;
