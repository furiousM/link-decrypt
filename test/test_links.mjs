/**
 * Test vectors for link classification.
 * Run with: node test/test_links.mjs
 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { classify, isArchiveUrl, isFileHostUrl, filenameOf, looksLikeSupportLink } =
  require("../src/links.js");

const tests = {
  "direct .rar is an archive"() {
    assert.equal(classify("https://cdn.test/My.Game.rar"), "archive");
  },

  "multipart archives are archives"() {
    assert.equal(classify("https://cdn.test/g.part1.rar"), "archive");
    assert.equal(classify("https://cdn.test/g.r00"), "archive");
    assert.equal(classify("https://cdn.test/g.7z"), "archive");
  },

  "every multi-part naming scheme is covered"() {
    // A 6-part release must be caught whichever convention it uses,
    // otherwise half the set is silently dropped.
    const schemes = {
      "WinRAR current": ["g.part1.rar", "g.part2.rar", "g.part6.rar"],
      "WinRAR old": ["g.rar", "g.r00", "g.r01", "g.r04"],
      "7-Zip split": ["g.7z.001", "g.7z.002", "g.7z.006"],
      "bare split": ["g.001", "g.002", "g.006"],
      "split zip": ["g.zip", "g.z01", "g.z02"],
    };
    for (const [scheme, names] of Object.entries(schemes)) {
      for (const name of names) {
        assert.equal(
          classify("https://cdn.test/" + name),
          "archive",
          `${scheme}: ${name}`
        );
      }
    }
  },

  "zero-padded part numbers work"() {
    assert.equal(classify("https://cdn.test/g.part01.rar"), "archive");
    assert.equal(classify("https://cdn.test/g.part001.rar"), "archive");
  },

  "ordinary file extensions are not mistaken for archives"() {
    for (const name of ["a.html", "a.php", "a.jpg", "a.png", "a.css", "a.js"]) {
      assert.equal(classify("https://cdn.test/" + name), null, name);
    }
  },

  "file hosts are detected without any extension"() {
    // This is the case the Python scraper misses.
    assert.equal(classify("https://1fichier.com/?a1b2c3"), "host");
    assert.equal(classify("https://rapidgator.net/file/abc123/x.html"), "host");
    assert.equal(classify("https://www.mediafire.com/file/xyz"), "host");
  },

  "subdomains of known hosts count"() {
    assert.equal(classify("https://dl2.rapidgator.net/file/abc"), "host");
  },

  "ordinary links are ignored"() {
    assert.equal(classify("https://example.com/about"), null);
    assert.equal(classify("https://example.com/page.html"), null);
  },

  "non-http schemes are ignored"() {
    assert.equal(classify("mailto:someone@example.com"), null);
    assert.equal(classify("javascript:void(0)"), null);
    assert.equal(classify("magnet:?xt=urn:btih:abc"), null);
  },

  "custom host list overrides the default"() {
    assert.equal(isFileHostUrl("https://myhost.test/f/1", ["myhost.test"]), true);
    // 1fichier is not in the custom list, so it should no longer match
    assert.equal(isFileHostUrl("https://1fichier.com/?x", ["myhost.test"]), false);
  },

  "filename extraction"() {
    assert.equal(filenameOf("https://cdn.test/dir/My.Game.part1.rar"), "My.Game.part1.rar");
    // hosts with no path fall back to the hostname
    assert.equal(filenameOf("https://1fichier.com/?a1b2c3"), "1fichier.com");
  },

  "support links are recognised by their text"() {
    // These sit next to the real mirrors on DDL pages and are
    // indistinguishable by URL.
    for (const text of [
      "Guide Download",
      "Tool Download",
      "How to download",
      "How To Install",
      "Instructions",
      "FAQ",
      "Password",
      "Watch Video",
      "Support",
      "Donate",
    ]) {
      assert.equal(looksLikeSupportLink(text), true, text);
    }
  },

  "real mirror labels are not mistaken for support links"() {
    for (const text of [
      "Akia", "Viki", "Rootz", "FileK", "1File", "Mediafire", "Lets", "Data",
      "Download", "Part 1", "PPSA18463 - JPN",
    ]) {
      assert.equal(looksLikeSupportLink(text), false, text);
    }
  },

  "support matching is word-bounded, not substring"() {
    // A release genuinely called this must survive the filter.
    assert.equal(looksLikeSupportLink("Toolbox Simulator"), false);
    assert.equal(looksLikeSupportLink("Guided Meditation VR"), false);
    assert.equal(looksLikeSupportLink("Supported Platforms Update"), false);
  },

  "empty or missing text is not a support link"() {
    assert.equal(looksLikeSupportLink(""), false);
    assert.equal(looksLikeSupportLink(null), false);
    assert.equal(looksLikeSupportLink(undefined), false);
  },

  "malformed urls do not throw"() {
    assert.equal(isArchiveUrl("not a url"), false);
    assert.equal(classify("://broken"), null);
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
