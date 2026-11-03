import type { LucideIcon } from "lucide-react";
import { Plus, Receipt, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { languages, setLanguage } from "../i18n";
import { accountName } from "../lib/format";
import { useAccountsQuery, useReceiptsQuery } from "../queries/runs";
import { usePlatformsQuery } from "../queries/platforms";
import { useFlowStore, type View } from "../stores/flowStore";
import { Seal } from "./Seal";

const RECENT_LIMIT = 3;

function NavItem({ view, icon: Icon, label }: { view: View; icon: LucideIcon; label: string }) {
  const active = useFlowStore((s) => s.view === view);
  const openView = useFlowStore((s) => s.openView);
  return (
    <button
      aria-current={active ? "page" : undefined}
      className="nav-item"
      onClick={() => openView(view)}
      type="button"
    >
      <Icon aria-hidden="true" size={16} />
      {label}
    </button>
  );
}

function RecentCleanups() {
  const { t } = useTranslation();
  const openReceipt = useFlowStore((s) => s.openReceipt);
  const receipts = useReceiptsQuery().data ?? [];
  if (receipts.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="recent-heading" className="recent">
      <h2 className="recent__heading" id="recent-heading">{t("nav.recent")}</h2>
      {receipts.slice(0, RECENT_LIMIT).map(({ summary }, index) => (
        <button className="recent__row" key={summary.run_id} onClick={() => openReceipt(summary.run_id)} type="button">
          <Seal runId={summary.run_id} size={30} />
          <span className="recent__text">
            <strong>{t("cleanup.number", { number: receipts.length - index })}</strong>
            <small>{t("cleanup.deletedShort", { count: summary.deleted })}</small>
          </span>
        </button>
      ))}
    </section>
  );
}

function CurrentAccount() {
  const { t, i18n } = useTranslation();
  const account = useFlowStore((s) => s.account);
  const platformId = useFlowStore((s) => s.platformId);
  const platform = usePlatformsQuery().data?.find((item) => item.id === platformId);
  // Before an account is chosen, say what this device is signed in to, as Accounts does.
  const connected = useAccountsQuery().data?.length ?? 0;
  return (
    <div className="sidebar__foot">
      <div className="sidebar__account">
        {account ? (
          <>
            <strong>{accountName(account)}</strong>
            <small>{platform?.display_name}</small>
          </>
        ) : (
          <small>{connected > 0 ? t("nav.accountsConnected", { count: connected }) : t("nav.noAccount")}</small>
        )}
      </div>
      <fieldset aria-label={t("nav.language")} className="language">
        {languages.map((language) => (
          <button
            aria-pressed={i18n.language === language}
            key={language}
            onClick={() => setLanguage(language)}
            type="button"
          >
            {language.toUpperCase()}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  return (
    <aside className="sidebar">
      <p className="sidebar__brand">Untrace</p>
      <nav className="sidebar__nav">
        <NavItem icon={Plus} label={t("nav.newCleanup")} view="cleanup" />
        <NavItem icon={Receipt} label={t("nav.receipts")} view="receipts" />
        <NavItem icon={UserRound} label={t("nav.accounts")} view="accounts" />
      </nav>
      <RecentCleanups />
      <CurrentAccount />
    </aside>
  );
}
