import { type FormEvent, useState } from "react";
import { KeyRound, LockKeyhole, MessageCircle, OctagonAlert, Phone, RefreshCw, Send, Users } from "lucide-react";
import {
  useTelegramAuthCodeMutation,
  useTelegramAuthPasswordMutation,
  useTelegramAuthStartMutation,
  useTelegramDryRunChatsMutation,
  useTelegramOwnMessageCountsQuery,
  useTelegramScopeStatusQuery,
} from "../queries/telegram";
import { TelegramRunControls } from "./TelegramRunControls";
import { type FilterRequest } from "../lib/tauri";

interface TelegramScopePanelProps {
  active: boolean;
  filter: FilterRequest;
}

const scopeIcons = {
  private_chat: MessageCircle,
  group: Users,
  channel: OctagonAlert,
  secret: LockKeyhole,
};

export function TelegramScopePanel({ active, filter }: TelegramScopePanelProps) {
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [onlyOwnChats, setOnlyOwnChats] = useState(true);
  const scopeStatus = useTelegramScopeStatusQuery(active);
  const authStart = useTelegramAuthStartMutation();
  const authCode = useTelegramAuthCodeMutation();
  const authPassword = useTelegramAuthPasswordMutation();
  const dryRunChats = useTelegramDryRunChatsMutation();
  const rules = scopeStatus.data?.rules ?? [];
  const chats = scopeStatus.data?.chats ?? [];
  const ownCounts = useTelegramOwnMessageCountsQuery(chats);
  const counts = ownCounts.data ?? {};
  const visibleChats = onlyOwnChats ? chats.filter((chat) => chat.id in counts && counts[chat.id] !== 0) : chats;
  const selectedMessages = selectedChatIds.reduce((sum, id) => sum + (counts[id] ?? 0), 0);
  const auth = scopeStatus.data?.auth;
  const busy =
    authStart.isPending ||
    authCode.isPending ||
    authPassword.isPending ||
    dryRunChats.isPending ||
    scopeStatus.isFetching;
  const canStart = apiId.trim().length > 0 && apiHash.trim().length > 0 && phoneNumber.trim().length > 0;
  const showCode = auth?.phase === "wait_code";
  const showPassword = auth?.phase === "wait_password";
  const blocker = scopeStatus.data?.blocker || auth?.message;
  const dryRun = dryRunChats.data;
  const canDryRunChats = selectedChatIds.length > 0 && filter.content_types.length > 0;

  const onStart = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await authStart.mutateAsync({
      api_id: Number(apiId),
      api_hash: apiHash.trim(),
      phone_number: phoneNumber.trim(),
    });
  };

  const onCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await authCode.mutateAsync({ code: code.trim() });
    setCode("");
  };

  const onPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await authPassword.mutateAsync({ password });
    setPassword("");
  };

  const toggleChat = (chatId: string) => {
    dryRunChats.reset();
    setSelectedChatIds((current) =>
      current.includes(chatId) ? current.filter((id) => id !== chatId) : [...current, chatId],
    );
  };

  const onDryRunChats = async () => {
    await dryRunChats.mutateAsync({ chat_ids: selectedChatIds, filter });
  };

  return (
    <section className="telegram-scope" aria-label="Telegram chat cleanup scope">
      <div className="telegram-scope__header">
        <div>
          <p className="eyebrow">Telegram / chat scope</p>
          <h3>Chat cleanup map</h3>
        </div>
        <span className={`telegram-scope__state telegram-scope__state--${auth?.phase ?? "idle"}`}>
          {scopeStatus.data?.available ? "Ready" : auth?.phase ?? "Idle"}
        </span>
      </div>

      {blocker && (
        <div className="telegram-scope__blocker">
          <OctagonAlert size={18} />
          <span>{blocker}</span>
        </div>
      )}

      {auth?.confirmation_link && (
        <a className="telegram-scope__link" href={auth.confirmation_link}>
          {auth.confirmation_link}
        </a>
      )}

      <form className="telegram-auth-grid" onSubmit={onStart}>
        <label className="field">
          <span>API ID</span>
          <input
            inputMode="numeric"
            onChange={(event) => setApiId(event.target.value)}
            placeholder="123456"
            type="text"
            value={apiId}
          />
        </label>
        <label className="field">
          <span>API hash</span>
          <input
            autoComplete="off"
            onChange={(event) => setApiHash(event.target.value)}
            placeholder="Telegram developer hash"
            type="password"
            value={apiHash}
          />
        </label>
        <label className="field">
          <span>Phone</span>
          <input
            autoComplete="tel"
            onChange={(event) => setPhoneNumber(event.target.value)}
            placeholder="+15551234567"
            type="tel"
            value={phoneNumber}
          />
        </label>
        <button className="command command--primary" disabled={busy || !canStart} type="submit">
          <Phone size={16} />
          Connect
        </button>
      </form>

      {showCode && (
        <form className="telegram-step" onSubmit={onCode}>
          <label className="field">
            <span>Code</span>
            <input
              autoComplete="one-time-code"
              onChange={(event) => setCode(event.target.value)}
              placeholder="12345"
              type="text"
              value={code}
            />
          </label>
          <button className="command" disabled={busy || code.trim().length === 0} type="submit">
            <Send size={16} />
            Verify
          </button>
        </form>
      )}

      {showPassword && (
        <form className="telegram-step" onSubmit={onPassword}>
          <label className="field">
            <span>2FA password</span>
            <input
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Telegram password"
              type="password"
              value={password}
            />
          </label>
          <button className="command" disabled={busy || password.length === 0} type="submit">
            <KeyRound size={16} />
            Unlock
          </button>
        </form>
      )}

      {chats.length > 0 && (
        <>
          <div className="telegram-chat-filter">
            <label>
              <input
                checked={onlyOwnChats}
                onChange={(event) => setOnlyOwnChats(event.target.checked)}
                type="checkbox"
              />
              Only chats with my messages
            </label>
            <span aria-live="polite">
              {ownCounts.isFetching
                ? `Checked ${Object.keys(counts).length} of ${chats.length}`
                : `${visibleChats.length} of ${chats.length} chats`}
            </span>
            <button
              aria-label="Check chats again"
              className="icon-command"
              disabled={ownCounts.isFetching}
              onClick={() => ownCounts.refetch()}
              type="button"
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="telegram-chat-list" aria-label="Telegram chats">
            {visibleChats.map((chat) => {
              const Icon = scopeIcons[chat.kind];
              const count = counts[chat.id];
              return (
                <article className="telegram-chat" key={chat.id}>
                  <input
                    checked={selectedChatIds.includes(chat.id)}
                    onChange={() => toggleChat(chat.id)}
                    type="checkbox"
                  />
                  <Icon size={16} />
                  <strong>{chat.title || chat.id}</strong>
                  <span>{typeof count === "number" ? `${count} mine · ${chat.cleanability}` : chat.cleanability}</span>
                </article>
              );
            })}
            {visibleChats.length === 0 && !ownCounts.isFetching && (
              <p className="telegram-chat-list__empty">No chats with your messages</p>
            )}
          </div>
          <button
            className="command command--primary"
            disabled={busy || !canDryRunChats}
            onClick={onDryRunChats}
            type="button"
          >
            <Send size={16} />
            Create dry run
          </button>
          {selectedChatIds.length > 0 && !dryRun && (
            <div className="telegram-preview">
              <strong>{selectedMessages}</strong>
              <span>your messages in {selectedChatIds.length} selected chats</span>
            </div>
          )}
          {dryRun && (
            <>
              <div className="telegram-preview">
                <strong>{dryRun.pending}</strong>
                <span>
                  pending, {dryRun.protected} protected, run {dryRun.run_id}
                </span>
              </div>
              <TelegramRunControls runId={dryRun.run_id} pending={dryRun.pending} />
            </>
          )}
        </>
      )}

      {!scopeStatus.data?.available && chats.length === 0 && (
        <div className="telegram-scope__empty">
        <OctagonAlert size={18} />
          <span>{auth?.account_label ?? "Telegram account not ready"}</span>
        </div>
      )}

      <div className="telegram-scope__rules">
        {rules.map((rule) => {
          const Icon = scopeIcons[rule.kind];
          return (
            <article className="telegram-rule" key={rule.kind}>
              <Icon size={18} />
              <div>
                <strong>{rule.label}</strong>
                <p>{rule.cleanability}</p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
