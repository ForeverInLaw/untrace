/// Tauri commands reject with `{ message }`; everything else falls back to its text.
export function errorMessage(error: unknown): string | null {
  if (!error) {
    return null;
  }
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}
