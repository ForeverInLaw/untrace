import i18n from "../i18n";
import type { CommandError } from "./tauri";

function isCommandError(error: object): error is CommandError {
  return "code" in error && typeof error.code === "string" && "message" in error;
}

/// Words any failure in the interface language: a command's or a run's by its code,
/// with the details its sentence needs. One without a sentence of its own, such as a
/// thrown value, reads as a general failure with its text as the details.
export function errorMessage(error: unknown): string | null {
  if (!error) {
    return null;
  }
  if (typeof error !== "object") {
    return i18n.t("errors.unknown", { message: String(error) });
  }
  // A code newer than this interface has no sentence yet.
  if (isCommandError(error) && i18n.exists(`errors.${error.code}`)) {
    return i18n.t(`errors.${error.code}`, error);
  }
  const message = "message" in error && typeof error.message === "string" ? error.message : String(error);
  return i18n.t("errors.unknown", { message });
}
