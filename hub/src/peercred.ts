// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - protected Node I/O adapter, also runs outside the Effect host.
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { requireThat } from "./io.ts";

interface Native {
  peerUid(fd: number): number;
  harden(): void;
}
let native: Native | undefined;
const binding = () =>
  (native ??= createRequire(import.meta.url)("../native/peercred.node") as Native);
export function peerUid(socket: Socket) {
  const fd = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd;
  requireThat(typeof fd === "number" && fd >= 0, "Peer credentials unavailable");
  return binding().peerUid(fd);
}
export const harden = () => binding().harden();
