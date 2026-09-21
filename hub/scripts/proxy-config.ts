export const proxyImport = "import /etc/caddy/t3-hub-remote.caddy";
export function managedProxyConfig(original: string) {
  if (original.includes(proxyImport)) {
    if (!original.includes("request_header @notHubManaged -Authorization"))
      throw new Error("Existing managed proxy routing requires administrator review");
    return original;
  }
  const authorization = /^(\s*)request_header -Authorization\s*$/gm;
  const access = /^(\s*)import \/usr\/local\/lib\/hub-broker\/hub-access\.caddy\s*$/gm;
  if (
    [...original.matchAll(authorization)].length !== 1 ||
    [...original.matchAll(access)].length !== 1
  )
    throw new Error("Unrecognized Caddy routing; preserve it for administrator review");
  return original
    .replace(
      authorization,
      (_line, indent: string) =>
        `${indent}@notHubManaged not path /hub/environments/*\n${indent}request_header @notHubManaged -Authorization`,
    )
    .replace(
      access,
      (_line, indent: string) =>
        `${indent}import /usr/local/lib/hub-broker/hub-access.caddy\n${indent}${proxyImport}`,
    );
}
