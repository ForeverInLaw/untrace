import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Checkbox, Notice, Screen } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useDateFormat } from "../lib/format";
import type { ContentType, PreviewItem, PreviewSummary } from "../lib/tauri";
import {
  useIsSavingProtection,
  usePreviewItemsQuery,
  usePreviewSummaryQuery,
  useSetItemProtectedMutation,
} from "../queries/runs";
import { useFlowStore } from "../stores/flowStore";

function useCount() {
  const { t } = useTranslation();
  return (value: number) => t("cleanup.plainNumber", { value });
}

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
          {protect.isError ? (
            <span className="hint hint--fault" role="alert">{t("preview.protectFailed")}</span>
          ) : item.protected ? (
            <span className="hint hint--stays">{t("preview.stay")}</span>
          ) : (
            <>
              {item.only_for_self && <span className="hint hint--reach">{t("preview.onlyForSelf")}</span>}
              <span className="hint hint--protect">{t("preview.protect")}</span>
            </>
          )}
        </div>
      </td>
      <td className="cell-meta">{t(`contentTypeOne.${item.content_type}`)}</td>
      <td className="cell-date">{item.created_at_secs === null ? "—" : format.day(item.created_at_secs)}</td>
    </tr>
  );
}

function ItemsTable({ runId, filter, undeletable }: { runId: string; filter: Filter; undeletable: number }) {
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
        <p className="empty">
          {t(filter.kind === "protected" ? "preview.emptyProtected" : undeletable > 0 ? "preview.emptyUndeletable" : "preview.empty")}
        </p>
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

/// Shown only when some of the set would not simply vanish for everyone.
function DeleteReachFacts({ summary }: { summary: PreviewSummary }) {
  const { t } = useTranslation();
  const count = useCount();
  const { pending, only_for_self: onlyForSelf, undeletable } = summary;
  if (onlyForSelf === 0 && undeletable === 0) {
    return null;
  }
  return (
    <section>
      <dl className="facts facts--compact">
        <div><dt>{t("preview.reachEveryone")}</dt><dd>{count(pending - onlyForSelf)}</dd></div>
        {onlyForSelf > 0 && <div><dt>{t("preview.onlyForSelf")}</dt><dd>{count(onlyForSelf)}</dd></div>}
        {undeletable > 0 && <div><dt>{t("preview.reachNowhere")}</dt><dd>{count(undeletable)}</dd></div>}
      </dl>
      {onlyForSelf > 0 && <p className="help">{t("preview.onlyForSelfNote")}</p>}
    </section>
  );
}

export function PreviewStep() {
  const { t } = useTranslation();
  const runId = useFlowStore((s) => s.runId) ?? "";
  const goTo = useFlowStore((s) => s.goTo);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const summaryQuery = usePreviewSummaryQuery(runId);
  const summary = summaryQuery.data;
  const saving = useIsSavingProtection(runId);
  const pending = summary?.pending ?? 0;
  const protectedCount = summary?.protected ?? 0;
  const count = useCount();

  return (
    <Screen
      actions={
        <>
          <Button onClick={() => goTo("scope")}>{t("preview.editScope")}</Button>
          <Button disabled={pending === 0 || saving} kind="primary" onClick={() => goTo("backup")}>
            {t("preview.next")}
          </Button>
        </>
      }
      fill
      heading={<Trans components={{ n: <em className="count" /> }} count={pending} i18nKey="preview.heading" />}
      lead={t("preview.stays", { protected: protectedCount })}
      note={t("preview.limit")}
    >
      {summaryQuery.isError && <Notice tone="fault">{errorMessage(summaryQuery.error)}</Notice>}
      {summary && <DeleteReachFacts summary={summary} />}
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
      <ItemsTable filter={filter} runId={runId} undeletable={summary?.undeletable ?? 0} />
    </Screen>
  );
}
