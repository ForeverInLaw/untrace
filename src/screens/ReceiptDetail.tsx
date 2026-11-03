import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Seal } from "../components/Seal";
import { Button, Notice, Screen } from "../components/ui";
import { errorMessage, isPassphraseRefusal } from "../lib/errors";
import { accountName, useDateFormat } from "../lib/format";
import { usePlatformsQuery } from "../queries/platforms";
import {
  useExportReceiptMutation,
  useReceiptQuery,
  useReceiptsQuery,
  useVerifyBackupMutation,
} from "../queries/runs";
import { useFlowStore } from "../stores/flowStore";
import { useRunStore } from "../stores/runStore";
import { RunChatResults } from "./ChatCounts";
import { BackupExportResult, BackupPassphraseField, ExportBackupButton, useBackupPassphrase } from "./BackupExport";
import { UnsavedFilesSection } from "./UnsavedFilesSection";

const SEAL_SIZE = 280;

/// Groups a hex signature so a person can compare it by eye.
function formatSignature(hex: string): string {
  return (hex.match(/.{1,4}/g) ?? []).join(" ");
}

interface ReceiptDetailProps {
  runId: string;
  /// The way out of this screen: a new cleanup, or back to the receipt list.
  exit: { label: string; onClick: () => void };
}

export function ReceiptDetail({ runId, exit }: ReceiptDetailProps) {
  const { t } = useTranslation();
  const format = useDateFormat();
  const queryClient = useQueryClient();
  const flowPassphrase = useFlowStore((s) => s.passphrase);
  // The run store holds the latest run only; another receipt has no failure of its own there.
  const runFailure = useRunStore((s) => (s.runId === runId ? s.failure : null));
  const { passphrase, setPassphrase, backupPassphrase } = useBackupPassphrase(flowPassphrase);
  const receiptQuery = useReceiptQuery(runId);
  const receipt = receiptQuery.data;
  const receipts = useReceiptsQuery().data ?? [];
  const platforms = usePlatformsQuery().data ?? [];
  const verify = useVerifyBackupMutation();
  const index = receipts.findIndex(({ summary }) => summary.run_id === runId);
  const number = index >= 0 ? receipts.length - index : receipts.length + 1;
  const verified = verify.data?.ok === true;
  // A refused password says nothing about the backup, so its line stays unchecked.
  const verifyFailed = (verify.isError && !isPassphraseRefusal(verify.error)) || verify.data?.ok === false;
  const copySignature = useMutation({
    mutationFn: (signature: string) => navigator.clipboard.writeText(signature),
  });
  const exportReceipt = useExportReceiptMutation(runId);
  const hasReceipt = Boolean(receipt);

  // The list in the sidebar learns about the new receipt once it has landed.
  useEffect(() => {
    if (hasReceipt) {
      void queryClient.invalidateQueries({ queryKey: ["receipts"], exact: true });
    }
  }, [hasReceipt, queryClient]);

  const actions = (
    <>
      <Button kind={verified ? "primary" : "secondary"} onClick={exit.onClick}>{exit.label}</Button>
      <ExportBackupButton backupPassphrase={backupPassphrase} disabled={!receipt} runId={runId} />
      <Button disabled={!receipt || exportReceipt.isPending} onClick={() => exportReceipt.mutate()}>
        {t("receipt.export")}
      </Button>
      {!verified && (
        <Button
          disabled={!receipt || verify.isPending}
          kind="primary"
          onClick={() => verify.mutate({ runId, backupPassphrase })}
        >
          {t("receipt.verify")}
        </Button>
      )}
    </>
  );

  if (!receipt) {
    const failure = errorMessage(receiptQuery.error ?? runFailure);
    return (
      <Screen actions={actions} heading={t(receiptQuery.isError ? "receipt.loadFailed" : "receipt.waiting")}>
        {failure && <Notice tone="fault">{failure}</Notice>}
      </Screen>
    );
  }

  const { summary, signature_hex: signature } = receipt;
  const platform = platforms.find((item) => item.id === summary.platform)?.display_name ?? summary.platform;
  const onlyForSelf = summary.deleted_only_for_self ?? 0;
  const keptOnlyForSelf = summary.kept_only_for_self ?? 0;
  const undeletable = summary.undeletable ?? 0;
  const verifiedCounts = verify.data && { items: verify.data.items, files: verify.data.media_files };
  const backupLine = verify.data?.ok
    ? verify.data.complete
      ? <span className="fact-safe">{t("receipt.backupOk", verifiedCounts)}</span>
      : <span className="fact-caution">{t("receipt.backupCutOff", verifiedCounts)}</span>
    : verifyFailed
      ? <span className="fact-fault">{t("receipt.backupBad")}</span>
      : t("receipt.backupUnchecked");

  return (
    <Screen
      actions={actions}
      heading={
        <Trans components={{ n: <em className="count" /> }} count={summary.deleted} i18nKey="receipt.heading" />
      }
      lead={summary.failed > 0 ? t("receipt.failedLine", { count: summary.failed }) : undefined}
      note={t("preview.limit")}
    >
      {onlyForSelf > 0 && <Notice tone="caution">{t("receipt.onlyForSelfLine", { count: onlyForSelf })}</Notice>}
      <div className="receipt">
        <div>
          <dl className="facts facts--compact">
            <div><dt>{t("receipt.account")}</dt><dd>{platform}, {accountName(summary.account_label)}</dd></div>
            <div><dt>{t("receipt.started")}</dt><dd>{format.moment(summary.started_epoch_secs)}</dd></div>
            <div><dt>{t("receipt.finished")}</dt><dd>{format.moment(summary.finished_epoch_secs)}</dd></div>
            <div><dt>{t("receipt.deleted")}</dt><dd>{t("cleanup.plainNumber", { value: summary.deleted })}</dd></div>
            <div><dt>{t("receipt.skipped")}</dt><dd>{t("cleanup.plainNumber", { value: summary.skipped })}</dd></div>
            {keptOnlyForSelf > 0 && (
              <div><dt>{t("receipt.keptOnlyForSelf")}</dt><dd>{t("cleanup.plainNumber", { value: keptOnlyForSelf })}</dd></div>
            )}
            {undeletable > 0 && (
              <div><dt>{t("receipt.undeletable")}</dt><dd>{t("cleanup.plainNumber", { value: undeletable })}</dd></div>
            )}
            <div>
              <dt>{t("receipt.failed")}</dt>
              <dd className={summary.failed > 0 ? "fact-fault" : undefined}>
                {t("cleanup.plainNumber", { value: summary.failed })}
              </dd>
            </div>
            <div><dt>{t("receipt.backup")}</dt><dd>{backupLine}</dd></div>
            <div>
              <dt>{t("receipt.signature")}</dt>
              <dd className="signature">
                <span>{formatSignature(signature)}</span>
                <button
                  aria-label={t("receipt.copySignature")}
                  className="icon-button"
                  onClick={() => copySignature.mutate(signature)}
                  title={t("receipt.copySignature")}
                  type="button"
                >
                  {copySignature.isSuccess ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}
                </button>
              </dd>
            </div>
          </dl>
          {exportReceipt.data && <Notice tone="safe">{t("receipt.exported", { path: exportReceipt.data })}</Notice>}
          {exportReceipt.isError && <Notice tone="fault">{errorMessage(exportReceipt.error)}</Notice>}
          <BackupPassphraseField onChange={setPassphrase} runId={runId} value={passphrase} />
          {verify.isError && <Notice tone="fault">{errorMessage(verify.error)}</Notice>}
          <BackupExportResult runId={runId} />
        </div>
        <figure className="receipt__seal">
          <Seal runId={runId} size={SEAL_SIZE} />
          <figcaption>
            <strong>{t("cleanup.number", { number })}</strong>
            <small>{t("receipt.signed")}</small>
          </figcaption>
        </figure>
      </div>
      {/* Kept before the receipt, so once the receipt is there these are too. */}
      <RunChatResults ended={hasReceipt} runId={runId} />
      <UnsavedFilesSection account={summary.account_label} platformId={summary.platform} runId={runId} />
    </Screen>
  );
}
