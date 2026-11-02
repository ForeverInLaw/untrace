import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Notice, TextField } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useExportBackupMutation } from "../queries/runs";

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

type ExportMutation = ReturnType<typeof useExportBackupMutation>;

interface ExportBackupButtonProps {
  mutation: ExportMutation;
  runId: string;
  backupPassphrase: string | null;
  kind?: "primary" | "secondary";
  disabled?: boolean;
}

export function ExportBackupButton({ mutation, runId, backupPassphrase, kind, disabled }: ExportBackupButtonProps) {
  const { t } = useTranslation();
  return (
    <Button
      disabled={disabled || mutation.isPending}
      kind={kind}
      onClick={() => mutation.mutate({ runId, backupPassphrase })}
    >
      {t(mutation.isPending ? "backup.exporting" : "backup.export")}
    </Button>
  );
}

/// What came of an export. A cancelled folder choice leaves nothing to say.
export function BackupExportResult({ mutation }: { mutation: ExportMutation }) {
  const { t } = useTranslation();
  const result = mutation.data;
  if (mutation.isError) {
    return <Notice tone="fault">{errorMessage(mutation.error)}</Notice>;
  }
  if (!result) {
    return null;
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
