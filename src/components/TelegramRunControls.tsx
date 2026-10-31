import { useState } from "react";
import { Archive, CheckCircle2, Trash2 } from "lucide-react";
import { useTelegramStartRunMutation } from "../queries/telegram";
import { useVerifyBackupMutation } from "../queries/runs";
import { useRunStore } from "../stores/runStore";

interface TelegramRunControlsProps {
  runId: string;
  pending: number;
}

function errorMessage(error: unknown): string | null {
  if (!error) {
    return null;
  }
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/// Live Phase-2 controls for a previewed Telegram run: start the real deletion
/// (backup -> delete -> receipt) and verify the sealed backup afterwards.
/// Progress streams into the shared run store, so the run console + ledger
/// render it the same way they do for Bluesky.
export function TelegramRunControls({ runId, pending }: TelegramRunControlsProps) {
  const apply = useRunStore((s) => s.apply);
  const status = useRunStore((s) => s.status);
  const startRun = useTelegramStartRunMutation(apply);
  const verifyBackup = useVerifyBackupMutation();
  const [verification, setVerification] = useState<string | null>(null);

  const busy = startRun.isPending || verifyBackup.isPending;
  const running = status === "enumerating" || status === "deleting";
  const canStart = pending > 0 && !running && status !== "done";
  const canVerify = status === "done";
  const error = errorMessage(startRun.error) ?? errorMessage(verifyBackup.error);

  const onStart = async () => {
    setVerification(null);
    await startRun.mutateAsync({ runId, backupPassphrase: null });
  };

  const onVerify = async () => {
    const result = await verifyBackup.mutateAsync({ runId, backupPassphrase: null });
    setVerification(result.ok ? `Verified archive, ${result.chunks} chunks` : "Backup failed");
  };

  return (
    <div className="telegram-run-controls">
      <button
        className="command command--danger"
        disabled={busy || !canStart}
        onClick={onStart}
        type="button"
      >
        <Trash2 size={16} />
        Delete for real
      </button>
      {canVerify && (
        <button className="command" disabled={busy} onClick={onVerify} type="button">
          <Archive size={16} />
          Verify backup
        </button>
      )}
      {verification && (
        <div className="success-line">
          <CheckCircle2 size={16} />
          <span>{verification}</span>
        </div>
      )}
      {error && (
        <div className="error-line">
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
