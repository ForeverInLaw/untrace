import { useTranslation } from "react-i18next";
import { Button, Notice, Screen } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { usePlatformsQuery } from "../queries/platforms";
import { useAccountsQuery, useDisconnectAccountMutation } from "../queries/runs";
import { useFlowStore } from "../stores/flowStore";

export function AccountsView() {
  const { t } = useTranslation();
  const accounts = useAccountsQuery();
  const disconnect = useDisconnectAccountMutation();
  const platforms = usePlatformsQuery().data ?? [];
  const startOver = useFlowStore((s) => s.startOver);
  // Starting over would drop the screen of a deletion that keeps running.
  const running = useFlowStore((s) => s.step === "run");
  const rows = accounts.data ?? [];

  return (
    <Screen
      actions={<Button disabled={running} kind="primary" onClick={startOver}>{t("accounts.add")}</Button>}
      heading={t("accounts.heading")}
      lead={t("accounts.lead")}
    >
      {accounts.isSuccess && rows.length === 0 && <p className="empty">{t("accounts.empty")}</p>}
      {accounts.isError && <Notice tone="fault">{errorMessage(accounts.error)}</Notice>}
      <ul className="account-list">
        {rows.map((account) => (
          <li className="account-row" key={`${account.platform}:${account.label}`}>
            <span>
              <strong>{account.label}</strong>
              <small>{platforms.find((item) => item.id === account.platform)?.display_name ?? account.platform}</small>
            </span>
            <Button disabled={disconnect.isPending} onClick={() => disconnect.mutate(account)}>
              {t("accounts.disconnect")}
            </Button>
          </li>
        ))}
      </ul>
      {disconnect.isError && <Notice tone="fault">{errorMessage(disconnect.error)}</Notice>}
    </Screen>
  );
}
