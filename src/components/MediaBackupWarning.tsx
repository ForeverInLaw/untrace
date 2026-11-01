import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePlatformsQuery } from "../queries/platforms";
import { effectiveContentTypes, useFlowStore } from "../stores/flowStore";
import { Notice } from "./ui";

/// Telegram media is deleted without reaching the backup, so a run that covers
/// it has to say so before anything is deleted.
export function MediaBackupWarning() {
  const { t } = useTranslation();
  const platformId = useFlowStore((s) => s.platformId);
  const draft = useFlowStore((s) => s.draft);
  const available = usePlatformsQuery().data?.find((platform) => platform.id === platformId)?.content_types ?? [];
  if (platformId !== "telegram" || !effectiveContentTypes(draft, available).includes("media")) {
    return null;
  }
  return (
    <Notice icon={<TriangleAlert aria-hidden="true" size={16} />} tone="caution">
      {t("backup.mediaWarning")}
    </Notice>
  );
}
