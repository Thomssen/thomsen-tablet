import type { OsuStatus, OsuVariant } from "@/types";
import { invoke } from "./ipc";

/** Real-time osu! stable/lazer install and running status. */
export const getOsuStatus = (): Promise<OsuStatus> => invoke<OsuStatus>("get_osu_status");

/** Launches the given osu! variant from its resolved path. Rejects if that
 * variant can't be found - the caller should point the user at Settings. */
export const launchOsu = (variant: OsuVariant): Promise<void> => invoke<void>("launch_osu", { variant });
