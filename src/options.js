/** Options page: JDownloader endpoint, page behaviour, file-host list. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const { DEFAULT_HOSTS } = globalThis.LinkDecryptLinks;

  const DEFAULTS = {
    jdHost: "127.0.0.1",
    jdPort: 9666,
    rewriteLinks: true,
    showBadges: true,
    fileHosts: [],
  };

  function load() {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      $("jdHost").value = stored.jdHost;
      $("jdPort").value = stored.jdPort;
      $("rewriteLinks").checked = stored.rewriteLinks;
      $("showBadges").checked = stored.showBadges;
      $("fileHosts").value = (
        stored.fileHosts?.length ? stored.fileHosts : DEFAULT_HOSTS
      ).join("\n");
    });
  }

  function parseHosts(text) {
    return text
      .split("\n")
      .map((line) => line.trim().toLowerCase().replace(/^www\./, ""))
      .filter(Boolean);
  }

  function save() {
    const port = parseInt($("jdPort").value, 10);
    const settings = {
      jdHost: $("jdHost").value.trim() || DEFAULTS.jdHost,
      jdPort: Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULTS.jdPort,
      rewriteLinks: $("rewriteLinks").checked,
      showBadges: $("showBadges").checked,
      fileHosts: parseHosts($("fileHosts").value),
    };

    chrome.storage.sync.set(settings, () => {
      const result = $("save-result");
      result.textContent = "Saved. Reload open tabs for page changes to apply.";
      result.className = "result result--ok";
      setTimeout(() => (result.textContent = ""), 4000);
    });
  }

  async function test() {
    const result = $("test-result");
    result.textContent = "Testing…";
    result.className = "result";
    // Save first so the service worker tests what's on screen.
    const port = parseInt($("jdPort").value, 10);
    await chrome.storage.sync.set({
      jdHost: $("jdHost").value.trim() || DEFAULTS.jdHost,
      jdPort: Number.isFinite(port) ? port : DEFAULTS.jdPort,
    });

    const response = await chrome.runtime.sendMessage({ type: "CHECK_JD" });
    if (response?.ok) {
      result.textContent = `Connected — ${response.banner}`;
      result.className = "result result--ok";
    } else {
      result.textContent = response?.error || "Could not connect.";
      result.className = "result result--fail";
    }
  }

  $("save").addEventListener("click", save);
  $("test").addEventListener("click", test);
  $("restore-hosts").addEventListener("click", (event) => {
    event.preventDefault();
    $("fileHosts").value = DEFAULT_HOSTS.join("\n");
  });

  load();
})();
