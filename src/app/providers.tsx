"use client";

import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { useGameSettingsStore } from "@/store/setting-store";
import { Toaster } from "@/components/ui/toaster";

export function Providers({ children }: { children: React.ReactNode }) {
  const { _hasHydrated } = useGameSettingsStore();

  return (
    <ChakraProvider value={defaultSystem}>
      {_hasHydrated && children}
      <Toaster />
    </ChakraProvider>
  );
}
