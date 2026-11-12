"use client";

import React from "react";
import { RiFullscreenFill } from "react-icons/ri";
import { IconButton } from "@chakra-ui/react";

const FullScreenButton = () => {
  return (
    <IconButton
      variant="outline"
      color="white"
      colorPalette="gray"
      aria-label="Fullscreen"
      size="sm"
      fontSize="20px"
      onClick={() => {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          document.body.requestFullscreen();
        }
      }}
    >
      <RiFullscreenFill />
    </IconButton>
  );
};

export default FullScreenButton;
