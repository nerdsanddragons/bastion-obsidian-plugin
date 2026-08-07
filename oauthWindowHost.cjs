// Runs natively in Obsidian's Electron MAIN process — loaded via
// @electron/remote's `remote.require(absolutePath)` from socialConnectHost.ts,
// NOT bundled into main.js by esbuild. deploy.mjs copies this file as-is
// next to main.js, same "ships next to main.js, required by an absolute
// path at runtime" pattern node-pty already uses (see esbuild.config.mjs's
// comment on node-pty for why bare `require()` can't resolve it otherwise).
//
// This is the real fix for the nested third-party-SSO popup problem
// (investigated 2026-07-22, documented at length in this file's prior
// history in socialConnectHost.ts): platforms whose login form offers
// "Continue with Google/Apple/Facebook" (X, TikTok, Dribbble all do) open
// that as a nested popup. Two earlier attempts at fixing this — both via
// @electron/remote's *proxied* BrowserWindow/webContents from the renderer
// — called `setWindowOpenHandler` on a remote object and got TikTok's own
// "Failed to open popup window" error, worse than the original escape-to-
// system-browser behavior. The likely cause: setWindowOpenHandler's handler
// must be invoked natively by Electron's internal window-open flow — an
// event-callback API like that doesn't marshal cleanly across
// @electron/remote's cross-process object proxy the way a plain
// promise-returning function call does (which is how this file's own
// openOAuthWindow() export gets called from the renderer — that part
// works fine). Defining the window and its setWindowOpenHandler callback
// entirely here, in the main process itself, removes the cross-process
// marshaling problem outright: Electron calls it natively, in-process,
// exactly like any ordinary Electron app would, and a nested Google/
// Facebook/Apple sign-in popup becomes a real child BrowserWindow instead
// of a detached OS-level browser process — so window.opener.postMessage()
// back to the parent (what these SSO flows rely on) actually works.
const { BrowserWindow } = require("electron");
const crypto = require("crypto");

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Opens `authorizeUrl` in a contained BrowserWindow and resolves once either
 * that window OR any nested popup it spawns navigates to a URL starting
 * with `redirectUriPrefix` — extracting code/state from the query string
 * before the page ever actually loads (that page expects a browser-side
 * Supabase session this window doesn't have), the provider reports an
 * `error` param instead, or the user closes the window without finishing.
 * Return shape matches @bastion/ui's SocialConnectResult exactly (kept as
 * a plain object here rather than importing that type — this file is
 * plain CommonJS with no build step of its own).
 */
function openOAuthWindow(authorizeUrl, redirectUriPrefix) {
  return new Promise((resolve) => {
    // Fresh, in-memory-only partition every call (no "persist:" prefix —
    // discarded once the window closes) so a prior connect attempt's login
    // never silently carries over into this one (Chad hit this live,
    // 2026-07-22, with a stale cached Instagram login and no way to log out
    // from mid-OAuth-error popup chrome).
    const partition = `oauth-${crypto.randomUUID()}`;
    const webPreferences = { nodeIntegration: false, contextIsolation: true, partition };

    const win = new BrowserWindow({ width: 520, height: 720, title: "Connect account", webPreferences });
    win.webContents.setUserAgent(CHROME_UA);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      if (!win.isDestroyed()) win.close();
    };

    const handleNavigation = (event, targetUrl) => {
      if (!targetUrl.startsWith(redirectUriPrefix)) return;
      event.preventDefault();
      const parsed = new URL(targetUrl);
      const code = parsed.searchParams.get("code");
      const state = parsed.searchParams.get("state");
      const error = parsed.searchParams.get("error");
      if (error) finish({ status: "error", message: error });
      else if (code && state) finish({ status: "success", code, state });
      else finish({ status: "error", message: "Missing code/state in the redirect" });
    };

    win.webContents.on("will-redirect", handleNavigation);
    win.webContents.on("will-navigate", handleNavigation);
    win.on("closed", () => finish({ status: "cancelled" }));

    // The actual fix: let a nested "Continue with Google/Facebook/Apple"
    // popup open as a real child window in the SAME partition (so it
    // shares the parent's fresh, logged-out session context) instead of
    // Electron's default of handing it off to the OS's separate browser
    // process. Redirect-interception is attached to any child popup too,
    // in case the popup itself navigates straight to the redirect_uri
    // rather than posting a message back and letting the parent redirect.
    win.webContents.setWindowOpenHandler(() => ({
      action: "allow",
      overrideBrowserWindowOptions: { width: 480, height: 640, webPreferences },
    }));
    win.webContents.on("did-create-window", (childWindow) => {
      childWindow.webContents.setUserAgent(CHROME_UA);
      childWindow.webContents.on("will-redirect", handleNavigation);
      childWindow.webContents.on("will-navigate", handleNavigation);
    });

    win.loadURL(authorizeUrl);
  });
}

module.exports = { openOAuthWindow };
