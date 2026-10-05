/* İzlence TMDB ara sunucusu (Cloudflare Worker)
   Kendi TMDB anahtarını girmeyen kullanıcıların istekleri buradan geçer.
   - Anahtar Worker gizlisinde durur (TMDB_KEY), istemciye hiç gitmez.
   - Yalnızca uygulamanın kullandığı GET uçlarına izin verilir.
   - Hiçbir şey kaydedilmez/loglanmaz; yanıtlar Cloudflare kenar önbelleğinde
     kısa süre tutulur (aynı arama tekrar TMDB'ye gitmesin).
   - CORS yalnızca uygulamanın kendi adreslerine açık. */

const TMDB = 'https://api.themoviedb.org/3';

const ORIGINS = new Set([
  'https://izlence.web.app',
  'https://izlence.firebaseapp.com',
  'http://localhost:8765',
]);

// uygulamanın çağırdığı uçlar (app.js ile birlikte güncel tutulmalı)
const ALLOW = [
  /^\/search\/(multi|movie|tv|person|collection|keyword)$/,
  /^\/find\/tt\d+$/,
  /^\/(movie|tv)\/\d+$/,
  /^\/(movie|tv)\/\d+\/recommendations$/,
  /^\/person\/\d+\/combined_credits$/,
  /^\/collection\/\d+$/,
  /^\/genre\/(movie|tv)\/list$/,
  /^\/discover\/(movie|tv)$/,
  /^\/trending\/all\/week$/,
  /^\/watch\/providers\/(movie|tv)$/,
  /^\/configuration$/,
];

// arama ve trend çabuk değişir; detaylar daha uzun tutulabilir
const ttlFor = (path) => (/^\/(search|trending|discover)/.test(path) ? 3600 : 6 * 3600);

function cors(origin) {
  const h = { 'Vary': 'Origin' };
  if (ORIGINS.has(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

const json = (status, body, origin) => new Response(JSON.stringify(body), {
  status,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors(origin)),
});

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'GET') return json(405, { status_message: 'Yalnızca GET' }, origin);

    // Tarayıcıdan gelen her istek Origin taşır; başka sitelerin anahtarımızı
    // kullanmasını engeller. (Tarayıcı dışı kötüye kullanıma karşı tam koruma
    // değildir; kenar önbelleği ve TMDB'nin kendi sınırı ikinci katman.)
    if (!ORIGINS.has(origin)) return json(403, { status_message: 'İzin verilmeyen kaynak' }, origin);

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/3(?=\/)/, '');
    if (!ALLOW.some((re) => re.test(path))) return json(404, { status_message: 'Bilinmeyen uç' }, origin);
    if (!env.TMDB_KEY) return json(500, { status_message: 'Sunucu anahtarı ayarlanmamış' }, origin);

    // önbellek anahtarı: yol + sıralı parametreler (anahtar ve Origin hariç)
    const params = new URLSearchParams(url.search);
    params.delete('api_key');
    params.sort();
    const cacheKey = new Request('https://cache.izlence/' + path + '?' + params.toString());
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const r = new Response(hit.body, hit);
      Object.entries(cors(origin)).forEach(([k, v]) => r.headers.set(k, v));
      r.headers.set('X-Cache', 'HIT');
      return r;
    }

    const up = new URL(TMDB + path);
    params.forEach((v, k) => up.searchParams.set(k, v));
    const key = env.TMDB_KEY;
    const headers = { Accept: 'application/json' };
    if (key.startsWith('eyJ') || key.length > 60) headers.Authorization = 'Bearer ' + key;
    else up.searchParams.set('api_key', key);

    let res;
    try { res = await fetch(up, { headers }); }
    catch (e) { return json(502, { status_message: 'TMDB’ye ulaşılamadı' }, origin); }

    const body = await res.text();
    const out = new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': res.ok ? 'public, max-age=' + ttlFor(path) : 'no-store',
      },
    });
    if (res.ok) ctx.waitUntil(cache.put(cacheKey, out.clone()));
    Object.entries(cors(origin)).forEach(([k, v]) => out.headers.set(k, v));
    out.headers.set('X-Cache', 'MISS');
    return out;
  },
};
