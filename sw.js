// Service Worker for 館山ジビエセンター アプリ
// v4: 同一オリジンのGETだけを扱う（Supabase等のAPIには一切さわらない）。
//     正常応答(res.ok)のみキャッシュし、404などのエラー応答は残さない。
//     画面(HTML)はブラウザHTTPキャッシュを迂回して必ず最新を取得（更新が反映されない問題の対策）。
const CACHE = 'gibier-v4';
const STATIC_ASSETS = ['manual-app.html', 'manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC_ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // 旧キャッシュ（誤って保存された404などを含む）をここで破棄する
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function cachePut(req, res) {
  if (!res || !res.ok) return res;   // 404・500などは保存しない
  const copy = res.clone();
  caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  // 登録・更新（POST/PATCH等）と、Supabaseなど外部ドメインへの通信は素通しにする
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;

  const isPage = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');

  if (isPage) {
    // 画面は必ずネットワーク優先。かつブラウザのHTTPキャッシュを迂回(no-store)して常に最新を取得する。
    // （network-firstでも fetch がHTTPキャッシュの古いHTMLを返すと更新が反映されないため）。
    // つながらないときだけキャッシュを出す。
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then(res => cachePut(req, res))
        .catch(() => caches.match(req).then(c => c || caches.match('manual-app.html')))
    );
    return;
  }

  // 静的ファイルはキャッシュ優先
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => cachePut(req, res)))
  );
});
