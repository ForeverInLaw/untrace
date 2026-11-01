import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MediaBackupWarning } from "../components/MediaBackupWarning";
import { Button, CheckboxLabel, Notice, Screen, TextField } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useDateFormat } from "../lib/format";
import { usePlatformsQuery } from "../queries/platforms";
import { usePreviewSummaryQuery, useStartRunMutation } from "../queries/runs";
import { useFlowStore } from "../stores/flowStore";
import { useRunStore } from "../stores/runStore";

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
  const summary = usePreviewSummaryQuery(runId).data;
  const platform = usePlatformsQuery().data?.find((item) => item.id === platformId)?.display_name ?? platformId;
  const start = useStartRunMutation(platformId, apply);
  const period = usePeriodLabel();
  const pending = summary?.pending ?? 0;
  const types = summary?.types.map(({ content_type: type }) => t(`contentType.${type}`).toLowerCase()).join(", ");
  const error = errorMessage(start.error);

  const onStart = async () => {
    await start.mutateAsync({ runId, backupPassphrase: passphrase.length > 0 ? passphrase : null });
    goTo("run");
  };

  return (
    <Screen
      actions={
        <>
          <Button onClick={() => goTo("preview")}>{t("backup.back")}</Button>
          <Button disabled={!confirmed || start.isPending || pending === 0} kind="primary" onClick={onStart}>
            {t("backup.start", { count: pending })}
          </Button>
        </>
      }
      heading={t("backup.heading")}
      lead={t("backup.lead")}
      note={t("backup.note")}
    >
      <TextField
        autoComplete="new-password"
        className="field--wide"
        label={t("backup.passphrase")}
        onChange={(event) => setPassphrase(event.target.value)}
        placeholder={t("backup.passphrasePlaceholder")}
        type="password"
        value={passphrase}
      />
      <section className="summary">
        <h2 className="section-heading">{t("backup.summary")}</h2>
        <dl className="facts">
          <div>
            <dt>{t("backup.account")}</dt>
            <dd>{platform}, {account}</dd>
          </div>
          <div>
            <dt>{t("backup.willDelete")}</dt>
            <dd><em className="count count--text">{t("backup.itemCount", { count: pending })}</em>: {types}</dd>
          </div>
          <div>
            <dt>{t("backup.period")}</dt>
            <dd>{period}</dd>
          </div>
          <div>
            <dt>{t("backup.stays")}</dt>
            <dd>{t("backup.staysValue", { protected: summary?.protected ?? 0 })}</dd>
          </div>
        </dl>
      </section>
      <MediaBackupWarning />
      <div className="confirm">
        <CheckboxLabel checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}>
          {t("backup.confirm", { count: pending, platform })}
        </CheckboxLabel>
      </div>
      {error && <Notice tone="fault">{error}</Notice>}
    </Screen>
  );
}
