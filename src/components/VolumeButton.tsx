"use client";

import React from "react";
import { IconButton } from "@chakra-ui/react";
import { BiVolumeFull, BiVolumeMute } from "react-icons/bi";

import { useGameSound } from "@/lib/use-game-sound";
import { useGameSettingsStore } from "@/store/setting-store";

const VolumeButton = () => {
  const { soundEnabled, toggleSoundEnabled } = useGameSettingsStore();

  const { playToggle } = useGameSound();

  return (
    <IconButton
      variant="outline"
      color="white"
      colorPalette="gray"
      aria-label="Sound"
      size="sm"
      fontSize="20px"
      onClick={() => {
        if (!soundEnabled) {
          playToggle();
        }
        toggleSoundEnabled();
      }}
    >
      {soundEnabled ? <BiVolumeFull /> : <BiVolumeMute />}
    </IconButton>
  );
};

export default VolumeButton;
