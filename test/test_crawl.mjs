/**
 * Crawl orchestration tests: depth, dedup, page caps, error handling.
 *
 * background.js is a service worker script, so we stub the handful of
 * chrome.* APIs and importScripts it touches at load time, plus fetch.
 *
 * Run with: node test/test_crawl.mjs
 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/* ------------------------- environment stubs ------------------------ */

globalThis.importScripts = (...files) => {
  for (const f of files) require(path.join(here, "../src", f));
};

let storedSettings = { fileHosts: [], crawlDepth: 1, maxPages: 40 };
globalThis.chrome = {
  storage: { sync: { get: (defaults, cb) => cb({ ...defaults, ...storedSettings }) } },
  runtime: {
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
    sendMessage: () => Promise.resolve(),
  },
  contextMenus: { create() {}, onClicked: { addListener() {} } },
  notifications: { create() {} },
  tabs: { sendMessage: () => Promise.resolve() },
};

/** A fake web: url -> html (or a thrown error / non-html response). */
let site = {};
let fetchLog = [];
globalThis.fetch = async (url) => {
  fetchLog.push(url);
  const entry = site[url];
  if (entry === undefined) throw new Error("ENOTFOUND");
  if (entry.status && entry.status >= 400) {
    return { ok: false, status: entry.status, url };
  }
  return {
    ok: true,
    status: 200,
    url: entry.finalUrl || url,
    headers: { get: () => entry.contentType || "text/html; charset=utf-8" },
    text: async () => entry.html || "",
  };
};

const { crawl, sendLinks, sendSmart } = require("../src/background.js");

/* ------------------------------ tests ------------------------------- */

const tests = {
  async "collects downloads from followed pages"() {
    site = {
      "https://site.test/post/1": {
        html: `<a href="https://1fichier.com/?aaa">p1</a>
               <a href="https://cdn.test/Game.part1.rar">p2</a>`,
      },
    };
    const result = await crawl(["https://site.test/post/1"]);
    const urls = result.downloads.map((d) => d.url).sort();
    assert.deepEqual(urls, [
      "https://1fichier.com/?aaa",
      "https://cdn.test/Game.part1.rar",
    ]);
    assert.equal(result.pagesFetched, 1);
  },

  async "attributes each download to the page it came from"() {
    site = {
      "https://site.test/a": { html: `<a href="https://1fichier.com/?x">x</a>` },
    };
    const result = await crawl(["https://site.test/a"]);
    assert.equal(result.downloads[0].sourcePage, "https://site.test/a");
  },

  async "depth 1 does not follow wrapped links found on fetched pages"() {
    const deep = "https://site.test/deep";
    site = {
      "https://site.test/a": {
        html: `<a href="https://clk.sh/f?url=${b64(deep)}">go deeper</a>`,
      },
      [deep]: { html: `<a href="https://1fichier.com/?deep">deep file</a>` },
    };
    const result = await crawl(["https://site.test/a"], { depth: 1 });
    assert.equal(result.downloads.length, 0);
    assert.equal(result.pagesFetched, 1);
  },

  async "depth 2 follows wrapped links one level further"() {
    const deep = "https://site.test/deep";
    site = {
      "https://site.test/a": {
        html: `<a href="https://clk.sh/f?url=${b64(deep)}">go deeper</a>`,
      },
      [deep]: { html: `<a href="https://1fichier.com/?deep">deep file</a>` },
    };
    const result = await crawl(["https://site.test/a"], { depth: 2 });
    assert.deepEqual(
      result.downloads.map((d) => d.url),
      ["https://1fichier.com/?deep"]
    );
    assert.equal(result.pagesFetched, 2);
  },

  async "never fetches the same page twice"() {
    fetchLog = [];
    site = { "https://site.test/a": { html: "<a href='/x'>x</a>" } };
    await crawl(
      ["https://site.test/a", "https://site.test/a", "https://site.test/a"],
      { depth: 2 }
    );
    assert.equal(fetchLog.filter((u) => u === "https://site.test/a").length, 1);
  },

  async "resolves relative links against the redirected url, not the requested one"() {
    site = {
      "https://site.test/go": {
        finalUrl: "https://mirror.test/post/9/",
        html: `<a href="files/Game.part1.rar">dl</a>`,
      },
    };
    const result = await crawl(["https://site.test/go"]);
    assert.deepEqual(
      result.downloads.map((d) => d.url),
      ["https://mirror.test/post/9/files/Game.part1.rar"],
      "must resolve against mirror.test (where we landed), not site.test"
    );
  },

  async "root-relative links resolve to the landed host"() {
    site = {
      "https://site.test/go": {
        finalUrl: "https://mirror.test/deep/page",
        html: `<a href="/dl/Game.part1.rar">dl</a>`,
      },
    };
    const result = await crawl(["https://site.test/go"]);
    assert.deepEqual(
      result.downloads.map((d) => d.url),
      ["https://mirror.test/dl/Game.part1.rar"]
    );
  },

  async "records errors without aborting the rest of the crawl"() {
    site = {
      "https://site.test/ok": { html: `<a href="https://1fichier.com/?ok">ok</a>` },
      "https://site.test/404": { status: 404 },
    };
    const result = await crawl([
      "https://site.test/404",
      "https://site.test/ok",
      "https://site.test/missing",
    ]);
    assert.equal(result.downloads.length, 1);
    assert.equal(result.errors.length, 2);
  },

  async "skips non-html responses"() {
    site = {
      "https://site.test/file.bin": {
        contentType: "application/octet-stream",
        html: "https://1fichier.com/?shouldnotcount",
      },
    };
    const result = await crawl(["https://site.test/file.bin"]);
    assert.equal(result.downloads.length, 0);
    assert.equal(result.errors.length, 1);
  },

  async "honours the page cap and reports truncation"() {
    site = {};
    const urls = [];
    for (let i = 0; i < 10; i++) {
      const u = `https://site.test/p${i}`;
      urls.push(u);
      site[u] = { html: `<a href="https://1fichier.com/?f${i}">f</a>` };
    }
    const result = await crawl(urls, { maxPages: 4 });
    assert.equal(result.pagesFetched, 4);
    assert.equal(result.truncated, true);
    assert.equal(result.downloads.length, 4);
  },

  async "deduplicates the same download seen on several pages"() {
    site = {
      "https://site.test/a": { html: `<a href="https://1fichier.com/?same">1</a>` },
      "https://site.test/b": { html: `<a href="https://1fichier.com/?same">2</a>` },
    };
    const result = await crawl(["https://site.test/a", "https://site.test/b"]);
    assert.equal(result.downloads.length, 1);
  },

  async "a hanging JDownloader is reported as pending, not as success"() {
    // JD holds the connection open while its "external application tries
    // to add links" prompt is unanswered. Silently hanging there looks
    // identical to a broken extension, so it must surface as pending.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    try {
      const result = await sendLinks(["https://host.test/a.rar"], "pkg", "", {
        timeoutMs: 50,
      });
      assert.equal(result.ok, false);
      assert.equal(result.pending, true);
      assert.match(result.error, /Allow it!/);
    } finally {
      globalThis.fetch = realFetch;
    }
  },

  async "a refused connection is reported as unreachable, not pending"() {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    try {
      const result = await sendLinks(["https://host.test/a.rar"], "pkg");
      assert.equal(result.ok, false);
      assert.notEqual(result.pending, true);
      assert.match(result.error, /Could not reach JDownloader/);
    } finally {
      globalThis.fetch = realFetch;
    }
  },

  async "source identity is stable across pages so JD only prompts once"() {
    // Regression guard: sending the page URL as `source` made JD treat
    // every site as a new application, so "Allow it!" never stuck.
    const realFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, opts) => {
      bodies.push(new URLSearchParams(opts.body));
      return { ok: true, status: 200 };
    };
    try {
      await sendLinks(["https://host.test/a.rar"], "pkg", "https://site-one.test/x");
      await sendLinks(["https://host.test/b.rar"], "pkg", "https://site-two.test/y");
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].get("source"), "link-decrypt");
    assert.equal(
      bodies[0].get("source"),
      bodies[1].get("source"),
      "source must not vary by page, or JD re-prompts on every site"
    );
    // The page URL is still passed, just not as our identity.
    assert.equal(bodies[0].get("referer"), "https://site-one.test/x");
    assert.equal(bodies[1].get("referer"), "https://site-two.test/y");
  },

  async "a link that resolves to a page is followed, not sent to JD raw"() {
    // The real failure: on a mirror list every link resolved to the same
    // landing page. Sending that page URL to JD did nothing at all --
    // JD has no plugin for an arbitrary web page -- while still
    // reporting success.
    const landing = "https://site.test/archives/36331";
    site = {
      [landing]: {
        html: `<a href="https://1fichier.com/?real1">m1</a>
               <a href="https://mediafire.com/file/real2">m2</a>`,
      },
    };
    const posted = [];
    const realFetch = globalThis.fetch;
    const fakeWeb = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("127.0.0.1")) {
        posted.push(new URLSearchParams(opts.body));
        return { ok: true, status: 200 };
      }
      return fakeWeb(url, opts);
    };
    let result;
    try {
      result = await sendSmart([landing], "Solitaire", "https://site.test/game");
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(result.ok, true);
    assert.equal(result.followed, 1, "the page should have been followed");
    assert.equal(result.harvested, 2, "both mirrors should have been found");

    const sent = posted[0].get("urls").split("\n");
    assert.ok(!sent.includes(landing), "the landing page must not be sent to JD");
    assert.deepEqual(sent.sort(), [
      "https://1fichier.com/?real1",
      "https://mediafire.com/file/real2",
    ]);
  },

  async "a real download link is sent straight through without fetching"() {
    fetchLog = [];
    const posted = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("127.0.0.1")) {
        posted.push(new URLSearchParams(opts.body));
        return { ok: true, status: 200 };
      }
      fetchLog.push(url);
      throw new Error("should not fetch a known download");
    };
    let result;
    try {
      result = await sendSmart(["https://1fichier.com/?abc"], "pkg");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(result.ok, true);
    assert.equal(result.followed, 0);
    assert.deepEqual(fetchLog, [], "known downloads must not be crawled");
    assert.equal(posted[0].get("urls"), "https://1fichier.com/?abc");
  },

  async "following a page with no downloads explains itself"() {
    site = { "https://site.test/empty": { html: "<p>nothing here</p>" } };
    const result = await sendSmart(["https://site.test/empty"], "pkg");
    assert.equal(result.ok, false);
    assert.match(result.error, /found no downloadable/i);
  },

  async "reaches mirrors that live one page further on, linked plainly"() {
    // The real shape: a wrapped link lands on a mirror *list*, and each
    // mirror is a further page in the same folder holding the actual
    // host link. Those inner links aren't wrapped, so following only
    // decoded links stopped on the list and found just the one mirror
    // that happened to be linked directly.
    site = {
      "https://ddl.test/archives/34685": {
        html: `
          <a href="/">LINK DOWNLOAD FREE</a>
          <a href="/archives/34681">Rootz</a>
          <a href="/archives/34674">Mediafire</a>
          <a href="/archives/34676">Akia</a>
          <a href="https://1fichier.com/?direct">1File</a>
          <a href="https://other.test/guide-fix-error">Guide</a>`,
      },
      "https://ddl.test/archives/34681": {
        html: `<a href="https://rootz.so/f/rootzfile">Download</a>`,
      },
      "https://ddl.test/archives/34674": {
        html: `<a href="https://www.mediafire.com/file/mf1">Download</a>`,
      },
      "https://ddl.test/archives/34676": {
        html: `<a href="https://akirabox.com/abc123">Download</a>`,
      },
    };

    const result = await crawl(["https://ddl.test/archives/34685"], {
      depth: 2,
      hosts: ["1fichier.com", "rootz.so", "mediafire.com", "akirabox.com"],
    });

    const urls = result.downloads.map((d) => d.url).sort();
    assert.deepEqual(urls, [
      "https://1fichier.com/?direct",
      "https://akirabox.com/abc123",
      "https://rootz.so/f/rootzfile",
      "https://www.mediafire.com/file/mf1",
    ], "every mirror should be found, not just the directly-linked one");
  },

  async "sibling following does not wander off the folder or the site"() {
    fetchLog = [];
    site = {
      "https://ddl.test/archives/100": {
        html: `
          <a href="/">home</a>
          <a href="/about">about</a>
          <a href="/archives/101">mirror</a>
          <a href="https://elsewhere.test/archives/999">offsite</a>`,
      },
      "https://ddl.test/archives/101": { html: `<a href="https://1fichier.com/?x">dl</a>` },
      "https://ddl.test/about": { html: "" },
      "https://elsewhere.test/archives/999": { html: "" },
    };
    await crawl(["https://ddl.test/archives/100"], { depth: 2 });

    assert.ok(fetchLog.includes("https://ddl.test/archives/101"), "same folder is followed");
    assert.ok(!fetchLog.includes("https://ddl.test/about"), "other folders are not");
    assert.ok(!fetchLog.includes("https://ddl.test/"), "the site root is not");
    assert.ok(
      !fetchLog.includes("https://elsewhere.test/archives/999"),
      "other sites are not"
    );
  },

  async "sending nothing is a no-op"() {
    const result = await sendLinks([], "pkg");
    assert.equal(result.ok, false);
  },

  async "empty input is a no-op"() {
    const result = await crawl([]);
    assert.deepEqual(result.downloads, []);
    assert.equal(result.pagesFetched, 0);
  },
};

let passed = 0;
let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}\n  ${err.message}`);
  }
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
