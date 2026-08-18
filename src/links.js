/**
 * Classify links found on a page: direct archives vs file-host pages.
 *
 * This is the piece the Python scraper is currently weak at. Real DDL
 * pages rarely link straight to a `.rar` — they link to a file host
 * (`https://1fichier.com/?a1b2c3`), which carries no extension at all.
 * JDownloader resolves those itself via its host plugins, so both kinds
 * are worth collecting; we just label them differently so you can see
 * what you're sending.
 */
(function (root) {
  "use strict";

  // Multi-part releases get named several different ways, and missing a
  // scheme means silently dropping half a download set:
  //   Game.part1.rar … Game.part6.rar   (WinRAR, current)
  //   Game.rar, Game.r00 … Game.r99     (WinRAR, old style)
  //   Game.7z.001, Game.001 … Game.NNN  (7-Zip / split volumes)
  //   Game.zip, Game.z01 … Game.z99     (split zip)
  const ARCHIVE_RE =
    /\.(?:rar|r\d{2}|part\d+\.rar|7z|zip|z\d{2}|\d{3}|tar|gz|iso|bin|nfo)$/i;

  // Known one-click file hosts JDownloader has plugins for. Not
  // exhaustive by design — editable in the extension's options.
  const DEFAULT_HOSTS = [
    "1fichier.com", "rapidgator.net", "nitroflare.com", "turbobit.net",
    "uploaded.net", "ul.to", "mega.nz", "mediafire.com", "katfile.com",
    "ddownload.com", "fikper.com", "hitfile.net", "uploadgig.com",
    "gofile.io", "pixeldrain.com", "krakenfiles.com", "send.cm",
    "clicknupload.org", "userscloud.com", "filefactory.com",
    "tezfiles.com", "elitefile.net", "dropgalaxy.com", "file-upload.org",
    "frdl.io", "filerio.in", "anonfiles.com", "bowfile.com",
    "usersdrive.com", "dailyuploads.net", "upload-4ever.com",
    "rosefile.net", "wdupload.com", "isra.cloud", "multiup.io",
    // Hosts commonly used by console-game DDL sites.
    "akirabox.com", "vikingfile.com", "datanodes.to", "buzzheavier.com",
    "letsupload.io", "mixdrop.co", "qiwi.gg", "swisstransfer.com",
    "sendspace.com", "zippyshare.day", "filecrypt.cc", "cosmobox.org",
  ];

  function hostnameOf(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch (err) {
      return "";
    }
  }

  function pathOf(url) {
    try {
      return new URL(url).pathname;
    } catch (err) {
      return "";
    }
  }

  function isArchiveUrl(url) {
    return ARCHIVE_RE.test(pathOf(url));
  }

  function isFileHostUrl(url, hosts) {
    const list = hosts && hosts.length ? hosts : DEFAULT_HOSTS;
    const hostname = hostnameOf(url);
    if (!hostname) return false;
    return list.some(
      (h) => hostname === h || hostname.endsWith("." + h)
    );
  }

  /**
   * Classify a URL. Returns "archive", "host", or null.
   */
  function classify(url, hosts) {
    if (!/^https?:\/\//i.test(url)) return null;
    if (isArchiveUrl(url)) return "archive";
    if (isFileHostUrl(url, hosts)) return "host";
    return null;
  }

  // Link text that means "help with downloading" rather than "the thing
  // to download". DDL pages routinely sit a "Guide Download" and "Tool
  // Download" next to the real mirrors, and they're indistinguishable by
  // URL — only the link text gives them away.
  //
  // Deliberately narrow: word-boundary matched, so a release actually
  // called "Toolbox Simulator" or "Guided Meditation" is unaffected.
  const SUPPORT_TEXT_RE =
    /\b(guide|guides|tutorial|how\s*to|tool|tools|instruction|instructions|readme|faq|support|donate|report|password|mirror\s*list|watch\s*video)\b/i;

  function looksLikeSupportLink(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    return SUPPORT_TEXT_RE.test(value);
  }

  function filenameOf(url) {
    const path = pathOf(url);
    const last = path.split("/").filter(Boolean).pop();
    return last || hostnameOf(url) || url;
  }

  root.LinkDecryptLinks = {
    classify,
    isArchiveUrl,
    isFileHostUrl,
    looksLikeSupportLink,
    filenameOf,
    hostnameOf,
    DEFAULT_HOSTS,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.LinkDecryptLinks;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
