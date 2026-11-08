import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80") ||
    normalized.startsWith("ff")
  );
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new Error("Attachment URLs must use https");
  if (url.username || url.password) throw new Error("Attachment URLs must not contain credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Attachment URL resolves to a private or reserved address");
  }
}

/**
 * Downloads a public https attachment. Private/reserved destinations are
 * refused (including after redirects) so the server cannot be used to probe
 * its internal network. Size is capped at 10 MiB.
 */
export async function downloadAttachment(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: Uint8Array; contentType: string }> {
  let url = new URL(rawUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await assertPublicUrl(url);
    const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect without location (${response.status})`);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`Failed to download attachment (${response.status})`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 10 MiB");
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 10 MiB");
    return { data, contentType: response.headers.get("content-type") ?? "application/octet-stream" };
  }
  throw new Error("Too many redirects");
}

export const _test = { isPrivateAddress };
