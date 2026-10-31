import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

export interface Account {
  platform: string;
  label: string;
}

/// Server/async state via TanStack Query (never useEffect+useState).
/// NOTE: the `list_accounts` command is not wired yet (returns until then).
export function useAccounts() {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: () => invoke<Account[]>("list_accounts"),
  });
}
