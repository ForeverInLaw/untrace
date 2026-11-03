import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Notice, TextField } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useByteFormat } from "../lib/format";
import {
  useBackupNeedsPassphraseQuery,
  useExportBackupMutation,
  useIsExporting,
  useLatestExport,
  useStopExportMutation,
} from "../queries/runs";
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

/// The password for `runId`'s backup, shown only when that backup was written with one.
export function BackupPassphraseField({ runId, value, onChange }: BackupPassphraseFieldProps & { runId: string }) {
  const { t } = useTranslation();
  if (!useBackupNeedsPassphraseQuery(runId).data) {
    return null;
  }
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

interface ExportBackupButtonProps {
  runId: string;
  backupPassphrase: string | null;
  kind?: "primary" | "secondary";
  disabled?: boolean;
}

/// Starts an export, and stops it while it is under way.
export function ExportBackupButton({ runId, backupPassphrase, kind, disabled }: ExportBackupButtonProps) {
  const { t } = useTranslation();
  const exportBackup = useExportBackupMutation(runId);
  const exporting = useIsExporting(runId);
  // The backend reports progress only once the export can be stopped.
  const stoppable = useExportStore((s) => runId in s.progress);
  const stop = useStopExportMutation();
  if (exporting) {
    return (
      <Button disabled={!stoppable || stop.isPending} kind={kind} onClick={() => stop.mutate(runId)}>
        {t("backup.stopExport")}
      </Button>
    );
  }
  return (
    <Button disabled={disabled} kind={kind} onClick={() => exportBackup.mutate(backupPassphrase)}>
      {t("backup.export")}
    </Button>
  );
}

/// A large backup takes a while to export, so this keeps it from looking stuck.
function ExportProgressLine({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const formatBytes = useByteFormat();
  const progress = useExportStore((s) => s.progress[runId]);
  if (!progress) {
    return <p className="help">{t("backup.exporting")}</p>;
  }
  const { done_bytes: done, total_bytes: total } = progress;
  return (
    <>
      <progress aria-label={t("backup.exportProgressLabel")} className="meter" max={total} value={done} />
      <p className="help">{t("backup.exportProgress", { done: formatBytes(done), total: formatBytes(total) })}</p>
    </>
  );
}

/// How far an export is, then what came of it. A closed folder choice leaves
/// nothing to say.
export function BackupExportResult({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const latest = useLatestExport(runId);
  if (latest?.status === "pending") {
    return <ExportProgressLine runId={runId} />;
  }
  if (latest?.status === "error") {
    return <Notice tone="fault">{errorMessage(latest.error)}</Notice>;
  }
  const result = latest?.data;
  if (!result || result.outcome === "no_folder") {
    return null;
  }
  if (result.outcome === "stopped") {
    return <p className="help">{t("backup.exportStopped")}</p>;
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
