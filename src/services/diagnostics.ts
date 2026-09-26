import type { DiagnosticsSnapshot } from "@/types";
import { invoke } from "./ipc";

export const getDiagnostics = (): Promise<DiagnosticsSnapshot> => invoke<DiagnosticsSnapshot>("get_diagnostics");

export const generateDiagnosticReport = (): Promise<string> => invoke<string>("generate_diagnostic_report");

export const getRecentLogs = (maxLines: number): Promise<string> => invoke<string>("get_recent_logs", { maxLines });
