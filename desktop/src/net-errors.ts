// Turn low-level fetch failures into messages a user can act on. Node's fetch
// rejects with a bare `TypeError: fetch failed` and puts the real reason (a socket
// error code) on `error.cause`; Electron then prefixes IPC rejections with
// "Error invoking remote method ...". Both are noise for the reader.

export type NetworkFailureKind = "refused" | "dns" | "timeout" | "reset" | "tls" | "other";

function codeOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const entry = value as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof entry.code === "string" && entry.code) return entry.code;
  // Dual-stack localhost fails as an AggregateError of per-address errors.
  if (Array.isArray(entry.errors)) {
    for (const inner of entry.errors) {
      const code = codeOf(inner);
      if (code) return code;
    }
  }
  return "";
}

export function networkFailure(error: unknown): { kind: NetworkFailureKind; code: string } | null {
  if (!error || typeof error !== "object") return null;
  const err = error as { name?: unknown; message?: unknown; cause?: unknown };
  if (err.name === "AbortError") return null;
  const code = codeOf(err.cause) || codeOf(error);
  const isFetchFailure = err.name === "TypeError" && typeof err.message === "string" && /fetch failed|network/i.test(err.message);
  if (!code && !isFetchFailure) return null;
  if (code === "ECONNREFUSED") return { kind: "refused", code };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { kind: "dns", code };
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") return { kind: "timeout", code };
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE") return { kind: "reset", code };
  if (/^(CERT_|ERR_TLS|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_SSL)/.test(code)) return { kind: "tls", code };
  return isFetchFailure ? { kind: "other", code } : null;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host) || host.endsWith(".localhost");
}

// `url` is shown (as its origin only) when `showEndpoint` is true; the agent path
// passes false because its errors are persisted in evidence exports.
export function describeNetworkFailure(error: unknown, url: string, showEndpoint = true): string | null {
  const failure = networkFailure(error);
  if (!failure) return null;
  let origin = "";
  let local = false;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    local = isLoopbackHost(parsed.hostname);
  } catch { /* leave unknown */ }
  const target = showEndpoint && origin ? origin : "the provider endpoint";
  switch (failure.kind) {
    case "refused":
      return local
        ? `Cannot connect to ${target}: connection refused. The local server is not running — start it (for Ollama, open the Ollama app or run "ollama serve") and retry.`
        : `Cannot connect to ${target}: connection refused. Check the base URL and port in Settings → Providers.`;
    case "dns":
      return `Cannot reach ${target}: the host name could not be resolved. Check the base URL and your network connection.`;
    case "timeout":
      return `Timed out connecting to ${target}. The server may be down, blocked by a firewall, or very slow to respond.`;
    case "reset":
      return `The connection to ${target} was closed unexpectedly. Retry; if it persists, check the server logs.`;
    case "tls":
      return `Could not establish a secure connection to ${target} (${failure.code}). Check the endpoint's certificate or use its http:// URL if it is local.`;
    default:
      return `Network request to ${target} failed${failure.code ? ` (${failure.code})` : ""}. Check your connection and the base URL.`;
  }
}

// "Error invoking remote method 'ai:chat': TypeError: fetch failed" -> "fetch failed".
export function cleanIpcError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, "");
}
