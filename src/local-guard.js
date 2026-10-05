// Local-request trust for the bridge.
//
// The bridge listens on 127.0.0.1 and spends from the wallet (or account key)
// on every /v1/responses call. Loopback binding keeps the LAN out, but not a
// web page open in the user's browser: a text/plain POST needs no CORS
// preflight, and a DNS-rebinding page can read responses. Codex and other
// native clients send no Origin and pass; the dashboard is same-origin.

function isLocalHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/** Why this request must be refused, or null for a trusted local client. */
export function untrustedRequestReason(req) {
  const host = req.headers.host;
  if (host) {
    let hostname;
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      return "malformed Host header";
    }
    if (!isLocalHostname(hostname)) return `non-local Host header (${hostname})`;
  }

  const origin = req.headers.origin;
  if (Array.isArray(origin)) return "multiple Origin headers";
  if (origin !== undefined) {
    if (origin === "null") return "opaque Origin";
    let o;
    try {
      o = new URL(origin);
    } catch {
      return "malformed Origin header";
    }
    if ((o.protocol !== "http:" && o.protocol !== "https:") || !isLocalHostname(o.hostname)) {
      return `cross-site Origin (${origin})`;
    }
  }

  if (req.headers["sec-fetch-site"] === "cross-site") return "cross-site browser request";
  return null;
}
