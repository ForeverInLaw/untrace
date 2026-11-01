import { useTranslation } from "react-i18next";
import { Seal } from "../components/Seal";
import { Notice, Screen } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useDateFormat } from "../lib/format";
import { useReceiptsQuery } from "../queries/runs";
import { useFlowStore } from "../stores/flowStore";
import { ReceiptDetail } from "./ReceiptDetail";

export function ReceiptsView() {
  const { t } = useTranslation();
  const format = useDateFormat();
  const openReceiptId = useFlowStore((s) => s.openReceiptId);
  const openReceipt = useFlowStore((s) => s.openReceipt);
  const receipts = useReceiptsQuery();
  const rows = receipts.data ?? [];

  if (openReceiptId) {
    return (
      <ReceiptDetail
        exit={{ label: t("receipts.back"), onClick: () => openReceipt(null) }}
        key={openReceiptId}
        runId={openReceiptId}
      />
    );
  }

  return (
    <Screen fill heading={t("receipts.heading")}>
      {receipts.isSuccess && rows.length === 0 && <p className="empty">{t("receipts.empty")}</p>}
      {receipts.isError && <Notice tone="fault">{errorMessage(receipts.error)}</Notice>}
      {rows.length > 0 && (
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
              {rows.map(({ summary }, index) => (
                <tr className="row" key={summary.run_id} onClick={() => openReceipt(summary.run_id)}>
                  <td className="cell-text">
                    <button
                      className="receipt-link"
                      onClick={(event) => {
                        event.stopPropagation();
                        openReceipt(summary.run_id);
                      }}
                      type="button"
                    >
                      <Seal runId={summary.run_id} size={30} />
                      <span>{t("cleanup.number", { number: rows.length - index })}</span>
                      <span className="muted">{summary.account_label}</span>
                    </button>
                  </td>
                  <td className="cell-date">{format.day(summary.finished_epoch_secs)}</td>
                  <td className="cell-count">{t("cleanup.plainNumber", { value: summary.deleted })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Screen>
  );
}
