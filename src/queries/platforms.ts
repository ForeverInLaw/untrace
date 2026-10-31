import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/tauri";

export function usePlatformsQuery() {
  return useQuery({
    queryKey: ["platforms"],
    queryFn: api.platforms,
  });
}
