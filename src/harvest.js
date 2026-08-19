/**
 * Pull downloadable links out of raw HTML.
 *
 * This runs in the service worker, which has **no DOM** — there is no
 * DOMParser in a MV3 background context. So extraction is regex-based
 * rather than tree-based. That's fine here: we only need `href`
 * attributes and bare URLs, not structure.
 *
 * Kept free of any chrome.* API so it can be unit-tested under node.
 */
(function (root) {
  "use strict";

  const { unwrapAll } = root.LinkDecryptUnwrap;
  const { classify, filenameOf } = root.LinkDecryptLinks;

  // href="...", href='...', or bare href=...
  const HREF_RE = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  // URLs sitting in plain text / inside scripts — some sites reveal the
  // real download that way rather than as a clickable anchor.
  const BARE_URL_RE = /https?:\/\/[^\s"'<>\\)]+/gi;

  function decodeEntities(value) {
    return String(value)
      .replace(/&amp;/gi, "&")
      .replace(/&#38;/g, "&")
      .replace(/&#x26;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
  }

  function absolutise(href, baseUrl) {
    try {
      return new URL(decodeEntities(href).trim(), baseUrl).href;
    } catch (err) {
      return null;
    }
  }

  // Some links are deliberately hidden from scrapers: the `href` is left
  // as "#" and the real address is split across two data attributes,
  // rejoined by the site's own click handler.
  //
  //   <a href="#" class="secure-lnk"
  //      data-domain="https://rootz." data-path="so/d/UjCoy">Part.12</a>
  //
  // One file out of a twelve-part set was written that way, so the set
  // arrived one short with nothing to indicate anything was missing.
  //
  // The halves are joined exactly as written — the split lands in the
  // middle of the hostname above, so inserting a separator would corrupt
  // it. The only tidying is collapsing a doubled slash when the left half
  // ends with one and the right half begins with one.
  const A_TAG_RE = /<a\b[^>]*>/gi;
  const DOMAIN_ATTR_RE =
    /\bdata-(?:domain|host|base|prefix)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
  const PATH_ATTR_RE =
    /\bdata-(?:path|suffix|file|link|url)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

  function attrValue(tag, pattern) {
    const match = pattern.exec(tag);
    if (!match) return "";
    return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
  }

  /** Anchors whose address is split across data attributes. */
  function splitAttributeLinks(html) {
    const out = [];
    let match;
    A_TAG_RE.lastIndex = 0;
    while ((match = A_TAG_RE.exec(html)) !== null) {
      const tag = match[0];
      if (!/\bdata-/i.test(tag)) continue;
      const domain = attrValue(tag, DOMAIN_ATTR_RE);
      const path = attrValue(tag, PATH_ATTR_RE);
      if (!domain || !path) continue;
      const joined = (domain + path).replace(/([^:])\/\//g, "$1/");
      if (/^https?:\/\/\S+$/i.test(joined)) out.push({ domain, url: joined });
    }
    return out;
  }

  /** Every absolute http(s) URL referenced by this HTML. */
  function extractLinks(html, baseUrl) {
    const found = new Set();

    let match;
    HREF_RE.lastIndex = 0;
    while ((match = HREF_RE.exec(html)) !== null) {
      const raw = match[1] ?? match[2] ?? match[3];
      if (!raw) continue;
      const abs = absolutise(raw, baseUrl);
      if (abs && /^https?:/i.test(abs)) found.add(abs);
    }

    BARE_URL_RE.lastIndex = 0;
    while ((match = BARE_URL_RE.exec(html)) !== null) {
      found.add(decodeEntities(match[0]).replace(/[.,;:]+$/, ""));
    }

    // Rejoin split addresses, and drop the half-address the bare-URL scan
    // above will have picked up out of `data-domain` — on its own it is a
    // truncated hostname that resolves to nothing.
    for (const { domain, url } of splitAttributeLinks(html)) {
      found.delete(domain);
      found.delete(domain.replace(/[.,;:]+$/, ""));
      found.add(url);
    }

    return [...found];
  }

  // A page's siblings: same site, same folder, different page. Mirror
  // pages are laid out exactly like this — /archives/34685 lists Rootz,
  // Mediafire and Akia as plain links to /archives/34681, /34674,
  // /34676, one host per page. Those aren't wrapped links, so chasing
  // only decoded ones never reaches the actual downloads.
  //
  // Restricting to the same folder is what keeps this from turning into
  // a whole-site crawl: it picks up the mirror list and skips the site
  // root, the nav and any off-site guides.
  const MAX_SIBLINGS = 15;

  function siblingsOf(links, pageUrl) {
    let base;
    try {
      base = new URL(pageUrl);
    } catch (err) {
      return [];
    }
    const folder = base.pathname.replace(/[^/]*$/, "");
    // A page sitting at the site root has every other page as a
    // "sibling", which is not a crawl worth starting.
    if (folder === "/" || folder === "") return [];

    const out = [];
    for (const link of links) {
      if (out.length >= MAX_SIBLINGS) break;
      try {
        const url = new URL(link);
        if (url.origin !== base.origin) continue;
        if (!url.pathname.startsWith(folder)) continue;
        if (url.pathname === base.pathname) continue;
        out.push(url.href.split("#")[0]);
      } catch (err) {
        /* skip anything unparseable */
      }
    }
    return [...new Set(out)];
  }

  /**
   * Extract, unwrap and classify everything on a page.
   *
   * Returns { downloads, decoded, siblings } — `downloads` are links
   * worth sending to JDownloader, while `decoded` (wrapped links) and
   * `siblings` (neighbouring pages) are both worth following to find
   * more.
   */
  function harvestFromHtml(html, pageUrl, hosts) {
    const downloads = new Map();
    const decoded = new Set();
    const all = extractLinks(html, pageUrl);

    for (const link of all) {
      const { url: destination, chain } = unwrapAll(link);
      if (chain.length) decoded.add(destination);

      const kind = classify(destination, hosts);
      if (!kind || downloads.has(destination)) continue;

      downloads.set(destination, {
        url: destination,
        kind,
        filename: filenameOf(destination),
        sourcePage: pageUrl,
      });
    }

    return {
      downloads: [...downloads.values()],
      decoded: [...decoded],
      siblings: siblingsOf(all, pageUrl),
    };
  }

  root.LinkDecryptHarvest = {
    extractLinks,
    harvestFromHtml,
    siblingsOf,
    splitAttributeLinks,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.LinkDecryptHarvest;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
