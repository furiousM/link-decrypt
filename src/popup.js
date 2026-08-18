/** Popup: show what was decoded on this page and hand links to JDownloader. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let links = [];
  let followable = [];
  let pageUrl = "";
  let pageTitle = "";

  /**
   * Name the JDownloader package after the release rather than the site,
   * so a multi-part set arrives as one recognisable package instead of
   * a pile of parts under a bare hostname.
   *
   * Page titles are usually "<Release> - <Site blurb>", so keep the
   * leading segment.
   */
  function packageName() {
    const title = (pageTitle || "").split(/\s+[-–|]\s+/)[0].trim();
    if (title.length >= 3) return title.slice(0, 80);
    try {
      return new URL(pageUrl).hostname.replace(/^www\./, "");
    } catch (err) {
      return "link-decrypt";
    }
  }

  /* ----------------------------- helpers ---------------------------- */

  function selectedUrls() {
    return [...document.querySelectorAll("#links input:checked")].map(
      (el) => el.dataset.url
    );
  }

  function refreshSendButton() {
    const count = selectedUrls().length;
    $("send").disabled = count === 0;
    $("send").textContent = count
      ? `Send ${count} link${count === 1 ? "" : "s"} to JDownloader`
      : "Send to JDownloader";
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (err) {
      return "other";
    }
  }

  /**
   * Per-host toggles. A page offering one release across six mirrors
   * would otherwise mean sending all six — several hundred GB of the
   * same game — so this makes picking one host a single click.
   */
  function renderHostFilters() {
    const container = $("host-filters");
    container.textContent = "";

    const counts = new Map();
    for (const link of links) {
      const host = hostOf(link.url);
      counts.set(host, (counts.get(host) || 0) + 1);
    }
    // Only worth showing when there's an actual choice to make.
    if (counts.size < 2) {
      container.classList.add("hidden");
      return;
    }
    container.classList.remove("hidden");

    for (const [host, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      const chip = document.createElement("button");
      chip.className = "host-chip";
      chip.type = "button";
      chip.setAttribute("aria-pressed", "true");
      chip.title = `Toggle all ${host} links`;

      const label = document.createElement("span");
      label.textContent = host;
      const badge = document.createElement("span");
      badge.className = "count";
      badge.textContent = String(count);
      chip.append(label, badge);

      chip.addEventListener("click", () => {
        const on = chip.getAttribute("aria-pressed") !== "true";
        chip.setAttribute("aria-pressed", String(on));
        for (const el of document.querySelectorAll("#links input")) {
          if (hostOf(el.dataset.url) === host) el.checked = on;
        }
        refreshSendButton();
      });

      container.append(chip);
    }
  }

  function renderLinks() {
    const list = $("links");
    list.textContent = "";

    if (!links.length) {
      $("empty-state").classList.remove("hidden");
      $("link-count").textContent = "0";
      $("host-filters").classList.add("hidden");
      refreshSendButton();
      return;
    }

    $("empty-state").classList.add("hidden");
    $("link-count").textContent = String(links.length);

    for (const link of links) {
      const li = document.createElement("li");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      // Everything is checked by default, including unrecognised hosts.
      // Handing a mirror/folder link to JDownloader and letting its host
      // plugins expand it into the individual parts is more reliable than
      // us scraping for them, so the default is to send it and let JD
      // decide. Anything it can't handle just shows as offline.
      checkbox.checked = true;
      checkbox.dataset.url = link.url;
      checkbox.addEventListener("change", refreshSendButton);

      const info = document.createElement("div");
      info.className = "link-info";

      // Prefer the link's text from the page. On a mirror list that's
      // "Akia" / "Viki" / "1File", which is what you actually recognise —
      // the filename is just the hostname for host links, and every row
      // would read the same.
      const name = document.createElement("span");
      name.className = "link-name";
      name.textContent = link.text || link.filename || link.url;

      const url = document.createElement("span");
      url.className = "link-url";
      url.textContent = link.url;

      info.append(name, url);

      // When a link came from a followed page rather than this one, say so.
      if (link.sourcePage && link.sourcePage !== pageUrl) {
        const source = document.createElement("span");
        source.className = "source-note";
        let host = link.sourcePage;
        try {
          host = new URL(link.sourcePage).hostname.replace(/^www\./, "");
        } catch (err) {
          /* keep the raw value */
        }
        source.textContent = `via ${host}`;
        info.append(source);
      }

      const tag = document.createElement("span");
      tag.className = `tag tag--${link.kind}`;
      tag.textContent =
        link.kind === "archive" ? "archive" : link.kind === "host" ? "host" : "?";
      if (link.kind === "unknown") {
        tag.title =
          "Decoded link on an unrecognised host. JDownloader may still " +
          "handle it — or use Follow to look for downloads on it.";
      }

      li.append(checkbox, info, tag);
      list.append(li);
    }

    renderHostFilters();
    refreshSendButton();
  }

  /* ------------------------------ init ------------------------------ */

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function loadPage() {
    const tab = await activeTab();
    if (!tab?.id) return;

    let summary;
    try {
      summary = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_LINKS" });
    } catch (err) {
      // Content script isn't present (chrome:// page, PDF viewer, or the
      // page predates the extension being loaded).
      $("empty-state").textContent =
        "Can't read this page. Reload it, or it may be a restricted page.";
      $("empty-state").classList.remove("hidden");
      return;
    }

    pageUrl = summary?.pageUrl ?? "";
    pageTitle = summary?.pageTitle ?? "";
    $("decoded-count").textContent = String(summary?.decodedCount ?? 0);
    links = summary?.links ?? [];
    followable = summary?.followable ?? [];
    renderLinks();

    if (followable.length) {
      $("followable-count").textContent = String(followable.length);
      $("follow-panel").classList.remove("hidden");
    }

    if (summary?.pageDestination) {
      $("destination-link").textContent = summary.pageDestination;
      $("destination-link").href = summary.pageDestination;
      $("page-destination").classList.remove("hidden");
      $("go-destination").addEventListener("click", () => {
        chrome.tabs.update(tab.id, { url: summary.pageDestination });
        window.close();
      });
    }
  }

  async function checkJd() {
    const status = $("jd-status");
    const result = await chrome.runtime.sendMessage({ type: "CHECK_JD" });
    if (result?.ok) {
      status.textContent = "JD connected";
      status.className = "status status--ok";
      status.title = `${result.endpoint} — ${result.banner}`;
    } else {
      status.textContent = "JD offline";
      status.className = "status status--down";
      status.title = result?.error || "JDownloader is not reachable";
    }
  }

  async function send() {
    const urls = selectedUrls();
    if (!urls.length) return;

    const tab = await activeTab();
    const result = $("result");
    $("send").disabled = true;
    result.textContent = "Sending…";
    result.className = "result";

    const name = packageName();
    const response = await chrome.runtime.sendMessage({
      type: "SEND_TO_JD",
      links: urls,
      packageName: name,
      referrer: tab?.url,
    });

    if (response?.ok) {
      // JD answers "success" even for links its Dupe Manager silently
      // drops, so a send can look fine while nothing appears. Say so
      // rather than let it read as the extension failing.
      result.textContent =
        `Sent ${response.count} link(s) to "${name}". ` +
        `JDownloader skips links it has already grabbed.`;
      result.className = "result result--ok";
    } else {
      result.textContent = response?.error || "Failed to send.";
      result.className = "result result--fail";
    }
    refreshSendButton();
  }

  /* ---------------------------- crawling ---------------------------- */

  function setProgress(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    $("crawl-bar-fill").style.width = `${pct}%`;
    $("crawl-status").textContent = `Fetched ${done} of ${total} page(s)…`;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "CRAWL_PROGRESS") {
      setProgress(message.done, message.total);
    }
  });

  async function follow() {
    const button = $("follow");
    button.disabled = true;
    $("crawl-progress").classList.remove("hidden");
    setProgress(0, followable.length);

    const result = await chrome.runtime.sendMessage({
      type: "CRAWL",
      urls: followable.map((f) => f.url),
    });

    const found = result?.downloads ?? [];
    // Merge, preferring links already on this page.
    const seen = new Set(links.map((l) => l.url));
    const added = found.filter((f) => !seen.has(f.url));
    links = links.concat(added);
    renderLinks();

    const parts = [
      `Found ${added.length} new link(s) across ${result?.pagesFetched ?? 0} page(s).`,
    ];
    if (result?.truncated) parts.push("Page limit reached.");
    if (result?.errors?.length) parts.push(`${result.errors.length} page(s) failed.`);

    $("crawl-status").textContent = parts.join(" ");
    $("crawl-bar-fill").style.width = "100%";
    button.disabled = false;
    button.textContent = "Follow again";
  }

  /* ---------------------------- listeners --------------------------- */

  $("select-all").addEventListener("change", (event) => {
    for (const el of document.querySelectorAll("#links input")) {
      el.checked = event.target.checked;
    }
    // Keep the chips honest about what's actually selected.
    for (const chip of document.querySelectorAll(".host-chip")) {
      chip.setAttribute("aria-pressed", String(event.target.checked));
    }
    refreshSendButton();
  });

  $("send").addEventListener("click", send);
  $("follow").addEventListener("click", follow);

  $("open-options").addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Shown in the header so you can tell at a glance whether a reload
  // actually picked up new code.
  $("version").textContent = "v" + chrome.runtime.getManifest().version;

  loadPage();
  checkJd();
})();
