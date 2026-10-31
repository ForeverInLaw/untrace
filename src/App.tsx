import { type FormEvent, useState } from "react";
import {
  Archive,
  CheckCircle2,
  CircleDot,
  KeyRound,
  Pause,
  Play,
  Radar,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
} from "lucide-react";
import { RunProgress } from "./components/RunProgress";
import { TelegramScopePanel } from "./components/TelegramScopePanel";
import { type ContentType, type FilterRequest } from "./lib/tauri";
import {
  useConnectAccountMutation,
  useDryRunMutation,
  usePauseRunMutation,
  useResumeRunMutation,
  useStartRunMutation,
  useStopRunMutation,
  useVerifyBackupMutation,
} from "./queries/runs";
import { usePlatformsQuery } from "./queries/platforms";
import { useRunStore } from "./stores/runStore";

const initialPlatformId = "bluesky";
const fallbackContentTypes: ContentType[] = ["post", "reaction"];
const contentTypeLabels: Record<ContentType, string> = {
  post: "Posts",
  comment: "Comments",
  reaction: "Reactions",
  media: "Media",
  dm: "DMs",
};

function titleCase(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function errorMessage(error: unknown) {
  if (!error) {
    return null;
  }
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export default function App() {
  const status = useRunStore((s) => s.status);
  const message = useRunStore((s) => s.message);
  const deleted = useRunStore((s) => s.deleted);
  const total = useRunStore((s) => s.total);
  const protectedCount = useRunStore((s) => s.protected);
  const failed = useRunStore((s) => s.failed);
  const apply = useRunStore((s) => s.apply);
  const reset = useRunStore((s) => s.reset);

  const [identifier, setIdentifier] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupVerification, setBackupVerification] = useState<string | null>(null);
  const [selectedContentTypes, setSelectedContentTypes] = useState<ContentType[]>(fallbackContentTypes);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [keyword, setKeyword] = useState("");
  const [keywordRegex, setKeywordRegex] = useState(false);
  const [foldYoYe, setFoldYoYe] = useState(true);
  const [allowlistIds, setAllowlistIds] = useState("");
  const [selectedPlatformId, setSelectedPlatformId] = useState(initialPlatformId);

  const platforms = usePlatformsQuery();
  const connectAccount = useConnectAccountMutation();
  const dryRun = useDryRunMutation();
  const startRun = useStartRunMutation(apply);
  const verifyBackup = useVerifyBackupMutation();
  const pauseRun = usePauseRunMutation();
  const resumeRun = useResumeRunMutation();
  const stopRun = useStopRunMutation();

  const accountLabel = connectAccount.data ?? null;
  const runId = dryRun.data?.run_id ?? null;
  const pending = dryRun.data?.pending ?? total;
  const platformList = platforms.data ?? [];
  const activePlatform = platformList.find((service) => service.id === selectedPlatformId);
  const availableContentTypes = activePlatform?.content_types ?? fallbackContentTypes;
  const effectiveContentTypes = selectedContentTypes.filter((type) => availableContentTypes.includes(type));
  const selectedPlatformLive = activePlatform?.status === "live";
  const selectedPlatformName = activePlatform?.display_name ?? "Bluesky";
  const selectedPlatformIsTelegram = selectedPlatformId === "telegram";
  const canVerifyBackup = Boolean(runId) && status === "done";
  const canStart = Boolean(runId) && status !== "done" && pending > 0;
  const canDryRun = Boolean(accountLabel) && selectedPlatformLive && effectiveContentTypes.length > 0;
  const busy =
    connectAccount.isPending ||
    dryRun.isPending ||
    startRun.isPending ||
    verifyBackup.isPending ||
    pauseRun.isPending ||
    resumeRun.isPending ||
    stopRun.isPending;

  const mutationError =
    errorMessage(connectAccount.error) ??
    errorMessage(dryRun.error) ??
    errorMessage(startRun.error) ??
    errorMessage(verifyBackup.error) ??
    errorMessage(pauseRun.error) ??
    errorMessage(resumeRun.error) ??
    errorMessage(stopRun.error);

  const invalidatePreview = () => {
    dryRun.reset();
    startRun.reset();
    verifyBackup.reset();
    setBackupVerification(null);
    reset();
  };

  const setFilterValue = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    invalidatePreview();
  };

  const toggleContentType = (contentType: ContentType) => {
    const next = selectedContentTypes.includes(contentType)
      ? selectedContentTypes.filter((type) => type !== contentType)
      : [...selectedContentTypes, contentType];
    setFilterValue(setSelectedContentTypes, next);
  };

  const selectPlatform = (platformId: string) => {
    setSelectedPlatformId(platformId);
    connectAccount.reset();
    invalidatePreview();
  };

  const buildFilter = (): FilterRequest => ({
    content_types: effectiveContentTypes,
    date_from: dateFrom || null,
    date_to: dateTo || null,
    keyword: keyword.trim().length > 0 ? keyword.trim() : null,
    keyword_regex: keywordRegex,
    keyword_case_insensitive: true,
    fold_yo_ye: foldYoYe,
    allowlist_ids: allowlistIds
      .split(/[\n,]+/)
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  });

  const onConnect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    reset();
    connectAccount.reset();
    dryRun.reset();
    startRun.reset();
    verifyBackup.reset();
    setBackupVerification(null);
    await connectAccount.mutateAsync({ platform: selectedPlatformId, identifier, appPassword });
  };

  const onDryRun = async () => {
    if (!accountLabel || effectiveContentTypes.length === 0) {
      return;
    }
    reset();
    setBackupVerification(null);
    const result = await dryRun.mutateAsync({
      platform: selectedPlatformId,
      account_id: accountLabel,
      account_label: accountLabel,
      filter: buildFilter(),
    });
    apply({ event: "preview_ready", data: { pending: result.pending, protected: result.protected } });
  };

  const onStart = async () => {
    if (!runId) {
      return;
    }
    setBackupVerification(null);
    await startRun.mutateAsync({
      runId,
      backupPassphrase: backupPassphrase.length > 0 ? backupPassphrase : null,
    });
  };

  const onVerifyBackup = async () => {
    if (!runId) {
      return;
    }
    const result = await verifyBackup.mutateAsync({
      runId,
      backupPassphrase: backupPassphrase.length > 0 ? backupPassphrase : null,
    });
    setBackupVerification(result.ok ? `Verified archive, ${result.chunks} chunks` : "Backup failed");
  };

  return (
    <main className="shell">
      <aside className="service-rail" aria-label="Service adapters">
        <div className="brand-mark">
          <div className="brand-glyph" aria-hidden="true">
            <Radar size={22} />
          </div>
          <div>
            <h1>Untrace</h1>
            <p>Local deletion ledger</p>
          </div>
        </div>

        <div className="service-list">
          {platforms.isLoading && <p className="service-state">Loading adapters</p>}
          {platforms.isError && <p className="service-state service-state--error">Registry unavailable</p>}
          {platformList.map((service) => (
            <button
              className={`service-row ${service.id === selectedPlatformId ? "service-row--active" : ""}`}
              key={service.id}
              onClick={() => selectPlatform(service.id)}
              type="button"
            >
              <span className="service-dot" aria-hidden="true" />
              <span>
                <strong>{service.display_name}</strong>
                <small>{service.note}</small>
              </span>
              <em>{titleCase(service.status)}</em>
            </button>
          ))}
        </div>
      </aside>

      <section className="run-board" aria-label="Run console">
        <header className="board-header">
          <div>
            <p className="eyebrow">Adapter / active</p>
            <h2>{selectedPlatformName} footprint run</h2>
          </div>
          <span className={`run-chip run-chip--${status}`}>
            <CircleDot size={14} />
            {status}
          </span>
        </header>

        <form className="credential-panel" onSubmit={onConnect}>
          <label className="field">
            <span>Handle</span>
            <input
              autoComplete="username"
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="handle.bsky.social"
              type="text"
              value={identifier}
            />
          </label>
          <label className="field">
            <span>App password</span>
            <input
              autoComplete="current-password"
              onChange={(event) => setAppPassword(event.target.value)}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              type="password"
              value={appPassword}
            />
          </label>
          <button
            className="command command--primary"
            disabled={busy || !selectedPlatformLive || !identifier || !appPassword}
            type="submit"
          >
            <KeyRound size={16} />
            Connect
          </button>
        </form>

        {selectedPlatformIsTelegram && (
          <TelegramScopePanel active={selectedPlatformIsTelegram} filter={buildFilter()} />
        )}

        <section className="filter-panel" aria-label="Deletion filters">
          <div className="filter-row filter-row--types">
            <span className="filter-label">Content</span>
            <div className="segmented-options">
              {availableContentTypes.map((contentType) => (
                <label className="option-chip" key={contentType}>
                  <input
                    checked={selectedContentTypes.includes(contentType)}
                    onChange={() => toggleContentType(contentType)}
                    type="checkbox"
                  />
                  <span>{contentTypeLabels[contentType]}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="filter-grid">
            <label className="field">
              <span>From</span>
              <input
                onChange={(event) => setFilterValue(setDateFrom, event.target.value)}
                type="date"
                value={dateFrom}
              />
            </label>
            <label className="field">
              <span>To</span>
              <input
                onChange={(event) => setFilterValue(setDateTo, event.target.value)}
                type="date"
                value={dateTo}
              />
            </label>
            <label className="field field--wide">
              <span>Keyword</span>
              <input
                onChange={(event) => setFilterValue(setKeyword, event.target.value)}
                placeholder="literal or regex"
                type="text"
                value={keyword}
              />
            </label>
          </div>

          <div className="filter-row filter-row--toggles">
            <label className="toggle-line">
              <input
                checked={keywordRegex}
                onChange={(event) => setFilterValue(setKeywordRegex, event.target.checked)}
                type="checkbox"
              />
              <span>Regex</span>
            </label>
            <label className="toggle-line">
              <input
                checked={foldYoYe}
                onChange={(event) => setFilterValue(setFoldYoYe, event.target.checked)}
                type="checkbox"
              />
              <span>ё / е</span>
            </label>
          </div>

          <label className="field">
            <span>Protected ids</span>
            <textarea
              onChange={(event) => setFilterValue(setAllowlistIds, event.target.value)}
              placeholder="one platform id per line"
              value={allowlistIds}
            />
          </label>
        </section>

        <div className="run-actions">
          <button className="command" disabled={busy || !canDryRun} onClick={onDryRun} type="button">
            <Search size={16} />
            Dry run
          </button>
          <button className="command command--danger" disabled={busy || !canStart} onClick={onStart} type="button">
            <Play size={16} />
            Start
          </button>
          <button className="icon-command" disabled={busy || !runId} onClick={() => runId && pauseRun.mutate(runId)} title="Pause" type="button">
            <Pause size={16} />
          </button>
          <button className="icon-command" disabled={busy || !runId} onClick={() => runId && resumeRun.mutate(runId)} title="Resume" type="button">
            <RefreshCw size={16} />
          </button>
          <button className="icon-command" disabled={busy || !runId} onClick={() => runId && stopRun.mutate(runId)} title="Stop" type="button">
            <Square size={16} />
          </button>
        </div>

        <RunProgress />

        <div className="backup-strip">
          <label className="field field--inline">
            <span>Backup passphrase</span>
            <input
              autoComplete="new-password"
              onChange={(event) => setBackupPassphrase(event.target.value)}
              placeholder="optional wrapping key"
              type="password"
              value={backupPassphrase}
            />
          </label>
          <button className="command" disabled={busy || !canVerifyBackup} onClick={onVerifyBackup} type="button">
            <Archive size={16} />
            Verify backup
          </button>
        </div>
      </section>

      <aside className="ledger-panel" aria-label="Run ledger">
        <div className="ledger-block">
          <p className="eyebrow">Account</p>
          <strong>{accountLabel ?? "Not connected"}</strong>
        </div>
        <div className="ledger-grid">
          <div>
            <span>{pending}</span>
            <small>pending</small>
          </div>
          <div>
            <span>{protectedCount}</span>
            <small>protected</small>
          </div>
          <div>
            <span>{deleted}</span>
            <small>deleted</small>
          </div>
          <div>
            <span>{failed}</span>
            <small>failed</small>
          </div>
        </div>
        <div className="receipt-line">
          <ShieldCheck size={18} />
          <span>{runId ?? "Run id appears after dry run"}</span>
        </div>
        {backupVerification && (
          <div className="success-line">
            <CheckCircle2 size={18} />
            <span>{backupVerification}</span>
          </div>
        )}
        {(mutationError || status === "error") && (
          <div className="error-line">
            <span>{mutationError ?? message}</span>
          </div>
        )}
      </aside>
    </main>
  );
}
