/**
 * Service worker: the only place allowed to talk to JDownloader.
 *
 * Why not straight from the content script? A content script inherits
 * the page's origin, so on an https:// page a POST to http://127.0.0.1
 * is blocked. The service worker runs on the extension's own origin and,
 * with host_permissions for 127.0.0.1/localhost, its requests bypass CORS
 * — and http://localhost counts as a trustworthy origin, so there's no
 * mixed-content problem either.
 *
 * Mirrors link_decrypt/jdownloader.py: POST to /flash/add, fall back to
 * /flashgot, and preflight with /jdcheck.js.
 */
"use strict";

// Classic (non-module) service worker, so importScripts is available.
importScripts("unwrap.js", "links.js", "harvest.js");

const { harvestFromHtml } = globalThis.LinkDecryptHarvest;
const { classify } = globalThis.LinkDecryptLinks;

const DEFAULTS = {
  jdHost: "127.0.0.1",
  jdPort: 9666,
  fileHosts: [],
  crawlDepth: 2,
  maxPages: 40,
};

const FETCH_TIMEOUT_MS = 20000;
const SEND_TIMEOUT_MS = 12000;
const CONCURRENCY = 4;

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, resolve);
  });
}

function base({ jdHost, jdPort }) {
  return `http://${jdHost}:${jdPort}`;
}

/** Preflight: is JDownloader actually listening? */
async function checkConnection() {
  const settings = await getSettings();
  const url = `${base(settings)}/jdcheck.js`;
  try {
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = (await resp.text()).trim();
    return { ok: true, banner: text, endpoint: base(settings) };
  } catch (err) {
    return {
      ok: false,
      error:
        `No JDownloader 2 answering at ${base(settings)}. Make sure JD2 is ` +
        `running and that Settings -> Advanced Settings -> "Remote Control / ` +
        `External Interface" is enabled.`,
      detail: String(err),
    };
  }
}

/** Send links to the Linkgrabber. */
async function sendLinks(links, packageName, referrer, options = {}) {
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  if (!links || !links.length) {
    return { ok: false, error: "No links to send." };
  }

  const settings = await getSettings();
  const body = new URLSearchParams({
    urls: links.join("\n"),
    package: packageName || "link-decrypt",
    // JD's "authorised sources" list keys on `source`, and it prompts
    // once per unseen source. Sending the page URL here meant every new
    // site looked like a new application and re-prompted, so allowing it
    // once never stuck. A fixed identity gets authorised once, forever.
    source: "link-decrypt",
    autostart: "0",
  });
  // The page URL still matters to JD for hosts that check referers — it
  // just isn't the thing that identifies us.
  if (referrer) body.set("referer", referrer);

  const errors = [];
  for (const endpoint of ["/flash/add", "/flashgot"]) {
    // JD holds the connection open while it waits for you to answer its
    // "An external application tries to add links" prompt. Without a
    // timeout the request just hangs and the UI sits there claiming to
    // be working, which is indistinguishable from a broken extension.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(base(settings) + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { ok: true, count: links.length, endpoint };
    } catch (err) {
      if (err.name === "AbortError") {
        return {
          ok: false,
          pending: true,
          error:
            "JDownloader didn't respond. It's most likely showing an " +
            '"An external application tries to add links" prompt — ' +
            'switch to JD and click "Allow it!". It remembers after that.',
        };
      }
      errors.push(`${endpoint}: ${err}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    error:
      `Could not reach JDownloader at ${base(settings)}. ` +
      `Tried ${errors.join(", ")}.`,
  };
}

/* ---------------------------- crawling ---------------------------- */

/**
 * Fetch one page and pull the downloadable links out of it.
 *
 * Returns null for anything that isn't fetchable HTML, so binary files
 * and dead links are skipped rather than blowing up the whole crawl.
 */
async function harvestPage(url, hosts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      redirect: "follow",
    });
    if (!resp.ok) return { url, error: `HTTP ${resp.status}` };

    const type = resp.headers.get("content-type") || "";
    if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
      return { url, error: `skipped ${type.split(";")[0]}` };
    }

    const html = await resp.text();
    // resp.url, not url — we may have been redirected, and relative
    // links must resolve against where we actually landed.
    return { url, ...harvestFromHtml(html, resp.url, hosts) };
  } catch (err) {
    return { url, error: err.name === "AbortError" ? "timed out" : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Run `tasks` with a small concurrency cap, reporting progress. */
async function runPool(items, worker, onProgress) {
  const results = [];
  let index = 0;
  let done = 0;

  async function runner() {
    while (index < items.length) {
      const i = index++;
      const result = await worker(items[i]);
      results[i] = result;
      done++;
      onProgress?.(done, items.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, runner)
  );
  return results;
}

function broadcast(message) {
  // The popup may well be closed; that's not an error worth surfacing.
  chrome.runtime.sendMessage(message).catch(() => {});
}

/**
 * Follow `startUrls`, collecting downloads from each page. With depth 2,
 * wrapped links discovered on those pages are followed one level more.
 */
async function crawl(startUrls, options = {}) {
  const settings = await getSettings();
  const hosts = options.hosts ?? settings.fileHosts;
  const depth = Math.min(options.depth ?? settings.crawlDepth, 2);
  const maxPages = options.maxPages ?? settings.maxPages;

  const downloads = new Map();
  const errors = [];
  const visited = new Set();
  let queue = [...new Set(startUrls)];
  let pagesFetched = 0;
  let truncated = false;

  for (let level = 0; level < depth && queue.length; level++) {
    const batch = queue.filter((u) => !visited.has(u));
    queue = [];
    if (!batch.length) break;

    const room = maxPages - pagesFetched;
    if (batch.length > room) {
      truncated = true;
      batch.length = Math.max(room, 0);
    }
    if (!batch.length) break;

    batch.forEach((u) => visited.add(u));

    const results = await runPool(batch, (u) => harvestPage(u, hosts), (done, total) =>
      broadcast({
        type: "CRAWL_PROGRESS",
        done: pagesFetched + done,
        total: pagesFetched + total,
      })
    );
    pagesFetched += batch.length;

    for (const result of results) {
      if (!result) continue;
      if (result.error) {
        errors.push({ url: result.url, error: result.error });
        continue;
      }
      for (const download of result.downloads) {
        if (!downloads.has(download.url)) downloads.set(download.url, download);
      }
      // Worth chasing deeper: wrapped links, and sibling pages in the
      // same folder. Mirror lists use the latter — one page per host,
      // linked plainly — so following only wrapped links stops one hop
      // short of the actual downloads.
      for (const next of [...result.decoded, ...(result.siblings || [])]) {
        if (!visited.has(next)) queue.push(next);
      }
    }
  }

  return {
    downloads: [...downloads.values()],
    pagesFetched,
    errors,
    truncated,
  };
}

/**
 * Send links, following any that aren't downloads themselves.
 *
 * Shortener links frequently resolve to an *intermediate page* rather
 * than a file host — a mirror list where every "Mediafire / Akia / Viki"
 * link wraps the same landing page. Handing that page URL to JDownloader
 * does nothing at all: it has no plugin for an arbitrary web page, so it
 * silently produces no links while the request itself succeeds.
 *
 * So anything we can't recognise as a download gets fetched first and
 * harvested, and what comes back is what gets sent.
 */
async function sendSmart(urls, packageName, referrer) {
  const settings = await getSettings();
  const hosts = settings.fileHosts;

  const direct = [];
  const pages = [];
  for (const url of urls || []) {
    if (classify(url, hosts)) direct.push(url);
    else pages.push(url);
  }

  let harvested = [];
  let pagesFetched = 0;
  if (pages.length) {
    // Two hops by default: a wrapped link typically lands on a mirror
    // *list*, and each mirror is a further page holding the actual host
    // link. One hop stops on the list and finds almost nothing.
    const result = await crawl(pages, { depth: settings.crawlDepth, hosts });
    harvested = result.downloads.map((d) => d.url);
    pagesFetched = result.pagesFetched;
  }

  const all = [...new Set([...direct, ...harvested])];
  if (!all.length) {
    return {
      ok: false,
      error: pages.length
        ? `Followed ${pagesFetched} page(s) but found no downloadable ` +
          `links on them. The page may build its links with JavaScript, ` +
          `or sit behind another gate.`
        : "Nothing to send.",
      followed: pages.length,
    };
  }

  const result = await sendLinks(all, packageName, referrer);
  return {
    ...result,
    direct: direct.length,
    followed: pages.length,
    harvested: harvested.length,
  };
}

/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CRAWL") {
    crawl(message.urls || [], {
      depth: message.depth,
      hosts: message.hosts,
    })
      .then(sendResponse)
      .catch((err) => sendResponse({ downloads: [], errors: [{ error: String(err) }] }));
    return true;
  }
  if (message?.type === "CHECK_JD") {
    checkConnection().then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  if (message?.type === "SEND_TO_JD") {
    sendSmart(message.links, message.packageName, message.referrer).then(
      sendResponse
    );
    return true;
  }
  return false;
});

/* Right-click a link -> send it straight to JDownloader. */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "send-link-to-jd",
    title: "Send link to JDownloader",
    contexts: ["link"],
  });
  chrome.contextMenus.create({
    id: "send-page-to-jd",
    title: "Send all download links on this page to JDownloader",
    contexts: ["page"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "send-link-to-jd" && info.linkUrl) {
    const result = await sendLinks([info.linkUrl], "link-decrypt", info.pageUrl);
    notify(result, 1);
  }

  if (info.menuItemId === "send-page-to-jd" && tab?.id) {
    let summary;
    try {
      summary = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_LINKS" });
    } catch (err) {
      notify({ ok: false, error: "Could not read this page. Try reloading it." });
      return;
    }
    const urls = (summary?.links || []).map((l) => l.url);
    const result = await sendLinks(urls, packageNameFor(tab), tab.url);
    notify(result, urls.length);
  }
});

function packageNameFor(tab) {
  try {
    return new URL(tab.url).hostname.replace(/^www\./, "") || "link-decrypt";
  } catch (err) {
    return "link-decrypt";
  }
}

/* Exposed for the node test harness; unused inside the extension. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { crawl, harvestPage, runPool, sendLinks, sendSmart };
}

function notify(result, count) {
  const message = result.ok
    ? `Sent ${result.count ?? count} link(s) to JDownloader.`
    : result.error;
  chrome.notifications?.create({
    type: "basic",
    iconUrl: "../icons/icon128.png",
    title: result.ok ? "link-decrypt" : "link-decrypt — failed",
    message,
  });
}
