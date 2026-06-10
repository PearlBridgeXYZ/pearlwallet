// Iframe bust. CSP `frame-ancestors` lives in public/_headers (the
// Cloudflare deploy enforces it) but a non-CF mirror — local static
// server, IPFS gateway, S3 bucket — would not serve those headers
// and a malicious page could embed wallet.pearlbridge.xyz in a hidden iframe
// to overlay/click-jack the unlock or send confirm. Loaded as an
// external script with `script-src 'self'` so the wallet's own CSP
// doesn't block it on non-CF deploys (v0.1.8 audit Opus2 H-1).
(function () {
  try {
    if (window.top !== window.self) {
      // textContent + new element only — no raw HTML injection sink.
      // Hardened against any future content reflection that might land
      // here.
      var html = document.documentElement;
      while (html.firstChild) html.removeChild(html.firstChild);
      var body = document.createElement("body");
      body.setAttribute(
        "style",
        "background:#fff;color:#111;font-family:system-ui,sans-serif;padding:2rem",
      );
      var h1 = document.createElement("h1");
      h1.setAttribute("style", "font-size:18px");
      h1.textContent = "PearlWallet cannot run inside an iframe.";
      var p = document.createElement("p");
      p.setAttribute("style", "font-size:14px");
      p.textContent = "Open wallet.pearlbridge.xyz directly in a new tab.";
      body.appendChild(h1);
      body.appendChild(p);
      html.appendChild(body);
      throw new Error("PearlWallet refused to run framed");
    }
  } catch (e) {
    // Cross-origin access to window.top throws SecurityError —
    // that itself proves we're framed.
    if (
      e &&
      (e.name === "SecurityError" || /framed/.test(String(e.message)))
    ) {
      var html2 = document.documentElement;
      while (html2.firstChild) html2.removeChild(html2.firstChild);
      var body2 = document.createElement("body");
      body2.setAttribute(
        "style",
        "background:#fff;color:#111;font-family:system-ui,sans-serif;padding:2rem",
      );
      var h12 = document.createElement("h1");
      h12.setAttribute("style", "font-size:18px");
      h12.textContent = "PearlWallet cannot run inside an iframe.";
      body2.appendChild(h12);
      html2.appendChild(body2);
      throw e;
    }
  }
})();
