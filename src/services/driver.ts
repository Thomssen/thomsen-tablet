import type { DriverStatus, ScannedTablet, TestSessionStatus } from "@/types";
import { invoke } from "./ipc";

export const scanTablets = (): Promise<ScannedTablet[]> => invoke<ScannedTablet[]>("scan_tablets");

export const getDriverStatus = (): Promise<DriverStatus> => invoke<DriverStatus>("get_driver_status");

export const startDriver = (): Promise<DriverStatus> => invoke<DriverStatus>("start_driver");

export const stopDriver = (): Promise<DriverStatus> => invoke<DriverStatus>("stop_driver");

export const restartDriver = (): Promise<DriverStatus> => invoke<DriverStatus>("restart_driver");

/** Pushes the current active profile into the running driver without a
 * restart - call after saving a change to the profile that's active. */
export const applyActiveProfile = (): Promise<DriverStatus> => invoke<DriverStatus>("apply_active_profile");

/** Input Lab's live telemetry - `null` while the driver isn't running. */
export const getTestSessionStatus = (): Promise<TestSessionStatus | null> => invoke<TestSessionStatus | null>("get_test_session_status");

/** Temporarily makes the pipeline skip filtering entirely (session-only -
 * never touches the saved profile). Requires the driver to be running. */
export const setFilterBypass = (enabled: boolean): Promise<void> => invoke<void>("set_filter_bypass", { enabled });

/** Clears Input Lab's report-rate/jitter/dropped-report statistics only. */
export const resetTestSession = (): Promise<void> => invoke<void>("reset_test_session");
