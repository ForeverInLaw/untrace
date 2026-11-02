import { useTranslation } from "react-i18next";
import { Button, Screen } from "../components/ui";
import { useDateFormat } from "../lib/format";
import type { InterruptedRun } from "../lib/tauri";
import { usePlatformsQuery } from "../queries/platforms";
import { useExportBackupMutation } from "../queries/runs";
import { useFlowStore } from "../stores/flowStore";
import { BackupExportResult, BackupPassphraseField, ExportBackupButton, useBackupPassphrase } from "./BackupExport";

interface InterruptedRunDetailProps {
  run: InterruptedRun;
  exit: { label: string; onClick: () => void };
}

/// A run that never got a receipt: what it deleted lives only in its backup.
export function InterruptedRunDetail({ run, exit }: InterruptedRunDetailProps) {
  const { t } = useTranslation();
  const format = useDateFormat();
  const flowPassphrase = useFlowStore((s) => s.passphrase);
  const { passphrase, setPassphrase, backupPassphrase } = useBackupPassphrase(flowPassphrase);
  const exportBackup = useExportBackupMutation();
  const platform = usePlatformsQuery().data?.find((item) => item.id === run.platform)?.display_name ?? run.platform;

  return (
    <Screen
      actions={
        <>
          <Button onClick={exit.onClick}>{exit.label}</Button>
          <ExportBackupButton backupPassphrase={backupPassphrase} kind="primary" mutation={exportBackup} runId={run.run_id} />
        </>
      }
      heading={t("run.failedHeading")}
      lead={t("receipts.interruptedLead")}
    >
      <dl className="facts facts--compact">
        <div><dt>{t("receipt.account")}</dt><dd>{platform}, {run.account_label}</dd></div>
        <div><dt>{t("receipt.started")}</dt><dd>{format.moment(run.started_epoch_secs)}</dd></div>
        <div><dt>{t("receipt.deleted")}</dt><dd>{t("cleanup.plainNumber", { value: run.deleted })}</dd></div>
      </dl>
      {exportBackup.isError && <BackupPassphraseField onChange={setPassphrase} value={passphrase} />}
      <BackupExportResult mutation={exportBackup} />
    </Screen>
  );
}
