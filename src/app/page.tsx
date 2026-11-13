"use client";

import {
  Button,
  Card,
  Center,
  Heading,
  IconButton,
  Input,
  InputGroup,
  Separator,
  Text,
  VStack,
} from "@chakra-ui/react";
import React from "react";
import { BsGithub } from "react-icons/bs";
import { useRouter, useSearchParams } from "next/navigation";
import GameRuleButton from "@/components/GameRuleButton";
import { useTranslation } from "@/i18n/index";
import { useGameSettingsStore } from "@/store/setting-store";
import { BsRobot } from "react-icons/bs";
import { toaster } from "@/components/ui/toaster";
import { useJoinRoomId } from "@/lib/use-join-room-id";
import { gameApi, GameApiError } from "@/lib/client-api";

const GamePage = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const joinParam = searchParams.get("join");

  const { t } = useTranslation();

  const { playerName, setPlayerName } = useGameSettingsStore();
  const [pending, setPending] = React.useState(false);

  const { joinRoomId, setJoinRoomId } = useJoinRoomId(joinParam);

  const hostRoom = async () => {
    if (!playerName) {
      toaster.create({
        title: `Enter your name`,
        type: "error",
        duration: 2000,
        closable: true,
      });
      return;
    }
    if (pending) return;
    setPending(true);
    try {
      const state = await gameApi.host(playerName);
      router.push(`/${state.gameId}`);
    } catch (error) {
      toaster.create({
        title: "Unable to create game",
        description: error instanceof Error ? error.message : "The request failed",
        type: "error",
        duration: 2000,
        closable: true,
      });
    } finally {
      setPending(false);
    }
  };

  const joinRoom = async () => {
    if (!playerName) {
      toaster.create({
        title: `Enter your name`,
        type: "error",
        duration: 2000,
        closable: true,
      });
      return;
    }
    if (pending) return;
    setPending(true);
    try {
      const state = await gameApi.join(joinRoomId, playerName);
      router.push(`/${state.gameId}`);
    } catch (error) {
      toaster.create({
        title: "Unable to join game",
        description: error instanceof GameApiError ? error.message : "The request failed",
        type: "error",
        duration: 2000,
        closable: true,
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Center w="100vw" h="100vh" bgColor="gray.700">
      <VStack gap="12px">
        <VStack>
          <Text
            bgGradient="to-r"
            gradientFrom="gray.300"
            gradientVia="yellow.400"
            gradientTo="pink.200"
            bgClip="text"
            fontSize="6xl"
            fontWeight="extrabold"
          >
            {t("NANA_GAME_TITLE")}{" "}
            <IconButton
              variant="outline"
              color="white"
              colorPalette="gray"
              aria-label="Mute"
              size="sm"
              fontSize="20px"
              onClick={() =>
                window.open("https://github.com/DwiAldi/nana-card-game")
              }
            >
              <BsGithub />
            </IconButton>
          </Text>
          <Text
            bgGradient="to-r"
            gradientFrom="gray.300"
            gradientVia="yellow.400"
            gradientTo="pink.200"
            bgClip="text"
            fontSize="lg"
            fontWeight="extrabold"
          >
            {t("NANA_GAME_DESCRIPTION")} <GameRuleButton />
          </Text>
        </VStack>
        {!joinParam && (
          <>
            <Card.Root
              w="sm"
              bg="green.50"
              borderColor="green.200"
              borderWidth="1px"
            >
              <Card.Body>
                <VStack gap="16px" alignItems="start">
                  <Heading size="md" color="green.700">
                    <BsRobot
                      style={{ display: "inline", marginRight: "8px" }}
                    />
                    {t("SINGLE_PLAYER_MODE")}
                  </Heading>
                  <Text color="green.600" fontSize="sm">
                    {t("SINGLE_PLAYER_DESCRIPTION")}
                  </Text>
                </VStack>
              </Card.Body>
              <Separator borderColor="green.200" />
              <Card.Footer justifyContent="flex-end">
                <Button
                  size="sm"
                  variant="solid"
                  colorPalette="green"
                  onClick={() => router.push("/local")}
                >
                  {t("START_SINGLE_PLAYER")}
                </Button>
              </Card.Footer>
            </Card.Root>
            <Card.Root w="sm">
              <Card.Body>
                <VStack gap="24px" alignItems="start">
                  <Heading size="md">{t("CREATE_GAME")}</Heading>
                  {/*<Heading size="md">*/}
                  {/*  {playerInfo.id} {playerInfo.name}*/}
                  {/*</Heading>*/}
                  <InputGroup startAddon={t("YOUR_NAME")}>
                    <Input
                      value={playerName}
                      onChange={(e) => setPlayerName(e.target.value)}
                      placeholder={t("YOUR_NAME")}
                    />
                  </InputGroup>
                </VStack>
              </Card.Body>
              <Separator borderColor="gray.300" />
              <Card.Footer justifyContent="flex-end">
                <Button
                  size="sm"
                  variant="solid"
                  colorPalette="blue"
                  onClick={() => hostRoom()}
                  disabled={pending}
                >
                  {t("CREATE_GAME")}
                </Button>
              </Card.Footer>
            </Card.Root>
          </>
        )}
        <Card.Root w="sm">
          <Card.Body>
            <VStack gap="24px" alignItems="start">
              <Heading size="md">{t("JOIN_GAME")}</Heading>
              <InputGroup startAddon={t("GAME_ID")}>
                <Input
                  placeholder={t("GAME_ID")}
                  value={joinRoomId}
                  onChange={(e) => setJoinRoomId(e.target.value)}
                />
              </InputGroup>
              <InputGroup startAddon={t("YOUR_NAME")}>
                <Input
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder={t("YOUR_NAME")}
                />
              </InputGroup>
            </VStack>
          </Card.Body>
          <Separator borderColor="gray.300" />
          <Card.Footer justifyContent="flex-end">
            <Button
              size="sm"
              variant="solid"
              colorPalette="blue"
              onClick={() => joinRoom()}
              disabled={pending}
            >
              {t("JOIN_GAME")}
            </Button>
          </Card.Footer>
        </Card.Root>
      </VStack>
    </Center>
  );
};

export default GamePage;
