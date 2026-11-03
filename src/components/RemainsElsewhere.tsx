import { useTranslation } from "react-i18next";
import { Disclosure } from "./ui";

/// What other people and services can still hold once the platform has deleted an item.
const REMAINS = ["remains.otherApps", "remains.shares", "remains.saved", "remains.archives"] as const;

/// What deletion cannot reach, folded away under one line.
export function RemainsElsewhere() {
  const { t } = useTranslation();
  return (
    <Disclosure summary={t("remains.heading")}>
      <ul className="remains">
        {REMAINS.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
    </Disclosure>
  );
}
