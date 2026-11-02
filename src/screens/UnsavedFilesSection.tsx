import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, CheckboxLabel, Notice } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useDateFormat } from "../lib/format";
import { useRetryUnsavedFilesMutation, useUnsavedFilesQuery } from "../queries/runs";
import { useFlowStore } from "../stores/flowStore";
import { useRunStore } from "../stores/runStore";
import { NewBackupPassphraseField, useBackupPassphrase } from "./BackupExport";

interface UnsavedFilesSectionProps {
  runId: string;
  platformId: string;
  account: string;
}

/// What a run left on the platform because a file did not reach the backup, and the
/// way to finish the job. Empty for most runs.
export function UnsavedFilesSection({ runId, platformId, account }: UnsavedFilesSectionProps) {
  const { t } = useTranslation();
  const format = useDateFormat();
  const flowPassphrase = useFlowStore((s) => s.passphrase);
  const retryStarted = useFlowStore((s) => s.retryStarted);
  const apply = useRunStore((s) => s.apply);
  const resetRun = useRunStore((s) => s.reset);
  const running = useRunStore((s) => s.status === "deleting");
  const { passphrase, setPassphrase, backupPassphrase } = useBackupPassphrase(flowPassphrase);
  const [allowLostFiles, setAllowLostFiles] = useState(false);
  const unsavedQuery = useUnsavedFilesQuery(runId);
  const unsaved = unsavedQuery.data;
  const retry = useRetryUnsavedFilesMutation(platformId, apply);

  if (unsavedQuery.isError) {
    return <Notice tone="fault">{errorMessage(unsavedQuery.error)}</Notice>;
  }
  if (!unsaved || unsaved.total === 0) {
    return null;
  }

  const hidden = unsaved.total - unsaved.items.length;

  const onRetry = () => {
    resetRun();
    retry.mutate(
      { runId, backupPassphrase, allowLostFiles },
      { onSuccess: (retryId) => retryStarted({ runId: retryId, platformId, account, passphrase }) },
    );
  };

  return (
    <section className="unsaved">
      <h2 className="section-heading">{t("unsaved.heading", { count: unsaved.total })}</h2>
      <p className="help">{t("unsaved.lead")}</p>
      <div className="table-scroll unsaved__rows">
        <table className="table">
          <thead>
            <tr>
              <th>{t("preview.text")}</th>
              <th className="unsaved__why">{t("unsaved.why")}</th>
              <th className="cell-date">{t("preview.date")}</th>
            </tr>
          </thead>
          <tbody>
            {unsaved.items.map((item) => (
              <tr key={item.platform_id}>
                <td><div className="cell-line"><span className="cell-line__text">{item.text ?? t("preview.noText")}</span></div></td>
                <td className="unsaved__why">{t(`unsaved.failure.${item.failure}`)}</td>
                <td className="cell-date">{item.created_at_secs === null ? "—" : format.day(item.created_at_secs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && <p className="help">{t("unsaved.more", { count: hidden })}</p>}
      <NewBackupPassphraseField onChange={setPassphrase} value={passphrase} />
      {unsaved.unavailable > 0 && (
        <div className="confirm">
          <CheckboxLabel
            checked={allowLostFiles}
            disabled={retry.isPending}
            onChange={(event) => setAllowLostFiles(event.target.checked)}
          >
            {t("unsaved.allowLost")}
          </CheckboxLabel>
        </div>
      )}
      <div className="unsaved__retry">
        <Button disabled={retry.isPending || running} onClick={onRetry}>
          {t(allowLostFiles ? "unsaved.retryAndDelete" : "unsaved.retry")}
        </Button>
      </div>
      {retry.isError && <Notice tone="fault">{errorMessage(retry.error)}</Notice>}
    </section>
  );
}
