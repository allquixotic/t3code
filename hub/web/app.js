"use strict";
const id = location.pathname.split("/").pop();
let csrf = "",
  request = null,
  busy = false;
const el = (id) => document.getElementById(id);
async function api(suffix = "", body) {
  const response = await fetch(`/access/api/requests/${encodeURIComponent(id)}${suffix}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Hub-CSRF": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function message(s) {
  el("message").textContent = s;
}
function durationLabel(seconds) {
  if (seconds >= 7200 && seconds % 3600 === 0) return `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} seconds`;
}
async function refresh() {
  const data = await api();
  csrf = data.csrf;
  request = data.request;
  el("worker").textContent = request.worker;
  el("purpose").textContent = request.purpose;
  el("requested-duration").textContent = durationLabel(request.requested_seconds);
  const list = el("scope");
  list.replaceChildren();
  for (const name of request.capabilities) {
    const item = document.createElement("li"),
      scope = request.scope[name];
    item.textContent =
      name.startsWith("ssh:") || name.startsWith("environment:")
        ? `${name}\n${scope.user}@${scope.hostname}:${scope.port}\nHost keys: ${scope.fingerprints.join(", ")}${scope.updates ? `\n${scope.updates}` : ""}`
        : `${name}\n${scope.description}\n${scope.methods.join(", ")} ${scope.base_url}\nAllowed paths: ${scope.path_pattern}`;
    list.append(item);
  }
  const duration = el("duration"),
    previous = Number(duration.value);
  duration.replaceChildren();
  const values = [
    ...new Set([
      60,
      300,
      900,
      1800,
      3600,
      7200,
      14400,
      21600,
      28800,
      86400,
      172800,
      request.requested_seconds,
      request.granted_seconds,
    ]),
  ]
    .filter((v) => Number.isInteger(v) && v >= 60 && v <= 172800)
    .sort((a, b) => a - b);
  for (const value of values) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = durationLabel(value);
    duration.append(opt);
  }
  duration.value =
    request.state !== "pending" && request.granted_seconds
      ? request.granted_seconds
      : values.includes(previous)
        ? previous
        : request.requested_seconds;
  const active = request.state === "active";
  el("status").textContent = active
    ? `Access active until ${new Date(request.grant_expires_at).toLocaleString()}`
    : `Request ${request.state}`;
  el("approve").disabled = busy || request.state !== "pending";
  duration.disabled = busy || request.state !== "pending";
  el("revoke").hidden = !active;
  el("revoke").disabled = busy;
  if (active)
    message("Approved. Your waiting agent will continue automatically. You can close this page.");
}
function bytes(value) {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function base64(value) {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function assertionJSON(c) {
  return {
    id: c.id,
    rawId: base64(c.rawId),
    type: c.type,
    authenticatorAttachment: c.authenticatorAttachment,
    clientExtensionResults: c.getClientExtensionResults(),
    response: {
      clientDataJSON: base64(c.response.clientDataJSON),
      authenticatorData: base64(c.response.authenticatorData),
      signature: base64(c.response.signature),
      userHandle: c.response.userHandle ? base64(c.response.userHandle) : null,
    },
  };
}
el("approve").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  el("approve").disabled = true;
  el("duration").disabled = true;
  message("Confirm with your passkey…");
  try {
    const options = await api("/begin", { ttl_seconds: Number(el("duration").value) });
    const publicKey = { ...options.publicKey, challenge: bytes(options.publicKey.challenge) };
    if (publicKey.allowCredentials)
      publicKey.allowCredentials = publicKey.allowCredentials.map((c) => ({
        ...c,
        id: bytes(c.id),
      }));
    const credential = await navigator.credentials.get({ publicKey });
    if (!credential) throw new Error("Passkey approval was cancelled.");
    await api("/finish", { response: assertionJSON(credential) });
    busy = false;
    await refresh();
  } catch (error) {
    busy = false;
    try {
      await refresh();
    } catch {}
    message(
      error.name === "NotAllowedError"
        ? "Passkey approval was cancelled or timed out. Refresh after the challenge expires to try again."
        : error.message,
    );
  }
});
el("revoke").addEventListener("click", async () => {
  try {
    await api("/revoke", {});
    await refresh();
    message("Access revoked. Active SSH connections are being closed.");
  } catch (e) {
    message(e.message);
  }
});
el("refresh").addEventListener("click", () => refresh().catch((e) => message(e.message)));
refresh().catch((e) => message(e.message));
