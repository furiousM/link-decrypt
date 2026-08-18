# Changelog

What changed in each release, newest first.

## v0.7.0

**Hovering a badge now explains what it does.** It shows that clicking
sends the download to JDownloader, what the destination is, and that
alt-clicking copies the address.

**The manual route is now visible.** Clicking the link text itself has
always opened the decoded destination — the `href` is rewritten in place
— but nothing said so. If you can't get JDownloader working, or just want
to fetch a file by hand, the tooltip now points that out.

Built as its own tooltip rather than the browser's `title` attribute,
which proved unreliable on pages that run their own hover handling — it
showed a help cursor and nothing else.

## v0.6.1

**Links on unrecognised hosts no longer fail.** A download link on a host
missing from the built-in list was treated as an ordinary page: fetched,
found to contain no links — because the page *is* the download — and the
whole send failed, even when JDownloader had a working plugin for that
host.

Now, if following a link turns up nothing, the original link goes to
JDownloader anyway. It knows hundreds of hosts, far more than any list
kept here, so it decides; a link it truly can't handle simply shows as
offline. Recognising a host is a nicety now, not a requirement.

Also adds `rootz.so`, `filekeeper.net` and a few other hosts.

## v0.6.0

**Finds every mirror, not just one.** These sites nest deeper than they
appear: a shortened link lands on a mirror *list*, and each entry on it —
Rootz, Mediafire, Akia, Viki — is a plain link to a further page holding
the actual host link. Only wrapped links were followed, so the crawl
stopped on the list and collected the single mirror that happened to be
linked directly. A title with five mirrors looked like it had one.

Pages in the same folder as the page being followed are now collected
too. Same-folder is what stops this becoming a whole-site crawl — it
takes the mirror list and leaves the site root, nav and off-site guides
alone.

## Earlier

The first public release. Resolves shortener links that carry their
destination base64-encoded in a query parameter, rewrites and badges them
on the page, follows links that resolve to a page rather than a file, and
hands what it finds to JDownloader 2 — packaged under the page title,
with per-host filtering and every multi-part archive naming scheme
covered.
