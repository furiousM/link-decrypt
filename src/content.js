/**
 * Content script: decode wrapped links in place on the page you're
 * browsing, and keep an inventory of downloadable links for the popup.
 */
(function () {
  "use strict";

  const { unwrapAll } = globalThis.LinkDecryptUnwrap;
  const { classify, filenameOf, looksLikeSupportLink } =
    globalThis.LinkDecryptLinks;

  const MARK_ATTR = "data-link-decrypt";
  const ORIGINAL_ATTR = "data-link-decrypt-original";

  let settings = {
    rewriteLinks: true,
    showBadges: true,
    fileHosts: [],
  };

  // url -> { url, kind, filename, text }
  const inventory = new Map();
  // Destinations already handed to JD from this page. Sites often point
  // several differently-labelled links ("Mediafire", "Akia", "Viki") at
  // the *same* landing page, so a second click sends the identical set,
  // JD's dupe manager drops it, and nothing appears — which reads as a
  // failure rather than "you already have these".
  const sentDestinations = new Set();
  // Decoded destinations that are *not* themselves downloads — these are
  // the pages worth following to find the actual .rar / host links.
  const followable = new Map();
  let decodedCount = 0;

  /* ---------------------------------------------------------------- */

  function injectStyles() {
    if (document.getElementById("link-decrypt-styles")) return;
    const style = document.createElement("style");
    style.id = "link-decrypt-styles";
    style.textContent = `
      .link-decrypt-badge {
        display: inline-block;
        margin-left: 4px;
        padding: 0 5px;
        font: 600 10px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #fff !important;
        background: #2ea043;
        border-radius: 3px;
        vertical-align: middle;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }
      .link-decrypt-badge:hover { background: #3fb955; }
      .link-decrypt-badge:active { background: #268138; }
      .link-decrypt-badge.link-decrypt-copied { background: #1f6feb; }
      .link-decrypt-badge.link-decrypt-sending { background: #8b949e; }
      .link-decrypt-badge.link-decrypt-failed { background: #e5534b; }
      a[${MARK_ATTR}="decoded"] {
        outline: 1px dashed rgba(46, 160, 67, .8);
        outline-offset: 2px;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /** Name JDownloader packages after the release, not the site. */
  function packageNameForPage() {
    const title = (document.title || "").split(/\s+[-–|]\s+/)[0].trim();
    if (title.length >= 3) return title.slice(0, 80);
    return location.hostname.replace(/^www\./, "") || "link-decrypt";
  }

  function addBadge(anchor, destination) {
    if (!settings.showBadges) return;
    if (anchor.nextElementSibling?.classList?.contains("link-decrypt-badge")) return;

    // Show where the link actually goes, rather than just "decoded" —
    // native title tooltips are unreliable on pages with their own hover
    // handling, and "decoded" alone tells you nothing useful anyway.
    let label = destination;
    try {
      label = new URL(destination).hostname.replace(/^www\./, "");
    } catch (err) {
      /* fall back to the raw URL */
    }

    const badge = document.createElement("span");
    badge.className = "link-decrypt-badge";
    badge.textContent = "→ " + label;
    badge.title =
      destination + "\n\nClick: send to JDownloader\nAlt-click: copy URL";
    badge.setAttribute("role", "button");
    badge.setAttribute("tabindex", "0");

    const flash = (text, cls) => {
      badge.textContent = text;
      badge.className = "link-decrypt-badge" + (cls ? " " + cls : "");
      setTimeout(() => {
        badge.textContent = "→ " + label;
        badge.className = "link-decrypt-badge";
      }, 1600);
    };

    const copy = () => {
      navigator.clipboard?.writeText(destination).then(
        () => flash("copied", "link-decrypt-copied"),
        () => flash("copy failed", "link-decrypt-failed")
      );
    };

    // Sending straight to JDownloader is the point — copying only helps
    // if JD's clipboard monitor happens to be enabled, and it silently
    // does nothing when it isn't. The content script can't reach
    // 127.0.0.1 itself (it inherits the page's https origin), so the
    // service worker does the actual request.
    const send = () => {
      if (sentDestinations.has(destination)) {
        flash("already sent", "link-decrypt-copied");
        badge.title =
          `Already sent to JDownloader from this page.\n\n` +
          `Other links here point at the same destination:\n${destination}`;
        return;
      }

      // A destination that isn't itself a download gets fetched and
      // harvested first, which takes a moment — say so rather than
      // appear frozen.
      const isDownload = !!classify(destination, settings.fileHosts);
      flash(isDownload ? "sending…" : "finding files…", "link-decrypt-sending");
      chrome.runtime.sendMessage(
        {
          type: "SEND_TO_JD",
          links: [destination],
          packageName: packageNameForPage(),
          referrer: location.href,
        },
        (response) => {
          if (chrome.runtime.lastError || !response?.ok) {
            // A pending confirmation in JD is not a failure — say so,
            // otherwise it looks like the extension is broken.
            const pending = response?.pending;
            const badgeText = pending ? "confirm in JD" : "JD failed";
            flash(badgeText, "link-decrypt-failed");
            badge.title = response?.error || "Could not reach JDownloader";
            return;
          }
          // Report what actually got sent. "sent to JD" while zero links
          // reached the Linkgrabber is exactly how this went wrong before.
          const n = response.count ?? 0;
          sentDestinations.add(destination);
          flash(`sent ${n} to JD`, "link-decrypt-copied");
          if (response.harvested) {
            badge.title =
              `${response.harvested} link(s) found by following ` +
              `${destination}\n\n${destination}`;
          }
        }
      );
    };

    const activate = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.altKey) copy();
      else send();
    };

    badge.addEventListener("click", activate);
    badge.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") activate(e);
    });

    anchor.insertAdjacentElement("afterend", badge);
  }

  /* ---------------------------------------------------------------- */

  function processAnchor(anchor) {
    if (anchor.getAttribute(MARK_ATTR)) return;

    const href = anchor.href; // resolved absolute URL
    if (!href || !/^https?:/i.test(href)) return;

    const { url: destination, chain } = unwrapAll(href);

    if (chain.length) {
      anchor.setAttribute(MARK_ATTR, "decoded");
      anchor.setAttribute(ORIGINAL_ATTR, href);
      if (settings.rewriteLinks) anchor.href = destination;
      addBadge(anchor, destination);
      decodedCount++;
      record(destination, anchor.textContent, true);
    } else {
      anchor.setAttribute(MARK_ATTR, "seen");
      record(href, anchor.textContent, false);
    }
  }

  function record(url, text, wasDecoded) {
    const kind = classify(url, settings.fileHosts);
    const label = (text || "").trim().slice(0, 80);

    // "Guide Download" / "Tool Download" sit right next to the real
    // mirrors and look identical by URL. Drop them rather than make you
    // spot them in the list every time.
    if (looksLikeSupportLink(label)) return;

    if (kind) {
      if (!inventory.has(url)) {
        inventory.set(url, {
          url,
          kind,
          filename: filenameOf(url),
          text: label,
        });
      }
      return;
    }

    // Not a recognised download. If we had to decode it, it's still a
    // deliberate destination — either a host we don't know about, or a
    // page holding the real links. We can't tell which, so offer both:
    // list it (unchecked) so it can be sent to JDownloader, which has far
    // more host plugins than our list, and keep it followable.
    if (wasDecoded) {
      if (!followable.has(url)) followable.set(url, { url, text: label });
      if (!inventory.has(url)) {
        inventory.set(url, {
          url,
          kind: "unknown",
          filename: filenameOf(url),
          text: label,
        });
      }
    }
  }

  function scan(root) {
    const anchors = (root || document).querySelectorAll?.("a[href]") || [];
    for (const anchor of anchors) {
      try {
        processAnchor(anchor);
      } catch (err) {
        /* never let one bad link break the sweep */
      }
    }
  }

  /* ---------------------------------------------------------------- */

  function currentPageDestination() {
    const { url, chain } = unwrapAll(location.href);
    return chain.length ? url : null;
  }

  function summary() {
    return {
      pageUrl: location.href,
      pageTitle: document.title || "",
      pageDestination: currentPageDestination(),
      decodedCount,
      links: [...inventory.values()],
      followable: [...followable.values()],
    };
  }

  /* ---------------------------------------------------------------- */

  function start() {
    injectStyles();
    scan(document);

    // Pages load links lazily; keep watching, but debounce so we don't
    // re-sweep on every keystroke in a rich text field.
    let pending = null;
    const observer = new MutationObserver((mutations) => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) scan(node);
          }
        }
        scan(document);
      }, 250);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "GET_PAGE_LINKS") {
      sendResponse(summary());
    }
    return false;
  });

  chrome.storage?.sync?.get(
    { rewriteLinks: true, showBadges: true, fileHosts: [] },
    (stored) => {
      settings = { ...settings, ...stored };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
      } else {
        start();
      }
    }
  );
})();
