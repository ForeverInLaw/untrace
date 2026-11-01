import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { MediaBackupWarning } from "../components/MediaBackupWarning";
import { Button, Checkbox, Notice, Screen } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useDateFormat } from "../lib/format";
import type { ContentType, PreviewItem } from "../lib/tauri";
import {
  usePreviewItemsQuery,
  usePreviewSummaryQuery,
  useSetItemProtectedMutation,
} from "../queries/runs";
import { useFlowStore } from "../stores/flowStore";

type Filter = { kind: "all" } | { kind: "type"; type: ContentType } | { kind: "protected" };

function ItemRow({ item, runId }: { item: PreviewItem; runId: string }) {
  const { t } = useTranslation();
  const format = useDateFormat();
  const protect = useSetItemProtectedMutation(runId);
  const toggle = () => protect.mutate({ platformId: item.platform_id, isProtected: !item.protected });

  return (
    <tr className={item.protected ? "row row--stays" : "row"} onClick={toggle}>
      <td className="cell-check">
        <Checkbox
          aria-label={t("preview.toggleRow")}
          checked={!item.protected}
          onChange={toggle}
          onClick={(event) => event.stopPropagation()}
        />
      </td>
      <td title={item.text ?? undefined}>
        <div className="cell-line">
          <span className="cell-line__text">{item.text ?? t("preview.noText")}</span>
          {item.protected ? (
            <span className="hint hint--stays">{t("preview.stay")}</span>
          ) : (
            <span className="hint hint--protect">{t("preview.protect")}</span>
          )}
        </div>
      </td>
      <td className="cell-meta">{t(`contentTypeOne.${item.content_type}`)}</td>
      <td className="cell-date">{item.created_at_secs === null ? "—" : format.day(item.created_at_secs)}</td>
    </tr>
  );
}

function ItemsTable({ runId, filter }: { runId: string; filter: Filter }) {
  const { t } = useTranslation();
  const items = usePreviewItemsQuery(
    runId,
    filter.kind === "protected",
    filter.kind === "type" ? filter.type : null,
  );
  const rows = items.data?.pages.flat() ?? [];

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th aria-label={t("preview.toggleRow")} className="cell-check" />
            <th>{t("preview.text")}</th>
            <th className="cell-meta">{t("preview.type")}</th>
            <th className="cell-date">{t("preview.date")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <ItemRow item={item} key={item.platform_id} runId={runId} />
          ))}
        </tbody>
      </table>
      {items.isSuccess && rows.length === 0 && (
        <p className="empty">{t(filter.kind === "protected" ? "preview.emptyProtected" : "preview.empty")}</p>
      )}
      {items.isError && <Notice tone="fault">{errorMessage(items.error)}</Notice>}
      {items.hasNextPage && (
        <div className="table-more">
          <Button disabled={items.isFetchingNextPage} onClick={() => items.fetchNextPage()}>
            {t("preview.more")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function PreviewStep() {
  const { t } = useTranslation();
  const runId = useFlowStore((s) => s.runId) ?? "";
  const goTo = useFlowStore((s) => s.goTo);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const summary = usePreviewSummaryQuery(runId).data;
  const pending = summary?.pending ?? 0;
  const protectedCount = summary?.protected ?? 0;
  const count = (value: number) => t("cleanup.plainNumber", { value });

  return (
    <Screen
      actions={
        <>
          <Button onClick={() => goTo("scope")}>{t("preview.editScope")}</Button>
          <Button disabled={pending === 0} kind="primary" onClick={() => goTo("backup")}>
            {t("preview.next")}
          </Button>
        </>
      }
      fill
      heading={<Trans components={{ n: <em className="count" /> }} count={pending} i18nKey="preview.heading" />}
      lead={t("preview.stays", { protected: protectedCount })}
      note={t("preview.limit")}
    >
      <MediaBackupWarning />
      <fieldset aria-label={t("preview.filterLabel")} className="chips">
        <button aria-pressed={filter.kind === "all"} className="chip" onClick={() => setFilter({ kind: "all" })} type="button">
          {t("preview.all")} <span>{count(pending)}</span>
        </button>
        {summary?.types.map(({ content_type: type, count: value }) => (
          <button
            aria-pressed={filter.kind === "type" && filter.type === type}
            className="chip"
            key={type}
            onClick={() => setFilter({ kind: "type", type })}
            type="button"
          >
            {t(`contentType.${type}`)} <span>{count(value)}</span>
          </button>
        ))}
        <button
          aria-pressed={filter.kind === "protected"}
          className="chip chip--protected"
          onClick={() => setFilter({ kind: "protected" })}
          type="button"
        >
          <ShieldCheck aria-hidden="true" size={15} />
          {t("preview.protected")} <span>{count(protectedCount)}</span>
        </button>
      </fieldset>
      <ItemsTable filter={filter} runId={runId} />
    </Screen>
  );
}
