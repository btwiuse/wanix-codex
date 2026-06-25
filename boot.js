// Boot loader for the Codex-in-Wanix site.
//
// Picks how the guest reaches OpenAI (a purely static page cannot — OpenAI
// omits CORS headers on authenticated responses, so browser JS can't read
// them; see README). Mode order: ?net= > window.NET_MODE (config.js) > "relay".
//   - "proxy": the guest's HTTP is routed through a SAME-ORIGIN Cloudflare
//     Pages Function (functions/openai/*) that proxies to OpenAI server-side.
//     No separate relay server — it deploys with the Pages site. Uses the v86
//     in-browser fetch backend (proxy_origin) + API-key auth.
//   - "relay": the guest does real TLS to OpenAI through a websocket TCP relay
//     (?relay= > window.RELAY_DEFAULT > same-origin; `wanix serve` provides it).
//
// Also: optionally load big assets from R2/CDN (?assets= / window.ASSET_BASE),
// reassemble split parts (split-manifest.json), then import wanix.min.js.

const pageDir = new URL('.', location.href);
const params = new URLSearchParams(location.search);

function netMode() {
    const m = (params.get('net') || window.NET_MODE || 'relay').toLowerCase();
    return (m === 'proxy' || m === 'relay') ? m : 'relay';
}

function resolveRelay() {
    const sameOrigin = (location.protocol === 'https:' ? 'wss://' : 'ws://')
        + location.host + '/.well-known/ethernet';
    return params.get('relay') || window.RELAY_DEFAULT || sameOrigin;
}

// Rewrite large-asset element srcs to an external base (R2/CDN) when configured.
// Only the heavy, cacheable blobs are externalized; the small entry files stay
// on the static host. The external host must send permissive CORS headers
// (Access-Control-Allow-Origin) since wanix fetches these cross-origin.
const EXTERNAL_ASSETS = ['wanix-linux-codex.tgz', 'v86.tgz', 'wanix.wasm'];
function applyAssetBase() {
    const base = params.get('assets') || window.ASSET_BASE;
    // ?fresh=1 appends a cache-busting query to the big assets (dev only; the
    // 85MB rootfs is otherwise heuristically cached by the browser).
    const bust = params.has('fresh') ? ('?b=' + location.search.length + '_' + performance.now().toFixed(0)) : '';
    if (!base && !bust) return;
    const baseUrl = base ? base.replace(/\/?$/, '/') : null;
    for (const el of document.querySelectorAll('wanix-bind[src], wanix-system[wasm]')) {
        for (const attr of ['src', 'wasm']) {
            const v = el.getAttribute(attr);
            if (!v) continue;
            const name = v.split('/').pop();
            if (EXTERNAL_ASSETS.includes(name)) {
                el.setAttribute(attr, (baseUrl ? baseUrl + name : v) + bust);
            }
        }
    }
}

async function installSplitFetch() {
    let manifest;
    try {
        const r = await fetch(new URL('split-manifest.json', pageDir), { cache: 'no-store' });
        if (!r.ok) return;
        manifest = await r.json();
    } catch (e) {
        return; // no manifest: local / unsplit / external-asset deployment
    }
    const files = manifest.files || {};
    if (!Object.keys(files).length) return;

    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        let rel = null;
        try {
            const u = new URL(typeof input === 'string' ? input : input.url, location.href);
            if (u.origin === location.origin && u.pathname.startsWith(pageDir.pathname)) {
                rel = decodeURIComponent(u.pathname.slice(pageDir.pathname.length));
            }
        } catch (e) { /* fall through to the real fetch */ }
        const entry = rel && files[rel];
        if (!entry) {
            return origFetch(input, init);
        }
        const parts = entry.parts;
        let i = 0;
        let reader = null;
        const body = new ReadableStream({
            async pull(controller) {
                while (true) {
                    if (!reader) {
                        if (i >= parts.length) { controller.close(); return; }
                        const resp = await origFetch(new URL(parts[i], pageDir));
                        if (!resp.ok) { controller.error(new Error(`HTTP ${resp.status} fetching ${parts[i]}`)); return; }
                        reader = resp.body.getReader();
                        i++;
                    }
                    const { value, done } = await reader.read();
                    if (done) { reader = null; continue; }
                    controller.enqueue(value);
                    return;
                }
            },
            cancel(reason) { if (reader) reader.cancel(reason); },
        });
        return Promise.resolve(new Response(body, {
            status: 200,
            headers: { 'Content-Type': entry.contentType || 'application/octet-stream' },
        }));
    };
}

function probeRelay(relay) {
    let done = false;
    const warn = () => {
        if (done) return;
        done = true;
        const bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:1000;'
            + 'background:#a33;color:#fff;font:13px/1.5 ui-monospace,Menlo,monospace;padding:8px 14px;';
        bar.innerHTML = 'Network relay unreachable at <code>' + relay + '</code> — '
            + 'the VM boots but has no internet (codex login will fail). Append '
            + '<code>?relay=wss://your-relay/.well-known/ethernet</code> to the URL. '
            + 'See the README for running a relay (`wanix serve`).';
        const close = document.createElement('span');
        close.textContent = ' ✕';
        close.style.cssText = 'cursor:pointer;float:right';
        close.onclick = () => bar.remove();
        bar.appendChild(close);
        document.body.appendChild(bar);
    };
    try {
        const ws = new WebSocket(relay);
        const timer = setTimeout(() => { try { ws.close(); } catch (e) {} warn(); }, 8000);
        ws.onopen = () => { clearTimeout(timer); done = true; try { ws.close(); } catch (e) {} };
        ws.onerror = () => { clearTimeout(timer); warn(); };
    } catch (e) { warn(); }
}

(async function boot() {
    const mode = netMode();
    const vm = document.getElementById('vm');
    let relay = null;

    if (mode === 'proxy') {
        // serverless: route the guest's HTTP through the same-origin Pages
        // Function at /openai/*. proxy_origin is this page's own origin.
        vm.setAttribute('netdev', `user,type=virtio,relay_url=fetch,proxy_origin=${location.origin}`);
        vm.setAttribute('append', 'codexnet=proxy');
    } else {
        relay = resolveRelay();
        vm.setAttribute('netdev', `user,type=virtio,relay_url=${relay}`);
    }

    applyAssetBase();

    // Persist /project to OPFS only when explicitly opted in (?persist=1).
    // wanix's OPFS metadata store can panic the (main-thread) kernel during its
    // background #stat flush — fatal: it takes down the filesystem RPC so VS
    // Code never renders (blank workbench/terminal). Default to a RAM /project
    // (already present from the rootfs) so the site is reliable; persistence is
    // opt-in for those who accept the risk.
    if (!params.has('persist')) {
        const opfsBind = document.querySelector('wanix-bind[dst="project"]');
        if (opfsBind) opfsBind.remove();
    }

    // boot banner
    const status = document.getElementById('boot-status');
    const banner = document.getElementById('boot-banner');
    const sys = document.querySelector('wanix-system');
    sys.addEventListener('ready', () => {
        if (status) status.textContent = 'booting Linux VM + VS Code…';
    });
    const t = setInterval(() => {
        if (document.querySelector('.monaco-workbench')) {
            if (banner) banner.classList.add('hidden');
            clearInterval(t);
            setTimeout(() => banner && banner.remove(), 600);
        }
    }, 500);

    await installSplitFetch();
    await import('./wanix.min.js');

    if (mode === 'relay') probeRelay(relay);
})();
