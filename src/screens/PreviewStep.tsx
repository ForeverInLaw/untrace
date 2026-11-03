import { useState, type ReactNode } from "react";
import { Search, ShieldCheck } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { useDebounce } from "use-debounce";
import { MoreRows } from "../components/MoreRows";
import { Button, Checkbox, Notice, Screen } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useByteFormat, useDateFormat } from "../lib/format";
import { useItemText } from "../lib/itemText";
import type { ContentType, ItemGroup, PreviewItem, PreviewSummary } from "../lib/tauri";
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

type Filter = { group: ItemGroup; type: ContentType | null };

const ALL: Filter = { group: "all", type: null };

/// Text, type with file size and date of a row, with an optional hint laid over the text's end.
function ItemCells({ item, hint }: { item: PreviewItem; hint?: ReactNode }) {
  const { t } = useTranslation();
  const format = useDateFormat();
  const formatBytes = useByteFormat();
  const itemText = useItemText();
  const type = t(`contentTypeOne.${item.content_type}`);
  return (
    <>
      <td title={itemText(item)}>
        <div className="cell-line">
          <span className="cell-line__text">{itemText(item)}</span>
          {hint}
        </div>
      </td>
      <td className="cell-meta">
        {item.file_size === null ? type : t("preview.typeWithSize", { type, size: formatBytes(item.file_size) })}
      </td>
      <td className="cell-date">{item.created_at_secs === null ? "—" : format.day(item.created_at_secs)}</td>
    </>
  );
}

function ItemRow({ item, runId }: { item: PreviewItem; runId: string }) {
  const { t } = useTranslation();
  const protect = useSetItemProtectedMutation(runId);
  const isProtected = item.state === "protected";
  const toggle = () => protect.mutate({ platformId: item.platform_id, isProtected: !isProtected });

  return (
    <tr className={isProtected ? "row row--stays" : "row"} onClick={toggle}>
      <td className="cell-check">
        <Checkbox
          aria-label={t("preview.toggleRow")}
          checked={!isProtected}
          onChange={toggle}
          onClick={(event) => event.stopPropagation()}
        />
      </td>
      <ItemCells
        hint={
          protect.isError ? (
            <span className="hint hint--fault" role="alert">{t("preview.protectFailed")}</span>
          ) : isProtected ? (
            <span className="hint hint--stays">{t("preview.stay")}</span>
          ) : (
            <>
              {item.only_for_self && <span className="hint hint--reach">{t("preview.onlyForSelf")}</span>}
              <span className="hint hint--protect">{t("preview.protect")}</span>
            </>
          )
        }
        item={item}
      />
    </tr>
  );
}

/// A row the platform does not let this account delete: listed, never selectable.
function OutOfReachRow({ item }: { item: PreviewItem }) {
  return (
    <tr className="row row--disabled">
      <td className="cell-check" />
      <ItemCells item={item} />
    </tr>
  );
}

interface ItemsTableProps {
  runId: string;
  filter: Filter;
  /// Trimmed text the rows must contain; blank lists them all.
  search: string;
  undeletable: number;
}

function ItemsTable({ runId, filter, search, undeletable }: ItemsTableProps) {
  const { t } = useTranslation();
  const items = usePreviewItemsQuery(runId, filter.group, filter.type, search);
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
          {rows.map((item) =>
            item.state === "undeletable" ? (
              <OutOfReachRow item={item} key={item.platform_id} />
            ) : (
              <ItemRow item={item} key={item.platform_id} runId={runId} />
            ),
          )}
        </tbody>
      </table>
      {items.isSuccess && !items.isPlaceholderData && rows.length === 0 && (
        <p className="empty">
          {search
            ? t("preview.notFound", { search })
            : t(
                filter.group === "protected"
                  ? "preview.emptyProtected"
                  : undeletable > 0 && filter.group === "all" && filter.type === null
                    ? "preview.emptyUndeletable"
                    : "preview.empty",
              )}
        </p>
      )}
      {items.isError && <Notice tone="fault">{errorMessage(items.error)}</Notice>}
      <MoreRows query={items} />
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

function Chip({
  filter,
  selected,
  onSelect,
  className = "chip",
  children,
}: {
  filter: Filter;
  selected: Filter;
  onSelect: (filter: Filter) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      aria-pressed={filter.group === selected.group && filter.type === selected.type}
      className={className}
      onClick={() => onSelect(filter)}
      type="button"
    >
      {children}
    </button>
  );
}

export function PreviewStep() {
  const { t } = useTranslation();
  const runId = useFlowStore((s) => s.runId) ?? "";
  const goTo = useFlowStore((s) => s.goTo);
  const [filter, setFilter] = useState<Filter>(ALL);
  const [search, setSearch] = useState("");
  // Each search scans the run in the store and cannot be called off, so it waits
  // for a pause in typing.
  const [searched] = useDebounce(search.trim(), 300);
  const summaryQuery = usePreviewSummaryQuery(runId);
  const summary = summaryQuery.data;
  const saving = useIsSavingProtection(runId);
  const pending = summary?.pending ?? 0;
  const protectedCount = summary?.protected ?? 0;
  const onlyForSelf = summary?.only_for_self ?? 0;
  const undeletable = summary?.undeletable ?? 0;
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
      <label className="search">
        <Search aria-hidden="true" size={15} />
        <input
          aria-label={t("preview.search")}
          className="input search__input"
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("preview.search")}
          type="search"
          value={search}
        />
      </label>
      <fieldset aria-label={t("preview.filterLabel")} className="chips">
        <Chip filter={ALL} onSelect={setFilter} selected={filter}>
          {t("preview.all")} <span>{count(pending)}</span>
        </Chip>
        {summary?.types.map(({ content_type: type, count: value }) => (
          <Chip filter={{ group: "all", type }} key={type} onSelect={setFilter} selected={filter}>
            {t(`contentType.${type}`)} <span>{count(value)}</span>
          </Chip>
        ))}
        {/* Kept while selected: protecting the last of them would otherwise hide it. */}
        {(onlyForSelf > 0 || filter.group === "only_for_self") && (
          <Chip filter={{ group: "only_for_self", type: null }} onSelect={setFilter} selected={filter}>
            {t("preview.onlyForSelf")} <span>{count(onlyForSelf)}</span>
          </Chip>
        )}
        <Chip
          className="chip chip--protected"
          filter={{ group: "protected", type: null }}
          onSelect={setFilter}
          selected={filter}
        >
          <ShieldCheck aria-hidden="true" size={15} />
          {t("preview.protected")} <span>{count(protectedCount)}</span>
        </Chip>
        {undeletable > 0 && (
          <Chip filter={{ group: "undeletable", type: null }} onSelect={setFilter} selected={filter}>
            {t("preview.reachNowhere")} <span>{count(undeletable)}</span>
          </Chip>
        )}
      </fieldset>
      <ItemsTable filter={filter} runId={runId} search={searched} undeletable={undeletable} />
    </Screen>
  );
}
