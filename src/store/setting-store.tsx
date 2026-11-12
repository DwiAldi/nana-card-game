import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { randomString } from "@/lib/random";

interface SettingState {
  playerId: string;
  playerName: string;
  soundEnabled: boolean;
  _hasHydrated: boolean;
}
interface SettingAction {
  toggleSoundEnabled: any;
  setPlayerId: any;
  setPlayerName: any;
}

export const useGameSettingsStore = create<SettingState & SettingAction>()(
  persist(
    (set, get) => ({
      playerId: randomString(8),
      playerName: "",
      soundEnabled: false,
      setPlayerId: (playerId: string) => set({ playerId: playerId }),
      setPlayerName: (playerName: string) => set({ playerName: playerName }),
      toggleSoundEnabled: () => set({ soundEnabled: !get().soundEnabled }),
      _hasHydrated: false,
      setHasHydrated: () => set({ _hasHydrated: true }),
    }),
    {
      name: "game-settings", // name of the item in the storage (must be unique)
      storage: createJSONStorage(() => localStorage), // (optional) by default, 'localStorage' is used
      version: 1,
      // Keep only supported preferences when migrating older saved settings.
      migrate: (persistedState) => {
        const saved = persistedState as Partial<SettingState>;
        return {
          ...(typeof saved.playerId === "string" && { playerId: saved.playerId }),
          ...(typeof saved.playerName === "string" && { playerName: saved.playerName }),
          ...(typeof saved.soundEnabled === "boolean" && { soundEnabled: saved.soundEnabled }),
        };
      },
      partialize: ({ playerId, playerName, soundEnabled }) => ({
        playerId,
        playerName,
        soundEnabled,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state._hasHydrated = true;
        }
      },
    },
  ),
);
