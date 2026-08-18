/**
 * Unwrap destination URLs embedded directly in shortener links.
 *
 * JavaScript port of link_decrypt/unwrap.py — kept deliberately
 * dependency-free and side-effect-free so the content script, the popup
 * and the service worker can all share it. Behaviour must stay in sync
 * with the Python version; both are covered by the same test vectors.
 */
(function (root) {
  "use strict";

  // Query parameter names commonly used to carry the real destination,
  // roughly ordered by likelihood since the first hit wins.
  const CANDIDATE_PARAMS = [
    "url", "u", "link", "target", "dest", "destination",
    "redirect", "redirect_url", "redirect_to", "r", "to",
    "goto", "out", "next", "continue", "data",
  ];

  const URL_RE = /^https?:\/\/[^\s]+$/i;
  // Base64 alphabet incl. urlsafe variants; padding optional because
  // these services frequently strip it.
  const B64_RE = /^[A-Za-z0-9+/\-_]{8,}={0,2}$/;

  function looksLikeUrl(value) {
    return URL_RE.test(String(value).trim());
  }

  function decodeBase64(value) {
    const candidate = String(value).trim();
    if (!B64_RE.test(candidate)) return null;

    // Restore stripped padding and normalise the urlsafe alphabet.
    const padded = candidate + "=".repeat((4 - (candidate.length % 4)) % 4);
    const standard = padded.replace(/-/g, "+").replace(/_/g, "/");

    for (const attempt of [standard, padded]) {
      let decoded;
      try {
        const binary = atob(attempt);
        // Decode as UTF-8 rather than latin-1 so non-ASCII URLs survive.
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (err) {
        continue;
      }
      decoded = decoded.trim();
      if (looksLikeUrl(decoded)) return decoded;
    }
    return null;
  }

  function unwrapValue(value) {
    let decoded;
    try {
      decoded = decodeURIComponent(value).trim();
    } catch (err) {
      decoded = String(value).trim(); // malformed percent-encoding
    }
    if (looksLikeUrl(decoded)) return decoded;
    return decodeBase64(value) || decodeBase64(decoded);
  }

  /**
   * Return the destination embedded in `url`, or null if there isn't one.
   */
  function extractEmbeddedUrl(url) {
    let params;
    try {
      params = new URL(url).searchParams;
    } catch (err) {
      return null; // not an absolute URL
    }

    // Preferred parameter names first...
    for (const name of CANDIDATE_PARAMS) {
      const value = params.get(name);
      if (!value) continue;
      const found = unwrapValue(value);
      if (found && found !== url) return found;
    }

    // ...then anything else, in case the service uses an unusual name.
    for (const [name, value] of params.entries()) {
      if (CANDIDATE_PARAMS.includes(name) || !value) continue;
      const found = unwrapValue(value);
      if (found && found !== url) return found;
    }

    return null;
  }

  /**
   * Repeatedly unwrap while destinations stay embedded (wrappers nest).
   * Returns { url, chain } where chain lists the URLs unwrapped along
   * the way — empty when nothing was embedded.
   */
  function unwrapAll(url, maxDepth) {
    const limit = typeof maxDepth === "number" ? maxDepth : 5;
    const chain = [];
    const seen = new Set([url]);
    let current = url;

    for (let i = 0; i < limit; i++) {
      const next = extractEmbeddedUrl(current);
      if (!next || seen.has(next)) break;
      chain.push(current);
      seen.add(next);
      current = next;
    }

    return { url: current, chain };
  }

  root.LinkDecryptUnwrap = { extractEmbeddedUrl, unwrapAll, CANDIDATE_PARAMS };

  // Allow `require()` from the node test harness.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.LinkDecryptUnwrap;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
