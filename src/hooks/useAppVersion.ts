import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";

export function useAppVersion(): string | null {
  const q = useQuery({
    queryKey: ["app-version"],
    queryFn: getVersion,
    staleTime: Infinity,
  });
  return q.data ?? null;
}
