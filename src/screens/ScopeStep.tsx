import { ChevronRight, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, CheckboxLabel, Notice, Screen, Switch, TextAreaField, TextField } from "../components/ui";
import { errorMessage } from "../lib/errors";
import type { ContentType, DryRunResult, TelegramChatSummary } from "../lib/tauri";
import { usePlatformsQuery } from "../queries/platforms";
import { useDryRunMutation } from "../queries/runs";
import {
  useTelegramDryRunChatsMutation,
  useTelegramOwnMessageCountsQuery,
  useTelegramScopeStatusQuery,
} from "../queries/telegram";
import { effectiveContentTypes, toFilterRequest, useFlowStore } from "../stores/flowStore";
import { useRunStore } from "../stores/runStore";

function useAvailableTypes(): ContentType[] {
  const platformId = useFlowStore((s) => s.platformId);
  return usePlatformsQuery().data?.find((platform) => platform.id === platformId)?.content_types ?? [];
}

/// Records a finished dry run in both stores and moves on to the review step.
function usePreviewReady() {
  const previewed = useFlowStore((s) => s.previewed);
  const apply = useRunStore((s) => s.apply);
  const reset = useRunStore((s) => s.reset);
  return (result: DryRunResult) => {
    reset();
    apply({ event: "preview_ready", data: { pending: result.pending, protected: result.protected } });
    previewed(result.run_id);
  };
}

function ConditionRows({ withProtect }: { withProtect: boolean }) {
  const { t } = useTranslation();
  const draft = useFlowStore((s) => s.draft);
  const editDraft = useFlowStore((s) => s.editDraft);
  const available = useAvailableTypes();
  const selected = effectiveContentTypes(draft, available);

  const toggleType = (type: ContentType) => {
    editDraft({
      contentTypes: selected.includes(type) ? selected.filter((item) => item !== type) : [...selected, type],
    });
  };

  return (
    <div className="conditions">
      <div className="condition">
        <span className="condition__label">{t("scope.types")}</span>
        <div className="condition__row">
          {available.map((type) => (
            <CheckboxLabel checked={selected.includes(type)} key={type} onChange={() => toggleType(type)}>
              {t(`contentType.${type}`)}
            </CheckboxLabel>
          ))}
        </div>
      </div>
      <div className="condition">
        <span className="condition__label">{t("scope.period")}</span>
        <div className="condition__row">
          <TextField
            className="field--date"
            label={t("scope.from")}
            onChange={(event) => editDraft({ dateFrom: event.target.value })}
            type="date"
            value={draft.dateFrom}
          />
          <TextField
            className="field--date"
            label={t("scope.to")}
            onChange={(event) => editDraft({ dateTo: event.target.value })}
            type="date"
            value={draft.dateTo}
          />
        </div>
      </div>
      <div className="condition">
        <span className="condition__label">{t("scope.keyword")}</span>
        <div className="condition__stack">
          <input
            aria-label={t("scope.keyword")}
            className="input"
            onChange={(event) => editDraft({ keyword: event.target.value })}
            placeholder={t("scope.keywordPlaceholder")}
            value={draft.keyword}
          />
          <div className="condition__row">
            <Switch checked={draft.keywordRegex} onChange={(event) => editDraft({ keywordRegex: event.target.checked })}>
              {t("scope.regex")}
            </Switch>
            <Switch checked={draft.foldYoYe} onChange={(event) => editDraft({ foldYoYe: event.target.checked })}>
              {t("scope.foldYoYe")}
            </Switch>
          </div>
        </div>
      </div>
      {withProtect && (
        <div className="condition">
          <span className="condition__label">{t("scope.protect")}</span>
          <div className="condition__stack">
            <TextAreaField
              label={t("scope.protect")}
              onChange={(event) => editDraft({ allowlistIds: event.target.value })}
              placeholder={t("scope.protectPlaceholder")}
              value={draft.allowlistIds}
            />
            <p className="muted">{t("scope.protectHelp")}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function BlueskyScope() {
  const { t } = useTranslation();
  const account = useFlowStore((s) => s.account) ?? "";
  const draft = useFlowStore((s) => s.draft);
  const available = useAvailableTypes();
  const dryRun = useDryRunMutation();
  const onReady = usePreviewReady();
  const filter = toFilterRequest(draft, available);
  const error = errorMessage(dryRun.error);

  const onCheck = async () => {
    onReady(
      await dryRun.mutateAsync({ platform: "bluesky", account_id: account, account_label: account, filter }),
    );
  };

  return (
    <Screen
      actions={
        <Button
          disabled={dryRun.isPending || filter.content_types.length === 0}
          kind="primary"
          onClick={onCheck}
        >
          {dryRun.isPending ? t("scope.checking") : t("scope.check")}
        </Button>
      }
      heading={t("scope.heading", { account })}
      note={t("scope.note")}
    >
      <ConditionRows withProtect />
      {error && <Notice tone="fault">{error}</Notice>}
    </Screen>
  );
}

function ChatRow({ chat, count }: { chat: TelegramChatSummary; count: number | null | undefined }) {
  const { t } = useTranslation();
  const selected = useFlowStore((s) => s.chatIds.includes(chat.id));
  const toggleChat = useFlowStore((s) => s.toggleChat);
  // TDLib cannot search secret chats, so a dry run over one would fail.
  const unsupported = chat.kind === "secret";

  return (
    <tr className={unsupported ? "row row--disabled" : "row"} onClick={() => !unsupported && toggleChat(chat.id)}>
      <td className="cell-check">
        <Checkbox
          aria-label={chat.title || chat.id}
          checked={selected}
          disabled={unsupported}
          onChange={() => toggleChat(chat.id)}
          onClick={(event) => event.stopPropagation()}
        />
      </td>
      <td className="cell-text">{chat.title || chat.id}</td>
      <td className="cell-meta">{t(`chats.kind.${chat.kind}`)}</td>
      {typeof count === "number" ? (
        <td className={`cell-count ${selected ? "cell-count--selected" : ""}`}>
          {t("cleanup.plainNumber", { value: count })}
        </td>
      ) : (
        <td className="cell-count cell-count--unknown">{t(unsupported ? "chats.unsupported" : "chats.unknown")}</td>
      )}
    </tr>
  );
}

function TelegramScope() {
  const { t } = useTranslation();
  const chatIds = useFlowStore((s) => s.chatIds);
  const draft = useFlowStore((s) => s.draft);
  const available = useAvailableTypes();
  const status = useTelegramScopeStatusQuery(true);
  const chats = status.data?.chats ?? [];
  const ownCounts = useTelegramOwnMessageCountsQuery(chats);
  const dryRun = useTelegramDryRunChatsMutation();
  const onReady = usePreviewReady();
  const counts = ownCounts.data ?? {};
  const visible = chats.filter((chat) => chat.id in counts && counts[chat.id] !== 0);
  const knownCounts = chatIds.map((id) => counts[id]).filter((count) => typeof count === "number");
  const messages = knownCounts.reduce((sum, count) => sum + count, 0);
  const filter = toFilterRequest(draft, available);
  const error = errorMessage(dryRun.error ?? status.error) ?? (status.data?.blocker || null);
  const selectionNote = knownCounts.length === chatIds.length
    ? t("chats.selected", { chats: chatIds.length, messages })
    : t("chats.selectedUnknown", { chats: chatIds.length });

  const onCheck = async () => {
    onReady(await dryRun.mutateAsync({ chat_ids: chatIds, filter }));
  };

  return (
    <Screen
      actions={
        <Button
          disabled={dryRun.isPending || chatIds.length === 0 || filter.content_types.length === 0}
          kind="primary"
          onClick={onCheck}
        >
          {dryRun.isPending ? t("scope.checking") : t("scope.check")}
        </Button>
      }
      fill
      heading={t("chats.heading")}
      note={chatIds.length > 0 ? selectionNote : t("chats.noneSelected")}
    >
      <div className="chats-status">
        <p className="screen__lead">
          {!status.isError && (status.isPending
            ? t("chats.loading")
            : ownCounts.isFetching
              ? t("chats.progress", { checked: Object.keys(counts).length, total: chats.length })
              : t("chats.done", { visible: visible.length, total: chats.length }))}
        </p>
        <button
          aria-label={t("chats.recheck")}
          className="icon-button"
          disabled={status.isFetching || ownCounts.isFetching}
          onClick={() => (status.isError ? status.refetch() : ownCounts.refetch())}
          title={t("chats.recheck")}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={16} />
        </button>
      </div>
      <details className="disclosure">
        <summary>
          <ChevronRight aria-hidden="true" className="disclosure__icon" size={16} />
          {t("scope.moreConditions")}
        </summary>
        <ConditionRows withProtect={false} />
      </details>
      {error && <Notice tone="fault">{error}</Notice>}
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th aria-label={t("chats.select")} className="cell-check" />
              <th>{t("chats.chat")}</th>
              <th className="cell-meta">{t("chats.kind")}</th>
              <th className="cell-count">{t("chats.mine")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((chat) => (
              <ChatRow chat={chat} count={counts[chat.id]} key={chat.id} />
            ))}
          </tbody>
        </table>
        {!ownCounts.isFetching && status.isSuccess && visible.length === 0 && (
          <p className="empty">{t("chats.empty")}</p>
        )}
      </div>
    </Screen>
  );
}

export function ScopeStep() {
  const platformId = useFlowStore((s) => s.platformId);
  return platformId === "telegram" ? <TelegramScope /> : <BlueskyScope />;
}
