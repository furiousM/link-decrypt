/**
 * Harvesting tests, using markup shaped like real DDL / warez pages.
 * Run with: node test/test_harvest.mjs
 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
require("../src/unwrap.js");
require("../src/links.js");
const { extractLinks, harvestFromHtml } = require("../src/harvest.js");

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const PAGE = "https://example-ddl.test/archives/41338";

// The shape these pages actually take: a mix of navigation chrome,
// wrapped links, direct part files, and host links with no extension.
const REAL_ISH_HTML = `
<html><body>
  <nav><a href="/">Home</a><a href="/archives">Archives</a></nav>
  <div class="entry">
    <h2>Some Game (PS3)</h2>
    <p>Download links:</p>
    <a href="https://1fichier.com/?ab12cd34">Part 1</a>
    <a href='https://rapidgator.net/file/9f8e7d/Game.part2.rar.html'>Part 2</a>
    <a href=https://nitroflare.com/view/AABBCC/Game.part3.rar>Part 3</a>
    <a href="https://cdn.example.com/direct/Game.part4.rar">Part 4 (direct)</a>
    <a href="/relative/path/Game.part5.rar">Part 5 (relative)</a>
    <a href="https://clk.sh/full?api=KEY&amp;url=${b64("https://katfile.com/xyz789")}&amp;type=2">Part 6 (wrapped)</a>
    <a href="https://example.com/how-to-download">How to download</a>
  </div>
  <script>var mirror = "https://mediafire.com/file/qqq111";</script>
</body></html>
`;

const tests = {
  "extracts hrefs in all three quoting styles"() {
    const links = extractLinks(REAL_ISH_HTML, PAGE);
    assert.ok(links.includes("https://1fichier.com/?ab12cd34"), "double quoted");
    assert.ok(
      links.includes("https://rapidgator.net/file/9f8e7d/Game.part2.rar.html"),
      "single quoted"
    );
    assert.ok(
      links.includes("https://nitroflare.com/view/AABBCC/Game.part3.rar"),
      "unquoted"
    );
  },

  "resolves relative urls against the page"() {
    const links = extractLinks(REAL_ISH_HTML, PAGE);
    assert.ok(
      links.includes("https://example-ddl.test/relative/path/Game.part5.rar")
    );
  },

  "decodes html entities in urls"() {
    // &amp; must become & or the wrapped link won't parse
    const { downloads } = harvestFromHtml(REAL_ISH_HTML, PAGE);
    assert.ok(
      downloads.some((d) => d.url === "https://katfile.com/xyz789"),
      "wrapped link with &amp; should unwrap to katfile"
    );
  },

  "finds bare urls inside script tags"() {
    const { downloads } = harvestFromHtml(REAL_ISH_HTML, PAGE);
    assert.ok(downloads.some((d) => d.url === "https://mediafire.com/file/qqq111"));
  },

  "classifies hosts and archives, ignores ordinary pages"() {
    const { downloads } = harvestFromHtml(REAL_ISH_HTML, PAGE);
    const urls = downloads.map((d) => d.url);

    assert.ok(urls.includes("https://1fichier.com/?ab12cd34"));
    assert.ok(urls.includes("https://cdn.example.com/direct/Game.part4.rar"));
    // navigation and article links must not be collected
    assert.ok(!urls.includes("https://example.com/how-to-download"));
    assert.ok(!urls.includes("https://example-ddl.test/"));
    assert.ok(!urls.includes("https://example-ddl.test/archives"));
  },

  "tags each download with the page it came from"() {
    const { downloads } = harvestFromHtml(REAL_ISH_HTML, PAGE);
    assert.ok(downloads.length > 0);
    assert.ok(downloads.every((d) => d.sourcePage === PAGE));
  },

  "reports decoded wrapped links separately"() {
    const { decoded } = harvestFromHtml(REAL_ISH_HTML, PAGE);
    assert.ok(decoded.includes("https://katfile.com/xyz789"));
  },

  "deduplicates repeated links"() {
    const html = `
      <a href="https://1fichier.com/?dup">a</a>
      <a href="https://1fichier.com/?dup">b</a>
    `;
    const { downloads } = harvestFromHtml(html, PAGE);
    assert.equal(downloads.filter((d) => d.url === "https://1fichier.com/?dup").length, 1);
  },

  "wrapped link pointing at a plain page is decoded but not downloaded"() {
    const inner = "https://example-ddl.test/archives/999";
    const html = `<a href="https://clk.sh/full?url=${b64(inner)}">next</a>`;
    const { downloads, decoded } = harvestFromHtml(html, PAGE);
    assert.deepEqual(decoded, [inner]);
    assert.equal(downloads.length, 0);
  },

  "custom host list is honoured"() {
    const html = `<a href="https://myhost.test/f/1">x</a>`;
    assert.equal(harvestFromHtml(html, PAGE).downloads.length, 0);
    assert.equal(
      harvestFromHtml(html, PAGE, ["myhost.test"]).downloads.length,
      1
    );
  },

  "empty and malformed html do not throw"() {
    assert.deepEqual(harvestFromHtml("", PAGE).downloads, []);
    assert.deepEqual(harvestFromHtml("<a href=>< broken", PAGE).downloads, []);
  },
};

let passed = 0;
let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}\n  ${err.message}`);
  }
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
