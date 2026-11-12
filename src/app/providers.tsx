"use client";

import { ChakraProvider } from "@chakra-ui/react";
import { useGameSettingsStore } from "@/store/setting-store";

export function Providers({ children }: { children: React.ReactNode }) {
  const { _hasHydrated } = useGameSettingsStore();

  return (
    <ChakraProvider>
      {_hasHydrated && children}
    </ChakraProvider>
  );
}
