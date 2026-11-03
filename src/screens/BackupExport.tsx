import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Notice, TextField } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useByteFormat } from "../lib/format";
import type { ExportProgress } from "../lib/tauri";
import { useExportBackupMutation, useStopExportMutation } from "../queries/runs";
import { useExportStore } from "../stores/exportStore";

/// The backup password a screen is holding, as its backup commands want it.
export function useBackupPassphrase(initial: string) {
  const [passphrase, setPassphrase] = useState(initial);
  return { passphrase, setPassphrase, backupPassphrase: passphrase.length > 0 ? passphrase : null };
}

interface BackupPassphraseFieldProps {
  value: string;
  onChange: (value: string) => void;
}

export function BackupPassphraseField({ value, onChange }: BackupPassphraseFieldProps) {
  const { t } = useTranslation();
  return (
    <TextField
      autoComplete="off"
      className="field--wide receipt__passphrase"
      label={t("receipt.passphrase")}
      onChange={(event) => onChange(event.target.value)}
      type="password"
      value={value}
    />
  );
}

/// The password for a backup about to be written.
export function NewBackupPassphraseField({ value, onChange }: BackupPassphraseFieldProps) {
  const { t } = useTranslation();
  return (
    <TextField
      autoComplete="new-password"
      className="field--wide"
      label={t("backup.passphrase")}
      onChange={(event) => onChange(event.target.value)}
      placeholder={t("backup.passphrasePlaceholder")}
      type="password"
      value={value}
    />
  );
}

type ExportMutation = ReturnType<typeof useExportBackupMutation>;

interface ExportBackupButtonProps {
  mutation: ExportMutation;
  runId: string;
  backupPassphrase: string | null;
  kind?: "primary" | "secondary";
  disabled?: boolean;
}

/// Starts an export, and stops it while it is under way.
export function ExportBackupButton({ mutation, runId, backupPassphrase, kind, disabled }: ExportBackupButtonProps) {
  const { t } = useTranslation();
  const exporting = useExportStore((s) => runId in s.progress);
  const stop = useStopExportMutation();
  if (exporting) {
    return (
      <Button disabled={stop.isPending} kind={kind} onClick={() => stop.mutate(runId)}>
        {t("backup.stopExport")}
      </Button>
    );
  }
  return (
    <Button disabled={disabled || mutation.isPending} kind={kind} onClick={() => mutation.mutate({ runId, backupPassphrase })}>
      {t("backup.export")}
    </Button>
  );
}

/// A large backup takes a while to export, so this keeps it from looking stuck.
function ExportProgressLine({ progress }: { progress: ExportProgress }) {
  const { t } = useTranslation();
  const formatBytes = useByteFormat();
  const { done_bytes: done, total_bytes: total } = progress;
  if (total === 0) {
    return <p className="help">{t("backup.exporting")}</p>;
  }
  return (
    <>
      <progress aria-label={t("backup.exportProgressLabel")} className="meter" max={total} value={done} />
      <p className="help">{t("backup.exportProgress", { done: formatBytes(done), total: formatBytes(total) })}</p>
    </>
  );
}

/// How far an export is, then what came of it. A closed folder choice leaves
/// nothing to say.
export function BackupExportResult({ mutation, runId }: { mutation: ExportMutation; runId: string }) {
  const { t } = useTranslation();
  const progress = useExportStore((s) => s.progress[runId]);
  const result = mutation.data;
  if (progress) {
    return <ExportProgressLine progress={progress} />;
  }
  if (mutation.isError) {
    return <Notice tone="fault">{errorMessage(mutation.error)}</Notice>;
  }
  if (!result || result.outcome === "no_folder") {
    return null;
  }
  if (result.outcome === "stopped") {
    return <Notice tone="safe">{t("backup.exportStopped")}</Notice>;
  }
  const saved = t("backup.exported", { folder: result.folder, items: result.items, files: result.media_files });
  if (result.complete) {
    return <Notice tone="safe">{saved}</Notice>;
  }
  return (
    <Notice tone="caution">
      {t("backup.exportCutOff")} {saved}
      {result.partial_file && <> {t("backup.exportPartialFile", { file: result.partial_file })}</>}
    </Notice>
  );
}
