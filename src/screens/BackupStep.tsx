import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, CheckboxLabel, Notice, Screen } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useByteFormat, useDateFormat } from "../lib/format";
import { usePlatformsQuery } from "../queries/platforms";
import { usePreviewSummaryQuery, useStartRunMutation } from "../queries/runs";
import { useFlowStore } from "../stores/flowStore";
import { useRunStore } from "../stores/runStore";
import { NewBackupPassphraseField } from "./BackupExport";

function usePeriodLabel() {
  const { t } = useTranslation();
  const format = useDateFormat();
  const { dateFrom, dateTo } = useFlowStore((s) => s.draft);
  if (dateFrom && dateTo) {
    return t("backup.periodRange", { from: format.calendarDay(dateFrom), to: format.calendarDay(dateTo) });
  }
  if (dateFrom) {
    return t("backup.periodFrom", { date: format.calendarDay(dateFrom) });
  }
  return dateTo ? t("backup.periodTo", { date: format.calendarDay(dateTo) }) : t("backup.periodAll");
}

export function BackupStep() {
  const { t } = useTranslation();
  const runId = useFlowStore((s) => s.runId) ?? "";
  const platformId = useFlowStore((s) => s.platformId);
  const account = useFlowStore((s) => s.account);
  const passphrase = useFlowStore((s) => s.passphrase);
  const setPassphrase = useFlowStore((s) => s.setPassphrase);
  const goTo = useFlowStore((s) => s.goTo);
  const apply = useRunStore((s) => s.apply);
  const [confirmed, setConfirmed] = useState(false);
  const [deleteIncomplete, setDeleteIncomplete] = useState(false);
  const summaryQuery = usePreviewSummaryQuery(runId);
  const summary = summaryQuery.data;
  const platform = usePlatformsQuery().data?.find((item) => item.id === platformId)?.display_name ?? platformId;
  const start = useStartRunMutation(platformId, apply);
  const period = usePeriodLabel();
  const gaps = summary?.backup_gaps ?? 0;
  const kept = deleteIncomplete ? 0 : gaps;
  const deleting = (summary?.pending ?? 0) - kept;
  const types = summary?.types.map(({ content_type: type }) => t(`contentType.${type}`).toLowerCase()).join(", ");
  const error = errorMessage(start.error ?? summaryQuery.error);
  const formatBytes = useByteFormat();
  const space = summary?.backup_space;

  const onStart = async () => {
    await start.mutateAsync({
      runId,
      backupPassphrase: passphrase.length > 0 ? passphrase : null,
      consent: { allowIncompleteBackup: deleteIncomplete, allowLostFiles: false },
    });
    goTo("run");
  };

  return (
    <Screen
      actions={
        <>
          <Button onClick={() => goTo("preview")}>{t("backup.back")}</Button>
          <Button disabled={!confirmed || start.isPending || deleting === 0 || space?.fits === false} kind="primary" onClick={onStart}>
            {t("backup.start", { count: deleting })}
          </Button>
        </>
      }
      heading={t("backup.heading")}
      lead={t("backup.lead")}
      note={t("backup.note")}
    >
      <NewBackupPassphraseField onChange={setPassphrase} value={passphrase} />
      <section className="summary">
        <h2 className="section-heading">{t("backup.summary")}</h2>
        <dl className="facts">
          <div>
            <dt>{t("backup.account")}</dt>
            <dd>{platform}, {account}</dd>
          </div>
          <div>
            <dt>{t("backup.willDelete")}</dt>
            <dd><em className="count count--text">{t("backup.itemCount", { count: deleting })}</em>: {types}</dd>
          </div>
          {space && space.media > 0 && (
            <div>
              <dt>{t("backup.mediaSize")}</dt>
              <dd>{formatBytes(space.media)}</dd>
            </div>
          )}
          <div>
            <dt>{t("backup.period")}</dt>
            <dd>{period}</dd>
          </div>
          <div>
            <dt>{t("backup.stays")}</dt>
            <dd>{t("backup.staysValue", { protected: (summary?.protected ?? 0) + kept })}</dd>
          </div>
        </dl>
      </section>
      {space?.fits === false && (
        <Notice tone="fault">
          {t("backup.notEnoughSpace", { needed: formatBytes(space.needed), available: formatBytes(space.available) })}
        </Notice>
      )}
      {gaps > 0 && <Notice tone="caution">{t("backup.gapNotice", { count: gaps })}</Notice>}
      <div className="confirm">
        {gaps > 0 && (
          <CheckboxLabel
            checked={deleteIncomplete}
            disabled={start.isPending}
            onChange={(event) => {
              setDeleteIncomplete(event.target.checked);
              setConfirmed(false);
            }}
          >
            {t("backup.gapConfirm", { count: gaps })}
          </CheckboxLabel>
        )}
        <CheckboxLabel checked={confirmed} disabled={start.isPending} onChange={(event) => setConfirmed(event.target.checked)}>
          {t("backup.confirm", { count: deleting, platform })}
        </CheckboxLabel>
      </div>
      {error && <Notice tone="fault">{error}</Notice>}
    </Screen>
  );
}
