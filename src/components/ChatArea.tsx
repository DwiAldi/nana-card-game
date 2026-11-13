"use client";

import React, { useState } from "react";
import {
  InputGroup,
  Input,
  Box,
  Text,
  Icon,
} from "@chakra-ui/react";
import { MultiplayerAction, Message } from "@/types";
import { motion, useAnimate } from "framer-motion";
import {
  RiSendPlaneFill,
  RiArrowDownSFill,
  RiArrowUpSFill,
} from "react-icons/ri";

const toHHSS = (timestamp: number) => {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
};

const ChatArea = ({
  messages,
  act,
  disabled = false,
}: {
  messages: Message[];
  act: (action: MultiplayerAction, data?: unknown) => void;
  disabled?: boolean;
}) => {
  const [message, setMessage] = useState<string>("");
  const [isCollapsed, setIsCollapsed] = useState<boolean>(true);
  const [animateRef, animate] = useAnimate();

  const onClick = () => {
    animate(animateRef.current, { y: isCollapsed ? 128 : 24 });
    setIsCollapsed((prev) => !prev);
  };

  const sendMessage = () => {
    if (message && message !== "") {
      act("chat", { message: message });
      setMessage("");
    }
  };

  return (
    <motion.div initial={{ y: 24 }} ref={animateRef}>
      <Box
        w="320px"
        padding="4px"
        border="1px solid white"
        borderRadius="8px"
        position="relative"
        bgColor="gray.700"
        paddingBottom="24px"
      >
        <button
          style={{
            position: "absolute",
            top: "4px",
            right: "4px",
            width: "120px",
            display: "flex",
            justifyContent: "flex-end",
          }}
          onClick={() => onClick()}
        >
          <Icon
            w="24px"
            h="24px"
            color="white"
            as={isCollapsed ? RiArrowDownSFill : RiArrowUpSFill}
          />
        </button>
        <Box h={"96px"} overflow="scroll">
          {messages.map((m: Message) => (
            <Text
              color="white"
              key={m.timestamp}
            >{`[${toHHSS(m.timestamp)}] ${m.playerName}: ${m.content}`}</Text>
          ))}
        </Box>
        <InputGroup
          endElement={
            <button onClick={sendMessage} aria-label="Send message" disabled={disabled}>
              <Icon w="16px" h="16px" color="white" as={RiSendPlaneFill} />
            </button>
          }
        >
          <Input
            size="sm"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            color="white"
            placeholder="send message"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                sendMessage();
              }
            }}
            enterKeyHint="send"
            disabled={disabled}
          />
        </InputGroup>
      </Box>
    </motion.div>
  );
};

export default ChatArea;
