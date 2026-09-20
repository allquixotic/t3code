import { expect, it } from "vite-plus/test";
import { hubEnvironmentPrefix } from "./hubEndpoint.ts";
import { normalizeHttpBaseUrl, deriveWsBaseUrl } from "./advertisedEndpoint.ts";
import { resolveRemotePairingTarget } from "./remote.ts";

it("preserves each managed environment across pairing, HTTP and WebSocket normalization", () => {
  const base = "https://hub.example/hub/environments/mbp";
  expect(hubEnvironmentPrefix(new URL(`${base}/api/test`))).toBe("/hub/environments/mbp");
  expect(normalizeHttpBaseUrl(`${base}/api/test?q=1#hash`)).toBe(`${base}/`);
  expect(deriveWsBaseUrl(base)).toBe("wss://hub.example/hub/environments/mbp/");
  expect(resolveRemotePairingTarget({ host: base, pairingCode: "fixture" })).toEqual({
    credential: "fixture",
    httpBaseUrl: `${base}/`,
    wsBaseUrl: "wss://hub.example/hub/environments/mbp/",
  });
});
it("retains upstream behavior for ordinary and malformed paths", () => {
  for (const path of [
    "/ordinary",
    "/hub/environments/",
    "/hub/environments/a%2Fb",
    "/hub/environments/a;other",
  ]) {
    expect(hubEnvironmentPrefix(new URL(`https://hub.example${path}`))).toBe("");
    expect(normalizeHttpBaseUrl(`https://hub.example${path}`)).toBe("https://hub.example/");
  }
});
