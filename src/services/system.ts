import type { AppInfo } from "@/types";
import { invoke } from "./ipc";

export const getAppInfo = (): Promise<AppInfo> => invoke<AppInfo>("app_info");

/** The real Windows machine name, or `null` if it couldn't be read - never
 * hardcoded, never guessed. Callers own the "Your PC"-style fallback copy. */
export const getComputerName = (): Promise<string | null> => invoke<string | null>("get_computer_name");
