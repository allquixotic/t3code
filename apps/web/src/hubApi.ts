import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary";
import { readDesktopPrimaryBearerToken } from "./environments/primary/desktopAuth";

/** Hub operations always go to the control environment, regardless of the selected remote. */
export async function requestHub(path: string, method = "GET", signal?: AbortSignal) {
  const bearer = await readDesktopPrimaryBearerToken();
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl(`/api/hub/${path}`), {
    method,
    credentials: bearer ? "omit" : "include",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Hub service unavailable");
  return response.json() as Promise<unknown>;
}
