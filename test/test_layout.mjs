/**
 * Guards on the folder Chrome actually loads.
 *
 * The repo root doubles as the unpacked extension directory, which means
 * ordinary project clutter can stop the extension loading entirely.
 * Chrome reserves any file or directory name beginning with "_", and
 * refuses the whole extension if it finds one — including a stray
 * scratch folder that has nothing to do with the extension.
 *
 * Run with: node test/test_layout.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const tests = {
  "no reserved underscore-prefixed names anywhere Chrome will look"() {
    const offenders = [];

    const walk = (dir, rel = "") => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        // Chrome ignores dotfiles; .git in particular is huge and noisy.
        if (entry.name.startsWith(".")) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.name.startsWith("_")) offenders.push(relPath);
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      }
    };
    walk(root);

    assert.deepEqual(
      offenders,
      [],
      `Chrome reserves names starting with "_" and will refuse to load the ` +
        `extension. Rename: ${offenders.join(", ")}`
    );
  },

  "manifest exists at the root Chrome is pointed at"() {
    assert.ok(
      fs.existsSync(path.join(root, "manifest.json")),
      "manifest.json must sit at the repo root, since that's the folder loaded"
    );
  },

  "every file the manifest references is present"() {
    const m = JSON.parse(
      fs.readFileSync(path.join(root, "manifest.json"), "utf8")
    );
    const refs = [
      m.background.service_worker,
      m.action.default_popup,
      m.options_page,
      ...m.content_scripts.flatMap((c) => c.js),
      ...Object.values(m.icons),
      ...Object.values(m.action.default_icon),
    ];
    const missing = refs.filter((r) => !fs.existsSync(path.join(root, r)));
    assert.deepEqual(missing, [], `manifest references missing files`);
  },

  "service worker's importScripts targets exist"() {
    // importScripts paths are relative to the service worker file, and a
    // typo here fails only at runtime, in a console nobody is watching.
    const swPath = "src/background.js";
    const sw = fs.readFileSync(path.join(root, swPath), "utf8");
    const match = sw.match(/importScripts\(([^)]*)\)/);
    if (!match) return;
    const names = [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    assert.ok(names.length > 0, "expected importScripts to list files");
    for (const name of names) {
      const resolved = path.join(root, path.dirname(swPath), name);
      assert.ok(fs.existsSync(resolved), `importScripts("${name}") not found`);
    }
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
