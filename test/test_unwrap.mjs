/**
 * Test vectors for the JS unwrapper, mirroring tests/test_unwrap.py.
 * Run with: node test/test_unwrap.mjs
 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { extractEmbeddedUrl, unwrapAll } = require("../src/unwrap.js");

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const b64url = (s) =>
  Buffer.from(s, "utf8").toString("base64url");

const CLK_SH =
  "https://clk.sh/full?api=EXAMPLEAPIKEY0000000000000000000000000000" +
  "&url=aHR0cHM6Ly9leGFtcGxlLWRkbC50ZXN0L2FyY2hpdmVzLzQxMzM4&type=2";

const tests = {
  "clk.sh link unwraps to real destination"() {
    assert.equal(
      extractEmbeddedUrl(CLK_SH),
      "https://example-ddl.test/archives/41338"
    );
  },

  "unwrapAll returns destination and chain"() {
    const { url, chain } = unwrapAll(CLK_SH);
    assert.equal(url, "https://example-ddl.test/archives/41338");
    assert.deepEqual(chain, [CLK_SH]);
  },

  "api key param is not mistaken for destination"() {
    assert.ok(
      extractEmbeddedUrl(CLK_SH).startsWith("https://example-ddl.test")
    );
  },

  "base64 without padding"() {
    const target = "https://example.com/a";
    const url = `https://short.test/go?url=${b64(target).replace(/=+$/, "")}`;
    assert.equal(extractEmbeddedUrl(url), target);
  },

  "urlsafe base64 alphabet"() {
    const target = "https://example.com/path?x=1&y=2";
    const url = `https://short.test/go?u=${b64url(target)}`;
    assert.equal(extractEmbeddedUrl(url), target);
  },

  "plain percent-encoded url param"() {
    const url = "https://short.test/out?url=https%3A%2F%2Fexample.com%2Ffile";
    assert.equal(extractEmbeddedUrl(url), "https://example.com/file");
  },

  "alternate param names"() {
    const target = "https://example.com/x";
    for (const name of ["link", "target", "dest", "redirect", "r", "goto"]) {
      const url = `https://short.test/go?${name}=${b64(target)}`;
      assert.equal(extractEmbeddedUrl(url), target, name);
    }
  },

  "unusual param name still found"() {
    const target = "https://example.com/y";
    const url = `https://short.test/go?weirdname=${b64(target)}`;
    assert.equal(extractEmbeddedUrl(url), target);
  },

  "chained wrappers unwrap recursively"() {
    const innerTarget = "https://example.com/final";
    const inner = `https://second.test/go?url=${b64(innerTarget)}`;
    const outer = `https://first.test/go?url=${b64(inner)}`;
    const { url, chain } = unwrapAll(outer);
    assert.equal(url, innerTarget);
    assert.deepEqual(chain, [outer, inner]);
  },

  "returns null when nothing embedded"() {
    assert.equal(extractEmbeddedUrl("https://example.com/plain/page"), null);
    assert.equal(
      extractEmbeddedUrl("https://example.com/page?id=123&sort=asc"),
      null
    );
  },

  "no query string"() {
    assert.equal(extractEmbeddedUrl("https://example.com"), null);
  },

  "does not loop on self reference"() {
    const url = "https://short.test/go?url=https%3A%2F%2Fshort.test%2Fgo";
    const { chain } = unwrapAll(url);
    assert.ok(chain.length <= 2);
  },

  "non-url base64 is ignored"() {
    const url = `https://short.test/go?data=${b64("just some text here")}`;
    assert.equal(extractEmbeddedUrl(url), null);
  },

  "relative or malformed input does not throw"() {
    assert.equal(extractEmbeddedUrl("/relative/path?url=abc"), null);
    assert.equal(extractEmbeddedUrl("not a url at all"), null);
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
