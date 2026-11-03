import { useTranslation } from "react-i18next";
import { useRunScopeResultsQuery } from "../queries/runs";
import { useChatTitle } from "../queries/telegram";

/// `goes` marks a count of what will be deleted, `fault` one of what failed.
type CellTone = "goes" | "fault";

const TONE_CLASS: Record<CellTone, string> = {
  goes: "cell-count cell-count--selected",
  fault: "cell-count fact-fault",
};

interface ChatCell {
  value: number;
  tone?: CellTone;
}

interface ChatCountsProps {
  heading: string;
  /// Names of the columns after the chat's, one per cell of each row.
  columns: string[];
  rows: { chatId: string; cells: ChatCell[] }[];
}

/// Chats with a count or two each. Renders nothing without rows, as for a platform
/// that has no chats.
export function ChatCounts({ heading, columns, rows }: ChatCountsProps) {
  const { t } = useTranslation();
  const title = useChatTitle(rows.length > 0);
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="chat-counts">
      <h2 className="section-heading">{heading}</h2>
      <div className="table-scroll chat-counts__rows">
        <table className="table">
          <thead>
            <tr>
              <th>{t("chats.chat")}</th>
              {columns.map((column) => (
                <th className="cell-count" key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ chatId, cells }) => (
              <tr key={chatId}>
                <td className="cell-text">{title(chatId)}</td>
                {cells.map(({ value, tone }, index) => (
                  <td className={tone ? TONE_CLASS[tone] : "cell-count"} key={columns[index]}>
                    {t("cleanup.plainNumber", { value })}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/// What a run deleted and failed to delete in each chat, once it has ended. Known
/// only until the app closes, so an older run shows nothing here.
export function RunChatResults({ runId, ended }: { runId: string; ended: boolean }) {
  const { t } = useTranslation();
  const chats = useRunScopeResultsQuery(runId, ended).data ?? [];
  return (
    <ChatCounts
      columns={[t("receipt.deleted"), t("receipt.failed")]}
      heading={t("receipt.chats")}
      rows={chats.map(({ scope_id: chatId, deleted, failed }) => ({
        chatId,
        cells: [{ value: deleted }, { value: failed, tone: failed > 0 ? "fault" : undefined }],
      }))}
    />
  );
}
