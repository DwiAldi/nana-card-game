import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface SettingState {
  playerName: string;
  soundEnabled: boolean;
  _hasHydrated: boolean;
}
interface SettingAction {
  toggleSoundEnabled: () => void;
  setPlayerName: (playerName: string) => void;
}

export const useGameSettingsStore = create<SettingState & SettingAction>()(
  persist(
    (set, get) => ({
      playerName: "",
      soundEnabled: false,
      setPlayerName: (playerName: string) => set({ playerName: playerName }),
      toggleSoundEnabled: () => set({ soundEnabled: !get().soundEnabled }),
      _hasHydrated: false,
      setHasHydrated: () => set({ _hasHydrated: true }),
    }),
    {
      name: "game-settings", // name of the item in the storage (must be unique)
      storage: createJSONStorage(() => window.localStorage),
      version: 2,
      // Keep only supported preferences when migrating older saved settings.
      migrate: (persistedState) => {
        const saved = persistedState as Partial<SettingState>;
        return {
          ...(typeof saved.playerName === "string" && { playerName: saved.playerName }),
          ...(typeof saved.soundEnabled === "boolean" && { soundEnabled: saved.soundEnabled }),
        };
      },
      partialize: ({ playerName, soundEnabled }) => ({
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
