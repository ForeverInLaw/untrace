import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreRows } from "../components/MoreRows";
import { Button, CheckboxLabel, Notice } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useDateFormat } from "../lib/format";
import { useItemText } from "../lib/itemText";
import { useRetryUnsavedFilesMutation, useUnsavedFilesQuery, useUnsavedItemsQuery } from "../queries/runs";
import { useFlowStore } from "../stores/flowStore";
import { selectRunLive, useRunStore } from "../stores/runStore";
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
  const itemText = useItemText();
  const flowPassphrase = useFlowStore((s) => s.passphrase);
  const retryStarted = useFlowStore((s) => s.retryStarted);
  const running = useRunStore(selectRunLive);
  const { passphrase, setPassphrase, backupPassphrase } = useBackupPassphrase(flowPassphrase);
  const [allowLostFiles, setAllowLostFiles] = useState(false);
  const unsavedQuery = useUnsavedFilesQuery(runId);
  const unsaved = unsavedQuery.data;
  const items = useUnsavedItemsQuery(runId);
  const retry = useRetryUnsavedFilesMutation(platformId);

  if (unsavedQuery.isError) {
    return <Notice tone="fault">{errorMessage(unsavedQuery.error)}</Notice>;
  }
  if (!unsaved || unsaved.total === 0) {
    return null;
  }

  const onRetry = () => {
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
            {items.data?.pages.flat().map((item) => (
              <tr key={item.platform_id}>
                <td><div className="cell-line"><span className="cell-line__text">{itemText(item)}</span></div></td>
                <td className="unsaved__why">{t(`unsaved.failure.${item.failure}`)}</td>
                <td className="cell-date">{item.created_at_secs === null ? "—" : format.day(item.created_at_secs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.isError && <Notice tone="fault">{errorMessage(items.error)}</Notice>}
        <MoreRows rows={items} />
      </div>
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
