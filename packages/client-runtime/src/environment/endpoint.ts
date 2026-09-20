export * from "@t3tools/shared/advertisedEndpoint";
import { hubEnvironmentPrefix } from "@t3tools/shared/hubEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = hubEnvironmentPrefix(url) + pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
};
