import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "./ui";

type PagedRows = Pick<UseInfiniteQueryResult, "hasNextPage" | "isFetchingNextPage" | "fetchNextPage">;

/// Loads the next page of a table's rows, while there may be one.
export function MoreRows({ rows }: { rows: PagedRows }) {
  const { t } = useTranslation();
  if (!rows.hasNextPage) {
    return null;
  }
  return (
    <div className="table-more">
      <Button disabled={rows.isFetchingNextPage} onClick={() => rows.fetchNextPage()}>
        {t("preview.more")}
      </Button>
    </div>
  );
}
