import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "./ui";

type PagedQuery = Pick<UseInfiniteQueryResult, "hasNextPage" | "isFetchingNextPage" | "fetchNextPage">;

/// Loads the next page of a table's rows, while there may be one.
export function MoreRows({ query }: { query: PagedQuery }) {
  const { t } = useTranslation();
  if (!query.hasNextPage) {
    return null;
  }
  return (
    <div className="table-more">
      <Button disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
        {t("table.more")}
      </Button>
    </div>
  );
}
