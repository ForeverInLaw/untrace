import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, ConfirmButton, Notice, Screen, TextField } from "../components/ui";
import { errorMessage } from "../lib/errors";
import type { TelegramAuthStatus } from "../lib/tauri";
import { usePlatformsQuery } from "../queries/platforms";
import { useAccountsQuery, useConnectAccountMutation, useDisconnectAccountMutation } from "../queries/runs";
import {
  useTelegramAuthCodeMutation,
  useTelegramAuthPasswordMutation,
  useTelegramAuthStartMutation,
  useTelegramAuthStatusQuery,
  useTelegramScopeStatusQuery,
} from "../queries/telegram";
import { useFlowStore } from "../stores/flowStore";

const CONNECT_FORM = "connect-form";

function PlatformChoice() {
  const { t } = useTranslation();
  const platformId = useFlowStore((s) => s.platformId);
  const selectPlatform = useFlowStore((s) => s.selectPlatform);
  const platforms = (usePlatformsQuery().data ?? []).filter((platform) => platform.status === "live");
  const hints: Record<string, string> = {
    bluesky: t("account.bluesky.hint"),
    telegram: t("account.telegram.hint"),
  };

  return (
    <fieldset aria-label={t("account.heading")} className="platforms">
      {platforms.map((platform) => (
        <label className="platform" key={platform.id}>
          <input
            checked={platform.id === platformId}
            className="radio"
            name="platform"
            onChange={() => selectPlatform(platform.id)}
            type="radio"
          />
          <span>
            <strong>{platform.display_name}</strong>
            <small>{hints[platform.id]}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function BlueskyConnect() {
  const { t } = useTranslation();
  const chooseAccount = useFlowStore((s) => s.chooseAccount);
  const [identifier, setIdentifier] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const connect = useConnectAccountMutation();
  const saved = (useAccountsQuery().data ?? []).filter((account) => account.platform === "bluesky");
  const error = errorMessage(connect.error);
  // A saved account is the likely next step until the person starts typing a new one.
  const [likely, ...others] = identifier || appPassword ? [] : saved;
  const otherSaved = identifier || appPassword ? saved : others;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    chooseAccount(await connect.mutateAsync({ platform: "bluesky", identifier, appPassword }));
  };

  return (
    <Screen
      actions={
        likely ? (
          <Button kind="primary" onClick={() => chooseAccount(likely.label)}>
            {t("account.continueAs", { label: likely.label })}
          </Button>
        ) : (
          <Button
            disabled={connect.isPending || !identifier || !appPassword}
            form={CONNECT_FORM}
            kind="primary"
            type="submit"
          >
            {t("account.connect")}
          </Button>
        )
      }
      heading={t("account.heading")}
      note={t("account.bluesky.note")}
    >
      <PlatformChoice />
      {saved.length > 0 && (
        <div className="saved-accounts">
          {otherSaved.map((account) => (
            <Button key={account.label} onClick={() => chooseAccount(account.label)}>
              {t("account.continueAs", { label: account.label })}
            </Button>
          ))}
          <p className="muted">{t("account.otherAccount")}</p>
        </div>
      )}
      <form className="form-grid form-grid--two" id={CONNECT_FORM} onSubmit={onSubmit}>
        <TextField
          autoComplete="username"
          label={t("account.bluesky.identifier")}
          onChange={(event) => setIdentifier(event.target.value)}
          placeholder="handle.bsky.social"
          value={identifier}
        />
        <TextField
          autoComplete="current-password"
          label={t("account.bluesky.password")}
          onChange={(event) => setAppPassword(event.target.value)}
          placeholder="xxxx-xxxx-xxxx-xxxx"
          type="password"
          value={appPassword}
        />
      </form>
      <p className="help">{t("account.bluesky.passwordHelp")}</p>
      {error && <Notice tone="fault">{error}</Notice>}
    </Screen>
  );
}

/// Second factor of the Telegram sign-in: the login code or the cloud password.
function TelegramSecretField({ auth, value, onChange }: {
  auth: TelegramAuthStatus;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const isCode = auth.phase === "wait_code";
  return (
    <section className="telegram-secret">
      <h2 className="section-heading">
        {t(isCode ? "account.telegram.codeHeading" : "account.telegram.passwordHeading")}
      </h2>
      <TextField
        autoComplete={isCode ? "one-time-code" : "current-password"}
        className="field--narrow"
        label={t(isCode ? "account.telegram.code" : "account.telegram.password")}
        onChange={(event) => onChange(event.target.value)}
        type={isCode ? "text" : "password"}
        value={value}
      />
    </section>
  );
}

function TelegramConnect() {
  const { t } = useTranslation();
  const chooseAccount = useFlowStore((s) => s.chooseAccount);
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phone, setPhone] = useState("");
  const [secret, setSecret] = useState("");
  const [changingDetails, setChangingDetails] = useState(false);
  const status = useTelegramAuthStatusQuery();
  const start = useTelegramAuthStartMutation();
  const code = useTelegramAuthCodeMutation();
  const password = useTelegramAuthPasswordMutation();
  const logOut = useDisconnectAccountMutation(useFlowStore((s) => s.accountRemoved));

  const auth = status.data;
  const phase = auth?.phase ?? "idle";
  const label = auth?.account_label ?? "Telegram";
  const signingIn = phase === "wait_code" || phase === "wait_password";
  // TDLib takes the API pair once per client, so after that only the phone can change.
  const keyTaken = signingIn || phase === "wait_phone_number" || phase === "wait_other_device_confirmation";
  const needsSecret = signingIn && !changingDetails;
  const pending = start.isPending || code.isPending || password.isPending || logOut.isPending;
  const failure =
    errorMessage(start.error ?? code.error ?? password.error ?? logOut.error ?? status.error) ??
    (phase === "error" ? auth?.message : null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (needsSecret && phase === "wait_code") {
      await code.mutateAsync({ code: secret.trim() });
    } else if (needsSecret) {
      await password.mutateAsync({ password: secret });
    } else {
      await start.mutateAsync({ api_id: Number(apiId), api_hash: apiHash.trim(), phone_number: phone.trim() });
      setChangingDetails(false);
    }
    setSecret("");
  };

  const ready = phase === "ready";
  // Loads the chat list in the background, so the next step opens with it.
  useTelegramScopeStatusQuery(ready);
  const secretLabel = phase === "wait_code" ? t("account.telegram.confirmCode") : t("account.telegram.confirmPassword");
  const submitLabel = needsSecret ? secretLabel : t("account.connect");
  const canSubmit = needsSecret
    ? secret.length > 0
    : Boolean(phone.trim() && (keyTaken || (apiId.trim() && apiHash.trim())));

  const body = () => {
    if (status.isPending) {
      return <p className="help">{t("account.telegram.connecting")}</p>;
    }
    if (phase === "signing_out") {
      return <p className="help">{t("account.telegram.signingOut")}</p>;
    }
    if (ready) {
      return <p className="help">{t("account.telegram.ready", { label })}</p>;
    }
    return (
      <form id={CONNECT_FORM} onSubmit={onSubmit}>
        <div className="form-grid form-grid--three">
          {!keyTaken && (
            <>
              <TextField
                inputMode="numeric"
                label={t("account.telegram.apiId")}
                onChange={(event) => setApiId(event.target.value)}
                value={apiId}
              />
              <TextField
                autoComplete="off"
                label={t("account.telegram.apiHash")}
                onChange={(event) => setApiHash(event.target.value)}
                type="password"
                value={apiHash}
              />
            </>
          )}
          <TextField
            autoComplete="tel"
            disabled={needsSecret}
            label={t("account.telegram.phone")}
            onChange={(event) => setPhone(event.target.value)}
            type="tel"
            value={phone}
          />
        </div>
        {!keyTaken && <p className="help">{t("account.telegram.help")}</p>}
        {auth && needsSecret && <TelegramSecretField auth={auth} onChange={setSecret} value={secret} />}
        {auth?.confirmation_link && (
          <p className="help">
            {t("account.telegram.otherDevice")}: <a href={auth.confirmation_link}>{auth.confirmation_link}</a>
          </p>
        )}
      </form>
    );
  };

  return (
    <Screen
      actions={
        ready ? (
          <>
            <ConfirmButton
              confirmLabel={t("account.telegram.confirmLogOut")}
              disabled={logOut.isPending}
              onConfirm={() => logOut.mutate({ platform: "telegram", label })}
            >
              {t("account.telegram.logOut")}
            </ConfirmButton>
            <Button disabled={logOut.isPending} kind="primary" onClick={() => chooseAccount(label)}>
              {t("account.telegram.continue")}
            </Button>
          </>
        ) : (
          <>
            {/* TDLib keeps the API pair for the whole client; only a reset swaps it. */}
            {phase === "wait_phone_number" && (
              <ConfirmButton
                confirmLabel={t("account.telegram.confirmChangeKey")}
                disabled={pending}
                onConfirm={() => logOut.mutate({ platform: "telegram", label })}
              >
                {t("account.telegram.changeKey")}
              </ConfirmButton>
            )}
            {needsSecret && (
              <Button onClick={() => setChangingDetails(true)}>{t("account.telegram.changeDetails")}</Button>
            )}
            <Button disabled={pending || !canSubmit} form={CONNECT_FORM} kind="primary" type="submit">
              {submitLabel}
            </Button>
          </>
        )
      }
      heading={t("account.heading")}
      note={t("account.telegram.note")}
    >
      <PlatformChoice />
      {body()}
      {failure && <Notice tone="fault">{failure}</Notice>}
    </Screen>
  );
}

export function AccountStep() {
  const platformId = useFlowStore((s) => s.platformId);
  return platformId === "telegram" ? <TelegramConnect /> : <BlueskyConnect />;
}
