# link-decrypt

A Chrome extension that resolves ad-gated shortener links in place on the
page you're viewing, and forwards downloads to
**[JDownloader 2](https://jdownloader.org/)** without you copying
anything.

```
shortened links on the page  -->  resolved in place  -->  JDownloader 2
```

No build step, no dependencies, no bundler, no telemetry — the files
Chrome loads are the files in this repo.

## Install

1. **Download** the `.zip` from [Releases](../../releases)
2. **Unzip it somewhere permanent** — not Downloads. Chrome reloads it
   from that exact folder every time it starts, so moving it later breaks
   the extension.
3. Open **`chrome://extensions`**
4. Turn on **Developer mode** — toggle, top right
5. Click **Load unpacked** and pick the unzipped `link-decrypt` folder

Done. Then set up JDownloader below.

<details>
<summary>Notes</summary>

Chrome only installs from the Web Store, which is why this is an
"unpacked" extension. Chrome may mention developer-mode extensions on
startup — harmless, and dismissing it doesn't disable anything.

After changing the code, click ↻ on the extension's card in
`chrome://extensions` and reload any open tabs. The version shows in the
popup header, so you can confirm the reload took.
</details>

## JDownloader setup

In **JDownloader 2**: Settings → Advanced Settings → search
`externinterface` → tick **Remote Control / External Interface**.

Then in the extension: click its icon → **Settings** → **Test
connection**. You want `jdownloader=true`.

The first time you send links, JD asks *"An external application tries to
add links"* — click **Allow it!** once and it remembers.

### Several links, one destination

Sites commonly label a row of links by host — *Mediafire · Akia · Viki ·
1File* — while every one of them wraps the **same landing page**. They
look like alternative mirrors and aren't; the real mirrors live on that
page. One click follows it and sends everything it finds, so a second
click has nothing left to add. The badge says `already sent` rather than
appearing to do nothing.

JDownloader then groups the results by filename and size, so if one host
fails it falls back to the others by itself. A host it can't reach shows
up as its own entry — `Blocked by! Cloudflare Site-Protection`, for
instance — which is JD reporting that mirror unavailable, not stray junk.

### If a send reports success but nothing appears

JDownloader's **Dupe Manager** silently drops links it has seen before,
and it answers `success` either way — so the extension has no way to tell
the difference. Two settings control it, both on by default
(**Settings → Advanced Settings**, search `dupe`):

* `GeneralSettings: Dupe Manager` — checks against the **download list**
* `LinkCollector: Dupe Manager` — checks against the **Linkgrabber**

The first one is the surprising one: removing a link from the Linkgrabber
doesn't forget it if it ever reached the download list, so re-sending
that link does nothing, quietly and forever. Test with a link you've
never added, or untick these to allow duplicates.

## What it does

### Resolving links

Many URL shorteners and ad-gateways don't actually hide their
destination — they carry it base64-encoded in a query parameter:

```
https://short.example/full?api=<key>&url=aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdl&type=2
                                        ^ base64 of https://example.com/page
```

Those are resolved with **no network request at all**, which makes them
instant and completely reliable. Handles urlsafe base64, stripped
padding, percent-encoded plain URLs, ~16 common parameter names, and
wrappers nested inside other wrappers.

Resolved links get their `href` rewritten to the real target and a badge
added reading `→ hostname`:

* **click the badge** to send that link straight to JDownloader
* **alt-click** to copy the URL instead

A MutationObserver catches links added after page load, so lazy-loaded
and infinite-scroll pages are covered. Both behaviours are toggleable in
Settings.

If the page *you're on* is itself a wrapped link, the popup offers a
one-click jump to the real destination.

### Sending to JDownloader

The popup lists every downloadable link found, tagged one of three ways:

* `archive` — the URL ends in an archive extension. All the multi-part
  naming schemes are covered, since missing one silently drops half a
  set: `.part1.rar`…`.partN.rar`, `.rar` + `.r00`…`.r99`, `.7z.001`/
  `.001`…, and `.zip` + `.z01`…`.z99`.
* `host` — a known file host.
* `?` — a resolved link on a host that isn't in the list.

That third category matters: no hardcoded host list stays current, and
without it an unrecognised link would vanish from the UI entirely.
Anything you find yourself unticking often is worth adding to the host
list in Settings.

Each row shows the link's **text from the page** rather than a bare
hostname, since when one file is offered across several hosts every row
would otherwise read the same. Above the list, **per-host chips** toggle
all links from one host at once — so choosing which host to pull from is
a single click rather than unticking a dozen boxes.

Links whose text reads like `Guide`, `Tool Download` or `How to install`
are skipped: they sit right beside the real links and are
indistinguishable by URL. The match is word-bounded, so something
genuinely called *Toolbox Simulator* survives.

Everything is ticked by default. **Handing a folder or host link to
JDownloader and letting its host plugins expand it into the individual
files is more reliable than scraping for them ourselves** — JD knows how
to authenticate against hosts, follow their folder APIs, and enumerate a
multi-part set. Anything it can't handle simply shows as offline, which
costs nothing.

Links are packaged under the page's title rather than its hostname, so a
multi-part set arrives as one recognisable package. Nothing starts
downloading until you say so.

There are also right-click options: **Send link to JDownloader** on any
link, and **Send all download links on this page**.

### Following links

Sometimes the page you're on doesn't hold the files — its links point at
*other* pages. When the popup sees resolved links leading to further
pages, it offers **"Follow links & find downloads"**: the service worker
fetches those pages in the background, harvests the downloadable links,
and merges them into the list tagged `via <site>`. Nothing opens a tab
and nothing is downloaded — it only reads HTML.

Two hops by default, because that's the shape these sites actually take:
a wrapped link lands on a mirror *list*, and each mirror on it is a
further page holding the real host link.

```
page you're on          wrapped link, labelled "Rootz"
  └─ /archives/34685    mirror list: Rootz · Mediafire · Akia · Viki · 1File
       └─ /archives/34681   the actual rootz.so link
```

Both wrapped links and **sibling pages** — same site, same folder — are
followed, since those inner mirror links are usually plain hrefs rather
than wrapped ones. Restricting to the same folder is what stops this
becoming a whole-site crawl: it picks up the mirror list and skips the
site root, the nav, and off-site guides. There's a page cap (40 by
default), a 20s per-page timeout, a concurrency limit of 4, and at most
15 siblings per page.

The upshot is that one click collects *every* mirror, so JDownloader can
fall back on its own when one host fails. To pull from a specific host,
use the per-host chips in the popup.

Note that this reads raw HTML, so a host that renders its file list in
JavaScript won't yield individual files this way. Sending the host link
straight to JD is the more reliable path there — which is why it's the
default.

## Publishing a new version

```bash
# bump "version" in manifest.json, then:
git tag v0.4.0 && git push origin v0.4.0
```

CI runs the tests, checks the tag matches `manifest.json`, builds the zip
and publishes it to Releases with install instructions attached.

To build one locally:

```bash
./package.sh     # -> dist/link-decrypt-v<version>.zip
```

That copies only `manifest.json`, `src/` and `icons/` into a clean zip,
plus an `INSTALL.txt`. The repo root doubles as the unpacked extension
folder, so packaging copies what's needed rather than zipping the folder
— otherwise `.git`, the tests and CI config would go along for the ride.

**Worth knowing:** Chrome refuses to install extensions from outside the
Web Store, so a `.crx` file sent to someone will not install — Chrome
blocks it silently. The realistic options are a GitHub Release (what this
repo does) or a Web Store listing, which can be set to *Unlisted* so it
doesn't appear in search and only people with the link can install it.
That costs a one-time $5 developer fee and a review, in exchange for
one-click installs and auto-updates.

## Why the service worker does the sending

A content script inherits the page's origin, so on an `https://` page a
`POST` to `http://127.0.0.1:9666` is blocked as mixed content. The
service worker runs on the extension's own origin, and with
`host_permissions` for `127.0.0.1`/`localhost` its requests bypass CORS.
`http://localhost` also counts as a trustworthy origin, so there's no
mixed-content issue either. That's why `src/background.js` owns all
JDownloader traffic.

It also has no DOM — there is no `DOMParser` in a MV3 background context
— so `src/harvest.js` extracts links from fetched pages with regex rather
than a tree walk. Only `href` attributes and bare URLs are needed, not
structure.

## Layout

```
manifest.json     extension manifest (MV3)
src/              the extension itself
  unwrap.js         resolves links with an embedded destination
  links.js          classifies archive / file-host links
  harvest.js        pulls links out of fetched page HTML
  content.js        rewrites and badges links on the page
  background.js     service worker: JDownloader + crawling
  popup.*           the popup UI
  options.*         settings page
icons/            toolbar icons
test/             node test suites (not shipped)
package.sh        builds dist/link-decrypt-v<version>.zip
```

Because this folder is loaded directly by Chrome, avoid adding anything
named with a leading `_` — Chrome treats those as reserved and refuses to
load the extension. `test/test_layout.mjs` enforces this.

## Tests

No build step and no dependencies:

```bash
node test/test_unwrap.mjs   # resolving wrapped links
node test/test_links.mjs    # archive / file-host classification
node test/test_harvest.mjs  # pulling links out of page HTML
node test/test_crawl.mjs    # depth, dedup, page caps, failures
node test/test_layout.mjs   # the folder still loads as an extension
```

`test_crawl.mjs` stubs `fetch` with a small fake site graph, so the
depth/dedup/cap logic is verified without touching the network.
`test_layout.mjs` earns its place because the repo root *is* the folder
Chrome loads: it fails on reserved `_` names and checks the manifest's
references and the service worker's `importScripts` targets all resolve.
`package.sh` runs it before building, so a broken layout can't be
packaged.

CI runs all five on every push.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | remembers your JD host/port and the file-host list |
| `contextMenus` | the two right-click menu entries |
| `notifications` | reports success/failure of right-click sends |
| `activeTab` | lets the popup read links from the tab you're looking at |
| `http://127.0.0.1/*`, `http://localhost/*` | talking to JDownloader |
| `http://*/*`, `https://*/*` | fetching followed pages to harvest their links |
| content script on `http`/`https` | resolving links on the page you're viewing |

The broad host permission is what makes following links possible —
reading another page's HTML cross-origin requires it. It is only ever
used for pages you explicitly ask it to follow.

## Security

Installing an unpacked extension means trusting it with every page you
visit, so here is exactly what this one does and doesn't do. All of it is
checkable against the source in a couple of minutes — there's no build
step, so what's in `src/` is what runs.

* **No remote code.** Nothing is fetched and executed. No `eval`, no
  `new Function`, no remotely-loaded scripts. MV3's default policy
  forbids it and nothing here tries to work around that.
* **No `innerHTML` anywhere.** Link text and hostnames come from pages
  you visit, i.e. from untrusted input. Every one of them is rendered
  with `textContent`, so a page can't inject markup into the badge or
  the popup.
* **No analytics, no telemetry, no phoning home.** The only outbound
  requests are to your own JDownloader on `127.0.0.1:9666`, and to pages
  you explicitly ask it to follow.
* **Nothing exposed to web pages.** No `web_accessible_resources` and no
  `externally_connectable`, so a website can't reach into the extension
  or talk to its service worker.
* **Credentials are never sent** when following pages (`credentials:
  "omit"`), so your cookies for those sites aren't attached.
* **Settings stay local**, in `chrome.storage`.

The one thing worth weighing before you install: the content script runs
on every `http`/`https` page in order to spot wrapped links, and the host
permission lets the service worker fetch pages you tell it to follow.
That's a real level of access. It's the minimum this can work with, but
it *is* broad, and you should be comfortable with that — or read
`src/content.js` and `src/background.js`, which are about 400 lines
between them.

## Disclaimer

This resolves links and forwards URLs to your own JDownloader instance.
It hosts, mirrors and distributes nothing. You are responsible for what
you download and for complying with the terms of any site you point it
at, and with applicable copyright law.

## Licence

MIT — see [LICENSE](LICENSE).
