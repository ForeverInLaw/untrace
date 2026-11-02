import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Seal } from "../components/Seal";
import { Notice, Screen } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useDateFormat } from "../lib/format";
import { useInterruptedRunsQuery, useReceiptsQuery } from "../queries/runs";
import { useFlowStore } from "../stores/flowStore";
import { InterruptedRunDetail } from "./InterruptedRunDetail";
import { ReceiptDetail } from "./ReceiptDetail";

interface ReceiptRowProps {
  mark: ReactNode;
  label: string;
  account: string;
  date: string;
  deleted: number;
  onOpen: () => void;
}

function ReceiptRow({ mark, label, account, date, deleted, onOpen }: ReceiptRowProps) {
  const { t } = useTranslation();
  return (
    <tr className="row" onClick={onOpen}>
      <td className="cell-text">
        <button
          className="receipt-link"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          type="button"
        >
          {mark}
          <span>{label}</span>
          <span className="muted">{account}</span>
        </button>
      </td>
      <td className="cell-date">{date}</td>
      <td className="cell-count">{t("cleanup.plainNumber", { value: deleted })}</td>
    </tr>
  );
}

export function ReceiptsView() {
  const { t } = useTranslation();
  const format = useDateFormat();
  const openReceiptId = useFlowStore((s) => s.openReceiptId);
  const openReceipt = useFlowStore((s) => s.openReceipt);
  const receipts = useReceiptsQuery();
  const interrupted = useInterruptedRunsQuery();
  const rows = receipts.data ?? [];
  const interruptedRows = interrupted.data ?? [];
  const failure = receipts.error ?? interrupted.error;

  if (openReceiptId) {
    const exit = { label: t("receipts.back"), onClick: () => openReceipt(null) };
    const interruptedRun = interruptedRows.find((run) => run.run_id === openReceiptId);
    return interruptedRun ? (
      <InterruptedRunDetail exit={exit} key={openReceiptId} run={interruptedRun} />
    ) : (
      <ReceiptDetail exit={exit} key={openReceiptId} runId={openReceiptId} />
    );
  }

  return (
    <Screen fill heading={t("receipts.heading")}>
      {receipts.isSuccess && interrupted.isSuccess && rows.length + interruptedRows.length === 0 && (
        <p className="empty">{t("receipts.empty")}</p>
      )}
      {failure && <Notice tone="fault">{errorMessage(failure)}</Notice>}
      {rows.length + interruptedRows.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{t("receipts.account")}</th>
                <th className="cell-date">{t("receipts.date")}</th>
                <th className="cell-count">{t("receipts.deleted")}</th>
              </tr>
            </thead>
            <tbody>
              {interruptedRows.map((run) => (
                <ReceiptRow
                  date={format.day(run.started_epoch_secs)}
                  deleted={run.deleted}
                  key={run.run_id}
                  label={t("receipts.interrupted")}
                  account={run.account_label}
                  mark={<TriangleAlert aria-hidden="true" className="receipt-link__mark" size={20} />}
                  onOpen={() => openReceipt(run.run_id)}
                />
              ))}
              {rows.map(({ summary }, index) => (
                <ReceiptRow
                  account={summary.account_label}
                  date={format.day(summary.finished_epoch_secs)}
                  deleted={summary.deleted}
                  key={summary.run_id}
                  label={t("cleanup.number", { number: rows.length - index })}
                  mark={<Seal runId={summary.run_id} size={30} />}
                  onOpen={() => openReceipt(summary.run_id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Screen>
  );
}
