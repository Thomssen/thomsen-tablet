import type { AppSettings } from "@/types";
import { invoke } from "./ipc";

export const getSettings = (): Promise<AppSettings> => invoke<AppSettings>("get_settings");

export const saveSettings = (settings: AppSettings): Promise<AppSettings> =>
  invoke<AppSettings>("save_settings", { settings });

export const resetSettings = (): Promise<AppSettings> => invoke<AppSettings>("reset_settings");
