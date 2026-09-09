/* ==========================================================================
   İzlence — Film takip / öneri / analiz PWA
   Veri: TMDB API (v3 key veya v4 read token). Depolama: localStorage.
   ========================================================================== */

'use strict';

const LS = { key: 'izlence.apikey', lang: 'izlence.lang', db: 'izlence.db' };
const IMG = 'https://image.tmdb.org/t/p/';
const TMDB = 'https://api.themoviedb.org/3';

/* uygulama kimligi */
const APP = {
  name: 'Izlence',
  version: '1.6.3',
  build: '2026-09-09',
  developer: 'kamilsaim',
  site: 'https://izlence.web.app',
};

/* ---------------------------------- state -------------------------------- */

const DEFAULT_DB = { version: 1, movies: {}, genres: {}, collections: {}, updatedAt: null };

LS.providers = 'izlence.providers';   // secili yayin platformlari

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadDB() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS.db) || 'null');
    if (raw && raw.movies) return Object.assign({}, DEFAULT_DB, raw);
  } catch (e) { console.warn('DB okunamadı', e); }
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}
let db = loadDB();
if (!db.collections) db.collections = {}; // eski yedeklerde bu alan yok
function saveDB() {
  db.updatedAt = new Date().toISOString();
  localStorage.setItem(LS.db, JSON.stringify(db));
  renderCounts();
}

const getKey = () => (localStorage.getItem(LS.key) || '').trim();
const getLang = () => localStorage.getItem(LS.lang) || 'tr-TR';

/* ---------------------------------- utils -------------------------------- */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const year = (d) => (d && d.length >= 4 ? d.slice(0, 4) : '—');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ---------------------------------- TMDB --------------------------------- */

class ApiError extends Error {}

async function tmdb(path, params = {}) {
  const key = getKey();
  if (!key) throw new ApiError('TMDB anahtarı yok. Ayarlar sekmesinden ekle.');

  const url = new URL(TMDB + path);
  url.searchParams.set('language', getLang());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const headers = {};
  const isV4 = key.startsWith('eyJ') || key.length > 60; // JWT read-access token
  if (isV4) headers.Authorization = 'Bearer ' + key;
  else url.searchParams.set('api_key', key);

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    throw new ApiError('Ağa ulaşılamıyor. İnternet bağlantını kontrol et (çevrimdışıyken listelerin ve analizlerin çalışır).');
  }
  if (res.status === 401) throw new ApiError('Anahtar geçersiz (401). Ayarlar’dan TMDB anahtarını kontrol et.');
  if (res.status === 429) throw new ApiError('Çok fazla istek (429). Birkaç saniye sonra tekrar dene.');
  if (!res.ok) throw new ApiError('TMDB hatası: ' + res.status);
  return res.json();
}

async function ensureGenres() {
  if (Object.keys(db.genres).length) return db.genres;
  const [mv, tv] = await Promise.all([
    tmdb('/genre/movie/list'),
    tmdb('/genre/tv/list').catch(() => ({ genres: [] })),
  ]);
  db.genres = {};
  (mv.genres || []).concat(tv.genres || []).forEach((g) => { db.genres[g.id] = g.name; });
  saveDB();
  return db.genres;
}
const genreName = (id) => db.genres[id] || ('Tür ' + id);

/* ----------------------------- film / dizi tipi --------------------------
   TMDB'de film ve dizi kimlikleri çakışabilir (movie 1399 ile tv 1399 ayrı
   yapımlardır). Bu yüzden depolama anahtarı: film -> "550", dizi -> "tv-1399". */

function norm(x, forced) {
  if (!x) return x;
  const t = forced || x.mtype || x.media_type ||
    ((x.first_air_date || x.number_of_seasons || (x.name && !x.title)) ? 'tv' : 'movie');
  const o = Object.assign({}, x);
  o.mtype = t;
  o.title = x.title || x.name || '';
  o.original_title = x.original_title || x.original_name || '';
  o.release_date = x.release_date || x.first_air_date || '';
  o.key = (t === 'tv' ? 'tv-' : '') + x.id;
  if (t === 'tv') {
    if (x.number_of_seasons) o.seasons = x.number_of_seasons;
    if (x.number_of_episodes) o.episodes = x.number_of_episodes;
    if (Array.isArray(x.episode_run_time) && x.episode_run_time.length) o.epRuntime = x.episode_run_time[0];
  }
  return o;
}
const keyOf = (m) => m.key || ((m.mtype === 'tv' ? 'tv-' : '') + m.id);
const parseKey = (k) => (String(k).indexOf('tv-') === 0
  ? { type: 'tv', id: String(k).slice(3) }
  : { type: 'movie', id: String(k) });
const typeLabel = (m) => (m.mtype === 'tv' ? 'Dizi' : 'Film');
// dizide süre: bölüm süresi x bölüm sayısı (bilinmiyorsa 45 dk varsayılır)
const minutesOf = (m) => (m.mtype === 'tv'
  ? (m.episodes ? (m.epRuntime || 45) * m.episodes : 0)
  : (m.runtime || 0));

/* --------------------------- library operations -------------------------- */

const LIST_LABEL = { watched: 'İzlediklerim', favorite: 'Favoriler', watchlist: 'İzleyeceklerim' };

function entry(id) { return db.movies[id]; }

function upsert(raw, patch) {
  const movie = norm(raw);
  const id = movie.key;
  const cur = db.movies[id] || {
    id: movie.id,
    key: id,
    mtype: movie.mtype,
    title: movie.title,
    original_title: movie.original_title,
    poster_path: movie.poster_path || null,
    backdrop_path: movie.backdrop_path || null,
    release_date: movie.release_date || '',
    genre_ids: movie.genre_ids || (movie.genres || []).map((g) => g.id),
    vote_average: movie.vote_average || 0,
    runtime: movie.runtime || null,
    overview: movie.overview || '',
    directors: movie.directors || [],
    cast: movie.cast || [],
    lists: { watched: false, favorite: false, watchlist: false },
    myRating: null,
    note: '',
    addedAt: new Date().toISOString(),
  };
  // yeni detay verisi geldiyse zenginleştir
  if (movie.runtime) cur.runtime = movie.runtime;
  if (movie.genres && movie.genres.length) cur.genre_ids = movie.genres.map((g) => g.id);
  if (movie.directors && movie.directors.length) cur.directors = movie.directors;
  if (movie.cast && movie.cast.length) cur.cast = movie.cast;
  if (movie.backdrop_path) cur.backdrop_path = movie.backdrop_path;
  if (movie.overview) cur.overview = movie.overview;
  if (movie.seasons) cur.seasons = movie.seasons;
  if (movie.episodes) cur.episodes = movie.episodes;
  if (movie.epRuntime) cur.epRuntime = movie.epRuntime;
  cur.mtype = cur.mtype || movie.mtype;
  cur.key = id;

  Object.assign(cur, patch);
  db.movies[id] = cur;

  const any = cur.lists.watched || cur.lists.favorite || cur.lists.watchlist;
  if (!any && !cur.myRating && !cur.note) delete db.movies[id];

  saveDB();
  return db.movies[id];
}

function toggleList(movie, list) {
  const cur = entry(keyOf(norm(movie)));
  const on = !(cur && cur.lists[list]);
  const lists = Object.assign({ watched: false, favorite: false, watchlist: false }, cur && cur.lists);
  lists[list] = on;
  // "izledim" ile "izleyeceğim" birbirini dışlar
  if (list === 'watched' && on) lists.watchlist = false;
  if (list === 'watchlist' && on) lists.watched = false;
  upsert(movie, { lists });
  toast(on ? LIST_LABEL[list] + ' listesine eklendi' : LIST_LABEL[list] + ' listesinden çıkarıldı');
  return on;
}

const listItems = (list) => Object.values(db.movies).filter((m) => m.lists[list]);
const allItems = () => Object.values(db.movies);

function renderCounts() {
  ['watched', 'favorite', 'watchlist'].forEach((l) => {
    const el = $('#c-' + l); if (el) el.textContent = listItems(l).length;
  });
  const cs = $('#c-series');
  if (cs) {
    const cols = new Set();
    allItems().forEach((m) => { if (m.col && m.col.id) cols.add(String(m.col.id)); });
    cs.textContent = cols.size;
  }
}

/* --------------------------------- cards --------------------------------- */

function posterHTML(m, size = 'w342') {
  return m.poster_path
    ? `<img loading="lazy" src="${IMG}${size}${m.poster_path}" alt="${esc(m.title)} afişi" />`
    : `<div class="poster-fallback">🎞️</div>`;
}

function quickHTML(m) {
  const k = keyOf(m);
  const e = entry(k);
  const on = (l) => (e && e.lists[l] ? ' is-on' : '');
  const pressed = (l) => (e && e.lists[l] ? 'true' : 'false');
  return `<div class="quick" role="group" aria-label="Hızlı ekle">
    <button class="quick-btn fav${on('favorite')}" data-act="favorite" data-id="${k}" aria-pressed="${pressed('favorite')}" title="Favorilere ekle" aria-label="Favorilere ekle">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9A4.6 4.6 0 1 1 19.4 13Z"/></svg>
    </button>
    <button class="quick-btn seen${on('watched')}" data-act="watched" data-id="${k}" aria-pressed="${pressed('watched')}" title="İzledim" aria-label="İzledim olarak işaretle">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
    </button>
    <button class="quick-btn plan${on('watchlist')}" data-act="watchlist" data-id="${k}" aria-pressed="${pressed('watchlist')}" title="İzleyeceğim" aria-label="İzleyeceklerime ekle">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>
    </button>
  </div>`;
}

function cardHTML(m) {
  const k = keyOf(m);
  const e = entry(k);
  const badges = [];
  if (m.mtype === 'tv') badges.push('<span class="badge tv">Dizi</span>');
  const pr = e && e.progress;
  if (pr && pr.s) badges.push('<span class="badge prog">S' + pr.s + (pr.e ? '·B' + pr.e : '') + '</span>');
  if (e) {
    if (e.lists.watched) badges.push('<span class="badge seen">İzledim</span>');
    if (e.lists.favorite) badges.push('<span class="badge fav">Favori</span>');
    if (e.lists.watchlist) badges.push('<span class="badge list">Listede</span>');
  }
  const score = e && e.myRating
    ? `<span class="badge score">★ ${e.myRating}</span>`
    : (m.vote_average ? `<span class="badge score">${m.vote_average.toFixed(1)}</span>` : '');
  const gs = (m.genre_ids || []).slice(0, 2).map(genreName).join(' · ');
  return `<div class="card-movie" data-card="${k}">
    <div class="poster" role="button" tabindex="0" data-id="${k}" aria-label="${esc(m.title)} detayı">
      ${posterHTML(m)}<div class="badges">${badges.join('')}</div>${score}
      ${quickHTML(m)}
    </div>
    <div class="card-text" role="button" tabindex="-1" data-id="${k}">
      <div class="card-title">${esc(m.title)}</div>
      <div class="card-meta">${year(m.release_date)}${gs ? ' · ' + esc(gs) : ''}</div>
    </div>
  </div>`;
}

// bir kartı yerinde tazele (grid'i baştan çizmeden)
function refreshCard(id) {
  const src = db.movies[String(id)] || cacheMovies.get(String(id));
  if (!src) return;
  $$('[data-card="' + id + '"]').forEach((el) => { el.outerHTML = cardHTML(src); });
}

const cacheMovies = new Map(); // id -> raw tmdb object
function renderGrid(el, list) {
  const movies = list.map((m) => norm(m));
  movies.forEach((m) => cacheMovies.set(m.key, m));
  el.innerHTML = movies.map(cardHTML).join('');
}

/* --------------------------------- search -------------------------------- */

/* Arama, tek bir TMDB çağrısı değil: kademeli olarak genişleyen bir zincir.
   1) IMDb ID / IMDb linki       -> /find  (birebir eşleşme)
   2) "başlık 2010"               -> yıl filtreli arama
   3) düz başlık                  -> seçili dilde arama
   4) sonuç yoksa                -> İngilizce (orijinal başlık) arama
   5) hala yoksa                 -> kişi araması (yönetmen/oyuncu) -> filmografi
   6) yine yoksa                 -> ipuçları göster                                   */

const IMDB_RE = /(tt\d{6,})/i;

function parseQuery(raw) {
  const q = raw.trim();
  const imdb = q.match(IMDB_RE);
  if (imdb && (/^tt\d+$/i.test(q) || /imdb\.com/i.test(q))) return { imdbId: imdb[1] };
  const m = q.match(/^(.*?)[\s(,-]+((?:19|20)\d{2})\)?$/);
  if (m && m[1].trim().length >= 2) return { text: m[1].trim(), year: m[2] };
  return { text: q };
}

async function searchByImdb(id) {
  const d = await tmdb('/find/' + id, { external_source: 'imdb_id' });
  const eps = (d.tv_episode_results || []).map((e) => ({ id: e.show_id, media_type: 'tv', name: e.name }));
  return (d.movie_results || []).map((x) => norm(x, 'movie'))
    .concat((d.tv_results || []).map((x) => norm(x, 'tv')))
    .concat(eps.length && !(d.movie_results || []).length && !(d.tv_results || []).length
      ? eps.map((x) => norm(x, 'tv')) : []);
}

/* film + dizi birlikte arama */
async function searchTitles(text, opts) {
  const o = opts || {};
  if (o.year) {
    const [mv, tv] = await Promise.all([
      tmdb('/search/movie', { query: text, include_adult: 'false', primary_release_year: o.year, language: o.language }).catch(() => ({})),
      tmdb('/search/tv', { query: text, include_adult: 'false', first_air_date_year: o.year, language: o.language }).catch(() => ({})),
    ]);
    return (mv.results || []).map((x) => norm(x, 'movie'))
      .concat((tv.results || []).map((x) => norm(x, 'tv')))
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  }
  const d = await tmdb('/search/multi', { query: text, include_adult: 'false', language: o.language });
  return (d.results || [])
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .map((x) => norm(x));
}

/* seri / koleksiyon araması: "Yüzüklerin Efendisi" -> serinin tüm filmleri */
async function searchCollections(text) {
  const d = await tmdb('/search/collection', { query: text }).catch(() => ({}));
  return d.results || [];
}
async function collectionParts(id) {
  const d = await tmdb('/collection/' + id);
  return (d.parts || []).map((x) => norm(x, 'movie'))
    .sort((a, b) => String(a.release_date).localeCompare(String(b.release_date)));
}

/* konu / anahtar kelime araması: "zaman yolculuğu", "seri katil", "uzay" */
async function keywordTitles(text) {
  const k = await tmdb('/search/keyword', { query: text }).catch(() => ({}));
  const first = (k.results || [])[0];
  if (!first) return null;
  const [mv, tv] = await Promise.all([
    tmdb('/discover/movie', { with_keywords: first.id, sort_by: 'popularity.desc', include_adult: 'false' }).catch(() => ({})),
    tmdb('/discover/tv', { with_keywords: first.id, sort_by: 'popularity.desc' }).catch(() => ({})),
  ]);
  const items = (mv.results || []).map((x) => norm(x, 'movie'))
    .concat((tv.results || []).map((x) => norm(x, 'tv')))
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .slice(0, 30);
  return items.length ? { kw: first, items } : null;
}

/* boş arama ekranı: bu hafta trend olanlar */
async function trendingNow() {
  const d = await tmdb('/trending/all/week');
  return (d.results || [])
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .map((x) => norm(x)).slice(0, 18);
}

async function searchPeople(text) {
  const d = await tmdb('/search/person', { query: text, include_adult: 'false' });
  return (d.results || []).filter((p) => (p.known_for_department || '') !== '');
}

async function personFilms(person) {
  const d = await tmdb('/person/' + person.id + '/combined_credits');
  const crew = (d.crew || []).filter((c) => ['Director', 'Writer'].indexOf(c.job) !== -1);
  const all = (d.cast || []).concat(crew).map((x) => norm(x));
  const seen = new Set();
  return all
    .filter((m) => m.title && !seen.has(m.key) && seen.add(m.key))
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .slice(0, 40);
}

function tipsHTML(q) {
  return `<div class="tips">
    <h3>Bulunamadı — şunları dene</h3>
    <ul>
      <li><b>Orijinal adıyla ara.</b> Türkçe vizyon adı farklı olabilir: “Sefiller” yerine <code>Les Misérables</code>.</li>
      <li><b>IMDb numarasını yapıştır.</b> IMDb sayfasındaki adreste geçen <code>tt1375666</code> gibi kodu ya da linkin tamamını kutuya yapıştır — birebir bulur.</li>
      <li><b>Yıl ekle.</b> <code>Dune 2021</code> gibi yazarsan aynı isimli yapımlar ayıklanır.</li>
      <li><b>Kişi adıyla ara.</b> <code>Nuri Bilge Ceylan</code> veya <code>Villeneuve</code> yazarsan film + dizi işleri listelenir.</li>
      <li><b>Seri adıyla ara.</b> <code>Yüzüklerin Efendisi</code> gibi yazarsan serinin tüm filmleri sırayla gelir.</li>
      <li><b>Konuyla ara.</b> <code>zaman yolculuğu</code>, <code>seri katil</code>, <code>uzay</code> gibi kelimeler de eşleşir.</li>
      <li><b>Yazımı sadeleştir.</b> Alt başlık ve iki nokta olmadan dene: <code>Mad Max Fury Road</code>.</li>
      <li>Film çok yeniyse veya bağımsızsa TMDB’de olmayabilir; <a href="https://www.themoviedb.org/movie/new" target="_blank" rel="noopener">TMDB’ye ekleyip</a> birkaç dakika sonra tekrar arayabilirsin.</li>
    </ul>
  </div>`;
}

let searchToken = 0;

function countMsg(items) {
  const f = items.filter((m) => m.mtype !== 'tv').length;
  const t = items.length - f;
  if (f && t) return f + ' film · ' + t + ' dizi';
  if (t) return t + ' dizi';
  return f + ' film';
}

const runSearch = debounce(async (raw) => {
  const status = $('#search-status'), grid = $('#search-results'), empty = $('#search-empty');
  const token = ++searchToken;
  if (!raw.trim()) {
    grid.innerHTML = ''; status.textContent = ''; status.className = 'status'; empty.hidden = false;
    if (getKey()) {
      try {
        await ensureGenres();
        const tr = await trendingNow();
        if (token !== searchToken || $('#q').value.trim()) return;
        if (tr.length) {
          empty.hidden = true;
          status.textContent = 'Bu hafta trend olanlar';
          renderGrid(grid, tr);
        }
      } catch (e) { /* sessiz: boş ekran zaten yönerge gösteriyor */ }
    }
    return;
  }
  empty.hidden = true;
  status.className = 'status'; status.textContent = 'Aranıyor…';

  const p = parseQuery(raw);
  const done = (msg, results, extra) => {
    if (token !== searchToken) return true;   // daha yeni bir arama başladı
    status.className = 'status';
    status.textContent = msg;
    grid.innerHTML = '';
    if (results && results.length) renderGrid(grid, results);
    if (extra) grid.insertAdjacentHTML('afterbegin', extra);
    return true;
  };

  try {
    await ensureGenres();

    // 1) IMDb ID / link
    if (p.imdbId) {
      const r = await searchByImdb(p.imdbId);
      if (r.length) return done('IMDb ' + p.imdbId + ' → birebir eşleşme', r);
      return done('IMDb kodu ' + p.imdbId + ' için yapım bulunamadı.', [], tipsHTML(raw));
    }

    // 2/3) başlık — film + dizi birlikte (varsa yıl filtresiyle)
    let results = (await searchTitles(p.text, { year: p.year })).filter((m) => m.title);

    if (!results.length && p.year) {   // yılı gevşet
      results = (await searchTitles(p.text)).filter((m) => m.title);
      if (results.length) return done(countMsg(results) + ' · ' + p.year + ' yılı filtresi kaldırıldı', results);
    }

    if (results.length) return done(countMsg(results), results);

    // 4) İngilizce / orijinal başlık denemesi
    if (getLang() !== 'en-US') {
      status.textContent = 'Orijinal başlıkla deneniyor…';
      results = (await searchTitles(p.text, { language: 'en-US' })).filter((m) => m.title);
      if (results.length) return done(countMsg(results) + ' · orijinal başlıkla bulundu', results);
    }

    // 4b) seri / koleksiyon
    const cols = await searchCollections(p.text);
    if (cols.length) {
      const parts = await collectionParts(cols[0].id).catch(() => []);
      if (parts.length) {
        const others = cols.slice(1, 4).map((c) =>
          `<button class="chip" data-collection="${c.id}">${esc(c.name)}</button>`).join('');
        return done(esc(cols[0].name) + ' · ' + parts.length + ' film', parts,
          others ? `<div class="chip-row">${others}</div>` : '');
      }
    }

    // 5) kişi araması
    status.textContent = 'Kişi olarak aranıyor…';
    const people = await searchPeople(p.text);
    if (people.length) {
      const person = people[0];
      const films = await personFilms(person);
      if (films.length) {
        const others = people.slice(1, 4).map((x) =>
          `<button class="chip" data-person="${x.id}">${esc(x.name)}</button>`).join('');
        const head = `<div class="chip-row">${others}</div>`;
        return done(esc(person.name) + ' · ' + countMsg(films), films, others ? head : '');
      }
    }

    // 6) konu / anahtar kelime
    status.textContent = 'Konu olarak aranıyor…';
    const kw = await keywordTitles(p.text);
    if (kw) return done('Konu: ' + esc(kw.kw.name) + ' · ' + countMsg(kw.items), kw.items);

    // 7) ipuçları
    return done('“' + raw + '” için sonuç bulunamadı.', [], tipsHTML(raw));
  } catch (err) {
    if (token !== searchToken) return;
    grid.innerHTML = '';
    status.className = 'status err';
    status.textContent = err.message;
  }
}, 350);

// kişi çipine tıklayınca o kişinin filmografisi
document.addEventListener('click', async (ev) => {
  const chip = ev.target.closest('.chip[data-person], .chip[data-collection]');
  if (!chip) return;
  const status = $('#search-status'), grid = $('#search-results');
  status.className = 'status'; status.textContent = 'Yükleniyor…';
  try {
    const films = chip.dataset.collection
      ? await collectionParts(chip.dataset.collection)
      : await personFilms({ id: chip.dataset.person });
    status.textContent = chip.textContent + ' · ' + countMsg(films);
    grid.innerHTML = '';
    renderGrid(grid, films);
  } catch (err) { status.className = 'status err'; status.textContent = err.message; }
});

/* --------------------------------- library ------------------------------- */

let currentList = 'watched';

function renderLibrary() {
  const grid = $('#library-results'), empty = $('#library-empty');
  const isSer = currentList === 'series';
  $('#ser-tools').hidden = !isSer;
  $('#lib-sort').hidden = isSer;
  $('#lib-series-wrap').hidden = isSer;
  $('#lib-filter').placeholder = isSer ? 'Seride ara…' : 'Listede ara…';
  grid.classList.toggle('is-series', isSer);
  if (isSer) return renderSeriesView();

  const f = ($('#lib-filter').value || '').toLowerCase().trim();
  const sort = $('#lib-sort').value;
  let items = listItems(currentList);
  if (f) items = items.filter((m) => (m.title + ' ' + m.original_title).toLowerCase().includes(f));
  if ($('#lib-series').checked) items = items.filter((m) => m.col && m.col.id); // sadece seriye ait filmler

  items.sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title, 'tr');
    if (sort === 'year') return year(b.release_date).localeCompare(year(a.release_date));
    if (sort === 'myRating') return (b.myRating || 0) - (a.myRating || 0);
    return (b.addedAt || '').localeCompare(a.addedAt || '');
  });

  empty.hidden = items.length > 0 || !!f;
  grid.innerHTML = '';
  if (items.length) renderGrid(grid, items);
  else if (f || $('#lib-series').checked) {
    grid.innerHTML = '<p class="muted">' + ($('#lib-series').checked && !f
      ? 'Bu listede seriye ait film yok. Serileri taramadıysan “Serilerim” sekmesinden tarayabilirsin.'
      : 'Filtreye uyan yapım yok.') + '</p>';
  }
}

/* ------------------------------ taste profile ---------------------------- */
/* Ağırlık mantığı:
   favorite = 3, watched = 2, watchlist = 1 taban puan;
   kullanıcı puanı varsa (1-10) çarpan: 0.4 + rating/10 → 0.5x–1.4x        */

function tasteProfile() {
  const genres = {}, people = {}, decades = {};
  let total = 0;

  allItems().forEach((m) => {
    let w = 0;
    if (m.lists.favorite) w += 3;
    if (m.lists.watched) w += 2;
    if (m.lists.watchlist) w += 1;
    if (!w) return;
    if (m.myRating) w *= 0.4 + m.myRating / 10;
    total += w;
    (m.genre_ids || []).forEach((g) => { genres[g] = (genres[g] || 0) + w; });
    (m.directors || []).forEach((p) => { people[p] = (people[p] || 0) + w * 1.2; });
    (m.cast || []).slice(0, 3).forEach((p) => { people[p] = (people[p] || 0) + w * 0.5; });
    const y = parseInt(year(m.release_date), 10);
    if (!isNaN(y)) { const d = Math.floor(y / 10) * 10; decades[d] = (decades[d] || 0) + w; }
  });

  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  return { genres, people, decades, total, topGenres: top(genres, 5), topPeople: top(people, 6) };
}

/* ------------------------------ recommendations -------------------------- */

/* "Yenile" her basışta gerçekten farklı bir liste üretsin diye bir tur sayacı
   tutuluyor. Tur; tohum filmleri, keşif sıralamasını, sayfa numarasını ve tür
   kombinasyonunu kaydırıyor. Son turlarda gösterilenler de bir süre geri plana
   atılıyor, böylece aynı afişler üst üste gelmiyor. */
LS.recround = 'izlence.recround';
LS.recseen = 'izlence.recseen';
const getRound = () => Number(localStorage.getItem(LS.recround) || 0);
const bumpRound = () => { const n = getRound() + 1; localStorage.setItem(LS.recround, String(n)); return n; };
function getRecSeen() {
  try { const a = JSON.parse(localStorage.getItem(LS.recseen) || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function pushRecSeen(ids) {
  const merged = ids.concat(getRecSeen()).slice(0, 80);
  localStorage.setItem(LS.recseen, JSON.stringify(merged));
}

async function buildRecs() {
  const status = $('#rec-status'), grid = $('#rec-results'), empty = $('#rec-empty'), chips = $('#taste-chips');
  const seeds = allItems();

  if (seeds.length < 3) { empty.hidden = false; grid.innerHTML = ''; chips.innerHTML = ''; status.textContent = ''; return; }
  empty.hidden = true;
  status.className = 'status'; status.textContent = 'Öneriler hesaplanıyor…';

  try {
    await ensureGenres();
    const profile = tasteProfile();

    chips.innerHTML = profile.topGenres
      .map(([g, w]) => `<span class="chip">${esc(genreName(g))} · %${Math.round((w / profile.total) * 100)}</span>`)
      .join('') + profile.topPeople.slice(0, 3).map(([p]) => `<span class="chip n">${esc(p)}</span>`).join('');

    // 1) Tohum filmler — her turda listenin başka bir dilimi kullanılır
    const round = getRound();
    const rankedAll = seeds
      .map((m) => ({ m, w: (m.lists.favorite ? 3 : 0) + (m.lists.watched ? 2 : 0) + (m.myRating || 0) / 2 }))
      .sort((a, b) => b.w - a.w);
    const poolSize = Math.min(rankedAll.length, 14);
    const want = Math.min(5, poolSize);
    const ranked = [];
    const taken = new Set();
    for (let i = 0; ranked.length < want && i < poolSize * 2; i++) {
      const idx = (round * 2 + i) % poolSize;
      if (taken.has(idx)) continue;
      taken.add(idx); ranked.push(rankedAll[idx]);
    }

    // keşif sorgusu da turla birlikte kayar: sıralama, sayfa ve tür kombinasyonu
    const sorts = ['vote_average.desc', 'popularity.desc', 'vote_count.desc', 'primary_release_date.desc'];
    const sortBy = sorts[round % sorts.length];
    const discPage = 1 + (round % 3);
    const recPage = 1 + (round % 2);
    const gAll = profile.topGenres.map(([g]) => g);
    const gPick = Array.from(new Set([0, 1, 2].map((k) => gAll[(round + k) % Math.max(gAll.length, 1)]).filter(Boolean)));
    const withGenres = (gPick.length ? gPick : gAll.slice(0, 3)).join(',');

    const pools = await Promise.all([
      ...ranked.map((r) => {
        const pk = parseKey(keyOf(r.m));
        return tmdb('/' + pk.type + '/' + pk.id + '/recommendations', { page: recPage })
          .then((d) => (d.results || []).map((x) => ({ x: norm(x, pk.type), src: r.m.title })))
          .catch(() => []);
      }),
      // 2) Zevk profilinin türlerine göre keşif (film + dizi, varsa platform filtresiyle)
      tmdb('/discover/movie', Object.assign({
        with_genres: withGenres,
        sort_by: sortBy,
        page: discPage,
        'vote_count.gte': getProviders().length ? 120 : 400,
        include_adult: 'false',
      }, provParams())).then((d) => (d.results || []).map((x) => ({ x: norm(x, 'movie'), src: 'zevk profili' }))).catch(() => []),
      tmdb('/discover/tv', Object.assign({
        with_genres: withGenres,
        sort_by: sortBy,
        page: discPage,
        'vote_count.gte': getProviders().length ? 60 : 200,
      }, provParams())).then((d) => (d.results || []).map((x) => ({ x: norm(x, 'tv'), src: 'zevk profili' }))).catch(() => []),
    ]);

    // 3) Skorlama
    const scores = new Map();
    pools.flat().forEach(({ x, src }) => {
      if (!x || !x.title) return;
      const id = keyOf(x);
      if (db.movies[id]) return; // zaten listede
      const prev = scores.get(id) || { movie: x, score: 0, hits: 0, why: new Set() };
      let s = 12; // benzer film havuzunda görülme taban puanı
      (x.genre_ids || []).forEach((g) => {
        if (profile.genres[g]) s += (profile.genres[g] / profile.total) * 42;
      });
      s += (x.vote_average || 0) * 1.6;
      if ((x.vote_count || 0) < 150) s -= 12; // az oylananı bastır
      const y = parseInt(year(x.release_date), 10);
      if (!isNaN(y)) { const d = Math.floor(y / 10) * 10; if (profile.decades[d]) s += (profile.decades[d] / profile.total) * 10; }
      prev.score += s; prev.hits += 1; prev.why.add(src);
      scores.set(id, prev);
    });

    const seenBefore = new Set(getRecSeen());
    const recs = Array.from(scores.values())
      .map((r) => {
        let sc = r.score * (1 + Math.min(r.hits - 1, 4) * 0.18); // birden fazla kaynakta çıkana bonus
        if (seenBefore.has(keyOf(r.movie))) sc *= 0.55;          // son turlarda gösterildi, geri plana
        sc *= 1 + (Math.random() - 0.5) * 0.16;                  // eşit skorluları karıştır
        return Object.assign({}, r, { score: sc });
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 24);

    if (!recs.length) { status.textContent = 'Yeni öneri bulunamadı. Birkaç film daha ekleyip tekrar dene.'; grid.innerHTML = ''; return; }

    const fresh = recs.filter((r) => !seenBefore.has(keyOf(r.movie))).length;
    status.textContent = recs.length + ' öneri · ' + fresh + ' tanesi yeni · ' + (round + 1) + '. tur'
      + ' · en güçlü sinyal: ' + (profile.topGenres[0] ? genreName(profile.topGenres[0][0]) : '—');
    pushRecSeen(recs.map((r) => keyOf(r.movie)));
    $('#rec-basis').textContent = seeds.length + ' yapımlık listenden çıkarılan tür, yönetmen ve dönem tercihlerine göre.'
      + (getProviders().length ? ' Yalnızca seçtiğin ' + getProviders().length + ' platformda izlenebilenler.' : '');
    renderGrid(grid, recs.map((r) => r.movie));
  } catch (err) {
    grid.innerHTML = '';
    status.className = 'status err';
    status.textContent = err.message;
  }
}

/* ---------------------------- platform filtresi --------------------------
   Kullanici Ayarlar'dan abone oldugu platformlari secer; oneri kesfi (discover)
   sadece o platformlarda izlenebilen yapimlari getirir. */

function getProviders() {
  try { const a = JSON.parse(localStorage.getItem(LS.providers) || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
const setProviders = (a) => localStorage.setItem(LS.providers, JSON.stringify(a));
const region = () => (getLang().split('-')[1] || 'TR');

function provParams() {
  const p = getProviders();
  if (!p.length) return {};
  return {
    with_watch_providers: p.join('|'),
    watch_region: region(),
    with_watch_monetization_types: 'flatrate|free|ads',
  };
}

/* Saglayici listesi gunde bir tazelenir; her Ayarlar acilisinda TMDB'ye
   gitmek gereksiz ve kotayi bosa harciyordu. */
LS.provcache = 'izlence.provcache';
const PROV_TTL = 24 * 60 * 60 * 1000;

function cachedProviders() {
  try {
    const c = JSON.parse(localStorage.getItem(LS.provcache) || 'null');
    if (c && c.region === region() && Array.isArray(c.list) && c.list.length
        && Date.now() - c.at < PROV_TTL) return c.list;
  } catch (e) { /* yoksay */ }
  return null;
}

async function fetchProviders() {
  const hit = cachedProviders();
  if (hit) return hit;
  const [mv, tv] = await Promise.all([
    tmdb('/watch/providers/movie', { watch_region: region() }),
    tmdb('/watch/providers/tv', { watch_region: region() }).catch(() => ({ results: [] })),
  ]);
  const map = new Map();
  (mv.results || []).concat(tv.results || []).forEach((p) => { if (!map.has(p.provider_id)) map.set(p.provider_id, p); });
  const list = Array.from(map.values());
  try {
    localStorage.setItem(LS.provcache, JSON.stringify({ at: Date.now(), region: region(), list }));
  } catch (e) { /* kota dolduysa yoksay */ }
  return list;
}

async function renderProviderPicker() {
  const box = $('#prov-list');
  if (!box) return;
  if (!getKey()) { box.innerHTML = '<p class="muted small">TMDB anahtarini kaydettikten sonra platform listesi yuklenir.</p>'; return; }
  box.innerHTML = '<p class="muted small">Platformlar yukleniyor...</p>';
  try {
    const providers = await fetchProviders();
    const sel = getProviders();
    // Oncelik bolgeye gore degisir; global display_priority Netflix gibi buyuk
    // platformlari listenin disinda birakabiliyordu.
    const prio = (p) => {
      const byRegion = (p.display_priorities || {})[region()];
      const v = (byRegion === undefined || byRegion === null) ? p.display_priority : byRegion;
      return (v === undefined || v === null) ? 999 : v;
    };
    const all = providers.slice().sort((a, b) =>
      prio(a) - prio(b) || String(a.provider_name).localeCompare(String(b.provider_name), 'tr'));
    // Secili platformlar her zaman gorunur kalsin
    const top = all.slice(0, 24);
    const topIds = new Set(top.map((p) => String(p.provider_id)));
    const pinned = all.filter((p) => sel.indexOf(String(p.provider_id)) >= 0 && !topIds.has(String(p.provider_id)));
    const rest = all.filter((p) => !topIds.has(String(p.provider_id)) && pinned.indexOf(p) < 0);
    const chip = (p) =>
      `<button class="toggle-chip ${sel.indexOf(String(p.provider_id)) >= 0 ? 'is-on' : ''}" data-prov="${p.provider_id}">${esc(p.provider_name)}</button>`;
    box.innerHTML = pinned.concat(top).map(chip).join('')
      + (rest.length ? `<div id="prov-rest" hidden>${rest.map(chip).join('')}</div>`
        + `<button id="prov-more" class="btn btn-mini" type="button">Tum platformlar (${rest.length})</button>` : '');
    const more = $('#prov-more');
    if (more) more.addEventListener('click', () => {
      const r = $('#prov-rest');
      if (!r) return;
      r.hidden = !r.hidden;
      more.textContent = r.hidden ? 'Tum platformlar (' + rest.length + ')' : 'Daha az goster';
    });
    provStatus();
  } catch (e) { box.innerHTML = '<p class="status err">' + esc(e.message) + '</p>'; }
}

function provStatus() {
  const el = $('#prov-status');
  if (!el) return;
  const n = getProviders().length;
  el.textContent = n
    ? n + ' platform secili - oneriler bunlarla sinirli (' + region() + ')'
    : 'Platform secilmedi - oneriler tum yapimlardan gelir.';
}

/* --------------------------------- stats --------------------------------- */

function barsHTML(rows, unit = '') {
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return `<div class="bars">${rows.map(([lab, v]) => `
    <div class="bar-row">
      <div title="${esc(lab)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(lab)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round((v / max) * 100)}%"></div></div>
      <div class="bar-num">${v}${unit}</div>
    </div>`).join('')}</div>`;
}

function renderStats() {
  const body = $('#stats-body'), empty = $('#stats-empty');
  const items = allItems();
  if (!items.length) { empty.hidden = false; body.innerHTML = ''; return; }
  empty.hidden = true;

  const watched = listItems('watched');
  const rated = items.filter((m) => m.myRating);
  const avg = rated.length ? (rated.reduce((s, m) => s + m.myRating, 0) / rated.length) : 0;
  const wMovies = watched.filter((m) => m.mtype !== 'tv');
  const wSeries = watched.filter((m) => m.mtype === 'tv');
  const mins = watched.reduce((s, m) => s + minutesOf(m), 0);
  const known = watched.filter((m) => minutesOf(m)).length;
  const est = known ? Math.round((mins / known) * watched.length) : 0;
  const eps = wSeries.reduce((s, m) => s + (m.episodes || 0), 0);

  // tür dağılımı
  const g = {};
  items.forEach((m) => (m.genre_ids || []).forEach((id) => { g[genreName(id)] = (g[genreName(id)] || 0) + 1; }));
  const gRows = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // on yıl dağılımı
  const dec = {};
  items.forEach((m) => { const y = parseInt(year(m.release_date), 10); if (!isNaN(y)) { const d = Math.floor(y / 10) * 10; dec[d] = (dec[d] || 0) + 1; } });
  const decRows = Object.entries(dec).sort((a, b) => a[0] - b[0]);
  const decMax = Math.max(...decRows.map((r) => r[1]), 1);

  // puan histogramı
  const hist = {};
  rated.forEach((m) => { hist[m.myRating] = (hist[m.myRating] || 0) + 1; });
  const histRows = Array.from({ length: 10 }, (_, i) => [String(i + 1), hist[i + 1] || 0]);
  const histMax = Math.max(...histRows.map((r) => r[1]), 1);

  // yönetmenler
  const dirs = {};
  items.forEach((m) => (m.directors || []).forEach((d) => { dirs[d] = (dirs[d] || 0) + 1; }));
  const dirRows = Object.entries(dirs).filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const topRated = rated.slice().sort((a, b) => b.myRating - a.myRating).slice(0, 5);

  body.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="kpi-val">${wMovies.length}</div><div class="kpi-lab">İzlenen film</div></div>
      <div class="kpi"><div class="kpi-val">${wSeries.length}</div><div class="kpi-lab">İzlenen dizi${eps ? ' · ' + eps + ' bölüm' : ''}</div></div>
      <div class="kpi"><div class="kpi-val">${est ? Math.round(est / 60) + ' sa' : '—'}</div><div class="kpi-lab">Toplam süre (tahmini)</div></div>
      <div class="kpi"><div class="kpi-val">${avg ? avg.toFixed(1) : '—'}</div><div class="kpi-lab">Ortalama puanım</div></div>
      <div class="kpi"><div class="kpi-val">${gRows.length ? esc(gRows[0][0]) : '—'}</div><div class="kpi-lab">En çok izlenen tür</div></div>
    </div>

    <div class="card"><h3>Tür dağılımı</h3><p class="muted">Listelerindeki film sayısına göre.</p>${barsHTML(gRows)}</div>

    <div class="card"><h3>Yapım yılı (on yıllık)</h3>
      <div class="spark">${decRows.map(([d, v]) => `
        <div class="spark-col"><div class="spark-bar" style="height:${Math.round((v / decMax) * 78)}px" title="${d}: ${v}"></div><div class="spark-lab">${String(d).slice(2)}'</div></div>`).join('')}</div>
    </div>

    <div class="card"><h3>Puan dağılımı</h3><p class="muted">${rated.length} filme puan verdin.</p>
      <div class="spark">${histRows.map(([lab, v]) => `
        <div class="spark-col"><div class="spark-bar" style="height:${Math.round((v / histMax) * 78)}px;background:var(--orange)" title="${lab} puan: ${v}"></div><div class="spark-lab">${lab}</div></div>`).join('')}</div>
    </div>

    <div class="card"><h3>Yıl özeti · Wrapped</h3>
      <p class="muted">Listeye ekleme tarihine göre hesaplanır.</p>
      <div class="row"><select id="wrap-year" class="input" aria-label="Yıl">${wrapYears().map((y) =>
        `<option value="${y}">${y}</option>`).join('')}</select></div>
      <div id="wrap-body">${wrapBody(wrapYears()[0])}</div>
    </div>

    ${dirRows.length ? `<div class="card"><h3>En çok izlediğin yönetmenler</h3>${barsHTML(dirRows)}</div>` : ''}

    ${topRated.length ? `<div class="card"><h3>En yüksek puan verdiklerin</h3>
      <div class="bars">${topRated.map((m) => `<div class="bar-row">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.title)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${m.myRating * 10}%;background:var(--orange)"></div></div>
        <div class="bar-num">${m.myRating}</div></div>`).join('')}</div></div>` : ''}
  `;

  const ws = $('#wrap-year');
  if (ws) ws.addEventListener('change', () => { $('#wrap-body').innerHTML = wrapBody(ws.value); });
}

/* ------------------------------ yil ozeti -------------------------------- */

function wrapYears() {
  const ys = new Set();
  allItems().forEach((m) => { const y = String(m.addedAt || '').slice(0, 4); if (y.length === 4) ys.add(y); });
  ys.add(String(new Date().getFullYear()));
  return Array.from(ys).sort().reverse();
}

function wrapBody(y) {
  const yr = String(y);
  const items = allItems().filter((m) => String(m.addedAt || '').slice(0, 4) === yr);
  if (!items.length) return '<p class="muted">' + yr + ' yılında listeye eklenen yapım yok.</p>';

  const films = items.filter((m) => m.mtype !== 'tv');
  const series = items.filter((m) => m.mtype === 'tv');
  const mins = items.reduce((s2, m) => s2 + minutesOf(m), 0);
  const rated = items.filter((m) => m.myRating);
  const avg = rated.length ? (rated.reduce((s2, m) => s2 + m.myRating, 0) / rated.length) : 0;

  const g = {};
  items.forEach((m) => (m.genre_ids || []).forEach((id) => { g[genreName(id)] = (g[genreName(id)] || 0) + 1; }));
  const topG = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 3);

  const dirs = {};
  items.forEach((m) => (m.directors || []).forEach((d) => { dirs[d] = (dirs[d] || 0) + 1; }));
  const topD = Object.entries(dirs).sort((a, b) => b[1] - a[1])[0];

  const best = rated.slice().sort((a, b) => b.myRating - a.myRating).slice(0, 3);
  const months = {};
  items.forEach((m) => { const mo = String(m.addedAt || '').slice(5, 7); if (mo) months[mo] = (months[mo] || 0) + 1; });
  const topM = Object.entries(months).sort((a, b) => b[1] - a[1])[0];
  const MO = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

  return `<div class="kpis">
      <div class="kpi"><div class="kpi-val">${films.length}</div><div class="kpi-lab">film</div></div>
      <div class="kpi"><div class="kpi-val">${series.length}</div><div class="kpi-lab">dizi</div></div>
      <div class="kpi"><div class="kpi-val">${mins ? Math.round(mins / 60) + ' sa' : '—'}</div><div class="kpi-lab">ekran süresi</div></div>
      <div class="kpi"><div class="kpi-val">${avg ? avg.toFixed(1) : '—'}</div><div class="kpi-lab">ortalama puanın</div></div>
    </div>
    ${topG.length ? `<div class="chip-row">${topG.map(([n, v]) => `<span class="chip">${esc(n)} · ${v}</span>`).join('')}</div>` : ''}
    <ul class="wrap-list">
      ${topD ? `<li>Yılın yönetmeni: <b>${esc(topD[0])}</b> (${topD[1]} yapım)</li>` : ''}
      ${topM ? `<li>En yoğun ay: <b>${MO[parseInt(topM[0], 10)] || topM[0]}</b> (${topM[1]} yapım)</li>` : ''}
      ${best.length ? `<li>En sevdiklerin: ${best.map((m) => esc(m.title) + ' (' + m.myRating + ')').join(', ')}</li>` : ''}
    </ul>`;
}

/* --------------------------------- detail -------------------------------- */

/* Bir yapımın serisi (TMDB "collection") — varsa tüm halkaları kronolojik döner.
   1) Film detayındaki belongs_to_collection en kesin kaynak.
   2) Yoksa başlıktan koleksiyon aranır; sonuç bu filmi içeriyorsa kabul edilir.
   3) Diziler için aynı evrende film serisi varsa "ilgili seri" olarak gösterilir. */
const seriesCache = new Map(); // key -> {name, parts, loose} | null
let openId = null;

async function seriesOf(m, pk, raw) {
  try {
    if (pk.type === 'movie' && raw && raw.belongs_to_collection) {
      const c = raw.belongs_to_collection;
      const parts = await collectionParts(c.id).catch(() => []);
      if (parts.length > 1) return { name: c.name, parts: parts };
    }
    const base = String(m.title || '').split(/[:\-\u2013(]/)[0].trim();
    if (base.length < 3) return null;
    const cols = await searchCollections(base);
    for (const c of cols.slice(0, 3)) {
      const parts = await collectionParts(c.id).catch(() => []);
      if (parts.length < 2) continue;
      const mine = parts.some((p) => String(p.id) === String(pk.id));
      if (pk.type === 'movie' && !mine) continue;
      return { name: c.name, parts: parts, loose: !mine };
    }
  } catch (e) { /* sessiz */ }
  return null;
}

function seriesHTML(m) {
  const s = seriesCache.get(keyOf(m));
  if (!s || !s.parts || s.parts.length < 2) return '';
  const seen = s.parts.filter((p) => { const e = entry(keyOf(p)); return e && e.lists.watched; }).length;
  const missing = s.parts.filter((p) => !entry(keyOf(p))).length;
  const note = s.loose
    ? 'Aynı evrende geçen film serisi'
    : s.parts.length + ' yapım · ' + seen + ' tanesini izledin' + (seen === s.parts.length ? ' · seriyi tamamladın 🎉' : '');
  return `<label class="field-label">${esc(s.name)}</label>
    <p class="status">${esc(note)}</p>
    <div class="ser-row">${s.parts.map((p) => cardHTML(p)).join('')}</div>
    ${missing ? `<button class="btn btn-mini" data-ser="plan">Eksik ${missing} yapımı izleyeceklerime ekle</button>` : ''}`;
}

/* --------------------------- "Serilerim" görünümü ---------------------------
   Her filmin hangi seriye ait olduğu (TMDB collection) kaydın üzerinde
   m.col = {id, name} olarak tutulur; m.col === null ise "tarandı, serisi yok"
   demektir. Serinin tüm halkaları db.collections içinde önbelleklenir, böylece
   çevrimdışıyken de eksik halkalar listelenebilir. */

/* detay açıldığında öğrenilen seri bilgisini kalıcıya yaz */
function rememberSeries(id, raw, ser) {
  const e = db.movies[String(id)];
  if (!e || e.mtype === 'tv') return;
  const c = raw && raw.belongs_to_collection;
  if (c) {
    e.col = { id: String(c.id), name: c.name };
    db.collections[String(c.id)] = {
      name: c.name,
      parts: (ser && ser.parts ? ser.parts : []).map((p) => norm(p, 'movie')),
      fetchedAt: new Date().toISOString(),
    };
  } else if (e.col === undefined) {
    e.col = null;
  }
  saveDB();
}

function seriesGroups() {
  const map = new Map();
  allItems().forEach((m) => {
    if (!m.col || !m.col.id) return;
    const cid = String(m.col.id);
    if (!map.has(cid)) map.set(cid, { id: cid, name: m.col.name, owned: [] });
    map.get(cid).owned.push(m);
  });
  return Array.from(map.values()).map((g) => {
    const stored = db.collections[g.id];
    const parts = (stored && stored.parts && stored.parts.length) ? stored.parts : g.owned;
    const watched = parts.filter((p) => { const e = entry(keyOf(p)); return e && e.lists.watched; }).length;
    const missing = parts.filter((p) => { const e = entry(keyOf(p)); return !(e && e.lists.watched); });
    const notInDb = missing.filter((p) => !entry(keyOf(p)));
    return { id: g.id, name: (stored && stored.name) || g.name, parts, watched, missing, notInDb };
  }).sort((a, b) => b.missing.length - a.missing.length || a.name.localeCompare(b.name, 'tr'));
}

function renderSeriesView() {
  const grid = $('#library-results'), empty = $('#library-empty');
  empty.hidden = true;
  const gapsOnly = $('#ser-gaps').checked;
  const f = ($('#lib-filter').value || '').toLowerCase().trim();
  const all = seriesGroups();
  let groups = all;
  if (f) groups = groups.filter((g) => g.name.toLowerCase().includes(f));
  if (gapsOnly) groups = groups.filter((g) => g.missing.length);

  const totalMissing = all.reduce((n, g) => n + g.missing.length, 0);
  const unscanned = allItems().filter((m) => m.mtype !== 'tv' && m.col === undefined).length;
  $('#ser-status').textContent = all.length
    ? all.length + ' seri · ' + totalMissing + ' izlenmemiş halka'
      + (unscanned ? ' · ' + unscanned + ' film henüz taranmadı' : '')
    : (unscanned ? unscanned + ' film taranmayı bekliyor' : '');

  if (!groups.length) {
    grid.innerHTML = '<p class="muted">' + (unscanned
      ? 'Henüz seri taraması yapılmadı. <b>Serileri tara</b> düğmesine bas.'
      : (gapsOnly ? 'Eksiği olan seri yok — hepsini tamamlamışsın.' : 'Listende seriye ait film bulunamadı.')) + '</p>';
    return;
  }

  groups.forEach((g) => g.parts.forEach((p) => cacheMovies.set(keyOf(p), norm(p, 'movie'))));
  grid.innerHTML = groups.map((g) => {
    const show = gapsOnly ? g.missing : g.parts;
    const done = g.watched === g.parts.length;
    return '<div class="ser-group">'
      + '<div class="ser-head"><span class="ser-name">' + esc(g.name) + '</span>'
      + '<span class="small">' + g.watched + '/' + g.parts.length + (done ? ' · tamam' : ' izledin') + '</span></div>'
      + '<div class="ser-row">' + show.map((p) => cardHTML(norm(p, 'movie'))).join('') + '</div>'
      + (g.notInDb.length
        ? '<button class="btn btn-mini" data-sergroup="' + g.id + '">Eksik ' + g.notInDb.length + ' yapımı izleyeceklerime ekle</button>'
        : '')
      + '</div>';
  }).join('');
}

/* listedeki filmleri tarayip seri bilgisini toplar (TMDB /movie/{id}) */
let seriesScanning = false;
async function scanSeries(rescan) {
  if (seriesScanning) return;
  const status = $('#ser-status'), btn = $('#ser-scan');
  const targets = allItems().filter((m) => m.mtype !== 'tv' && (rescan || m.col === undefined));
  if (!targets.length) { toast('Taranacak yeni film yok'); renderLibrary(); return; }
  seriesScanning = true; btn.disabled = true;
  let found = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const m = targets[i];
      status.textContent = 'Taranıyor… ' + (i + 1) + '/' + targets.length + ' · ' + found + ' seri bulundu';
      try {
        const d = await tmdb('/movie/' + m.id);
        const c = d.belongs_to_collection;
        m.col = c ? { id: String(c.id), name: c.name } : null;
        if (c) {
          found++;
          const cid = String(c.id);
          if (!db.collections[cid] || !(db.collections[cid].parts || []).length) {
            const parts = await collectionParts(cid).catch(() => []);
            db.collections[cid] = { name: c.name, parts: parts, fetchedAt: new Date().toISOString() };
          }
        }
      } catch (err) {
        if (/429/.test(String(err && err.message))) { await sleep(2500); i--; continue; }
      }
      if (i % 8 === 7) saveDB();
      await sleep(110);
    }
    saveDB();
    toast(found + ' seri bulundu');
  } finally {
    seriesScanning = false; btn.disabled = false;
    if (currentList === 'series') renderSeriesView(); else renderLibrary();
  }
}

async function openMovie(id) {
  const sheet = $('#sheet'), body = $('#sheet-body');
  openId = String(id);
  const base = db.movies[String(id)] || cacheMovies.get(String(id)) || { id };
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  body.innerHTML = renderDetail(base, true);

  let full = base;
  let raw = null;
  const pk = parseKey(id);
  try {
    const d = await tmdb('/' + pk.type + '/' + pk.id, { append_to_response: 'credits,external_ids,watch/providers' });
    raw = d;
    const crew = (d.credits && d.credits.crew) || [];
    const makers = pk.type === 'tv'
      ? (d.created_by || []).map((c) => c.name)
      : crew.filter((c) => c.job === 'Director').map((c) => c.name);
    const prov = ((d['watch/providers'] || {}).results || {})[(getLang().split('-')[1] || 'TR')] || {};
    full = norm(Object.assign({}, base, d, {
      directors: makers.length ? makers : (base.directors || []),
      cast: ((d.credits && d.credits.cast) || []).slice(0, 6).map((c) => c.name),
      genre_ids: (d.genres || []).map((g) => g.id),
      imdb_id: d.imdb_id || (d.external_ids && d.external_ids.imdb_id) || null,
      providers: (prov.flatrate || []).concat(prov.free || []).map((p) => p.provider_name).slice(0, 6),
      providerLink: prov.link || null,
    }), pk.type);
    cacheMovies.set(String(id), full);
    if (db.movies[String(id)]) upsert(full, {});
  } catch (e) { /* çevrimdışı: elimizdeki veriyle devam */ }

  body.innerHTML = renderDetail(db.movies[String(id)] || full, false);
  wireDetail(full);

  // seri arka planda gelir, geldiğinde sayfa tazelenir
  if (!seriesCache.has(String(id))) {
    seriesOf(full, pk, raw).then((ser) => {
      seriesCache.set(String(id), ser);
      rememberSeries(String(id), raw, ser);
      if (!ser) return;
      ser.parts.forEach((p) => cacheMovies.set(keyOf(p), p));
      if (openId !== String(id) || $('#sheet').hidden) return;
      body.innerHTML = renderDetail(db.movies[String(id)] || full, false);
      wireDetail(full);
    }).catch(() => {});
  }
}

function renderDetail(m, loading) {
  const e = entry(keyOf(m));
  const gs = (m.genre_ids || []).map(genreName).join(' · ');
  const isTv = m.mtype === 'tv';
  const lenBit = isTv
    ? [m.seasons ? m.seasons + ' sezon' : null, m.episodes ? m.episodes + ' bölüm' : null,
       m.epRuntime ? '~' + m.epRuntime + ' dk/bölüm' : null].filter(Boolean).join(' · ')
    : (m.runtime ? m.runtime + ' dk' : null);
  const meta = [typeLabel(m), year(m.release_date), lenBit || null, gs || null].filter(Boolean).join('  ·  ');
  const hero = m.backdrop_path
    ? `<img src="${IMG}w780${m.backdrop_path}" alt="" />`
    : (m.poster_path ? `<img src="${IMG}w780${m.poster_path}" alt="" style="object-position:top" />` : '');

  return `
  <div class="hero">${hero}</div>
  <div class="sheet-inner">
    <div class="sheet-title">${esc(m.title || 'Film')}</div>
    <div class="sheet-meta">${esc(meta)}${m.vote_average ? '  ·  TMDB ' + m.vote_average.toFixed(1) : ''}</div>
    ${(m.directors && m.directors.length) ? `<div class="sheet-meta">${isTv ? 'Yaratıcı' : 'Yönetmen'}: ${esc(m.directors.join(', '))}</div>` : ''}
    ${(m.providers && m.providers.length) ? `<div class="chip-row">${m.providers.map((p) => `<span class="chip">${esc(p)}</span>`).join('')}${m.providerLink ? ` <a class="chip n" href="${m.providerLink}" target="_blank" rel="noopener">Nerede izlenir?</a>` : ''}</div>` : ''}
    ${(m.cast && m.cast.length) ? `<div class="sheet-meta">Oyuncular: ${esc(m.cast.join(', '))}</div>` : ''}

    <div class="actions">
      <button class="btn ${e && e.lists.watched ? 'is-on' : ''}" data-act="watched">👁️<span>İzledim</span></button>
      <button class="btn ${e && e.lists.favorite ? 'is-on' : ''}" data-act="favorite">❤️<span>Favori</span></button>
      <button class="btn ${e && e.lists.watchlist ? 'is-on' : ''}" data-act="watchlist">🔖<span>İzleyeceğim</span></button>
    </div>

    ${isTv ? `<label class="field-label">Nerede kaldım?</label>
    <div class="prog-row">
      <span class="prog-lab">Sezon</span>
      <input id="prog-s" class="input prog-in" type="number" min="1" max="${m.seasons || 40}" value="${(e && e.progress && e.progress.s) || ''}" placeholder="1" />
      <span class="prog-lab">Bölüm</span>
      <input id="prog-e" class="input prog-in" type="number" min="1" value="${(e && e.progress && e.progress.e) || ''}" placeholder="1" />
      <button class="btn btn-mini" data-prog="next">+1 bölüm</button>
      <button class="btn btn-mini" data-prog="clear">Sıfırla</button>
    </div>
    ${(e && e.progress && e.progress.s && m.seasons) ? `<div class="status">${Math.round((((e.progress.s - 1) / m.seasons) * 100))}% civarı ilerledin · ${m.seasons} sezonluk dizi</div>` : ''}` : ''}

    <label class="field-label">Puanım</label>
    <div class="rate">${Array.from({ length: 10 }, (_, i) =>
      `<button class="star ${e && e.myRating === i + 1 ? 'on' : ''}" data-rate="${i + 1}">${i + 1}</button>`).join('')}
      <button class="star" data-rate="0" title="Puanı kaldır">✕</button>
    </div>

    <label class="field-label" for="note">Notum</label>
    <textarea id="note" class="input" placeholder="Bu film hakkında ne düşündün?">${esc(e ? e.note : '')}</textarea>

    ${seriesHTML(m)}

    ${m.overview ? `<label class="field-label">Özet</label><p class="overview">${esc(m.overview)}</p>` : ''}
    ${loading ? '<p class="status">Detaylar yükleniyor…</p>' : ''}
    <p class="status"><a href="${'https://www.themoviedb.org/' + (isTv ? 'tv' : 'movie') + '/' + m.id}" target="_blank" rel="noopener">TMDB sayfası</a>${m.imdb_id ? ` · <a href="${'https://www.imdb.com/title/' + m.imdb_id + '/'}" target="_blank" rel="noopener">IMDb sayfası</a>` : ''}</p>
  </div>`;
}

function wireDetail(movie) {
  const body = $('#sheet-body');
  /* ÖNEMLİ: seri şeridindeki kartların hızlı ekleme düğmeleri de data-act taşır.
     Onları buraya bağlarsak şerittekine basıldığında açık olan yapım da
     işaretlenir. Bu yüzden sadece detayın kendi düğmeleri seçilir. */
  const ownActs = $$('[data-act]', body).filter((b) => !b.classList.contains('quick-btn') && !b.closest('.card-movie'));
  ownActs.forEach((b) => b.addEventListener('click', () => {
    toggleList(movie, b.dataset.act);
    body.innerHTML = renderDetail(db.movies[keyOf(movie)] || movie, false);
    wireDetail(movie);
    refreshActive();
  }));
  $$('[data-rate]', body).filter((b) => !b.closest('.card-movie')).forEach((b) => b.addEventListener('click', () => {
    const v = Number(b.dataset.rate);
    upsert(movie, { myRating: v || null });
    body.innerHTML = renderDetail(db.movies[keyOf(movie)] || movie, false);
    wireDetail(movie);
    refreshActive();
    toast(v ? 'Puanın: ' + v + '/10' : 'Puan kaldırıldı');
  }));
  const ps = $('#prog-s', body), pe = $('#prog-e', body);
  const saveProg = (sv, ev2) => {
    const sN = Number(sv) || null, eN = Number(ev2) || null;
    upsert(movie, { progress: sN ? { s: sN, e: eN } : null });
    body.innerHTML = renderDetail(db.movies[keyOf(movie)] || movie, false);
    wireDetail(movie);
    refreshActive();
    toast(sN ? 'Kaldığın yer: S' + sN + (eN ? 'B' + eN : '') : 'İlerleme sıfırlandı');
  };
  if (ps) ps.addEventListener('change', () => saveProg(ps.value, pe && pe.value));
  if (pe) pe.addEventListener('change', () => saveProg((ps && ps.value) || 1, pe.value));
  $$('[data-prog]', body).forEach((b) => b.addEventListener('click', () => {
    const cur = (db.movies[keyOf(movie)] || {}).progress || {};
    if (b.dataset.prog === 'clear') return saveProg(0, 0);
    saveProg(cur.s || 1, (cur.e || 0) + 1);
  }));

  const serBtn = $('[data-ser]', body);
  if (serBtn) serBtn.addEventListener('click', () => {
    const ser = seriesCache.get(keyOf(movie));
    if (!ser) return;
    let n = 0;
    ser.parts.forEach((p) => { if (!entry(keyOf(p))) { toggleList(p, 'watchlist'); n++; } });
    body.innerHTML = renderDetail(db.movies[keyOf(movie)] || movie, false);
    wireDetail(movie);
    refreshActive();
    toast(n + ' yapım izleyeceklerine eklendi');
  });

  const note = $('#note', body);
  if (note) note.addEventListener('change', () => { upsert(movie, { note: note.value }); toast('Not kaydedildi'); });
}

function closeSheet() {
  openId = null;
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
}

/* --------------------------- IMDb CSV ice aktarma ------------------------
   IMDb > Your Ratings > Export ile inen ratings.csv dosyasi. Her satirdaki
   IMDb kimligi (Const) TMDB /find ile eslenir, puan ve tarih tasinir. */

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}

async function importImdbCsv(file) {
  const st = $('#imdb-status');
  const setS = (cls, msg) => { st.className = 'status' + (cls ? ' ' + cls : ''); st.textContent = msg; };
  if (!getKey()) return setS('err', 'Önce TMDB anahtarını kaydet.');

  let rows;
  try { rows = parseCSV(await file.text()); } catch (e) { return setS('err', 'Dosya okunamadı.'); }
  if (rows.length < 2) return setS('err', 'CSV boş görünüyor.');

  const head = rows.shift().map((h) => h.replace(/^\uFEFF/, '').trim().toLowerCase());
  const find = (...names) => head.findIndex((h) => names.some((n) => h === n || h.indexOf(n) === 0));
  const iId = find('const', 'imdb id', 'imdbid');
  const iRate = find('your rating', 'rating');
  const iTitle = find('title', 'original title');
  const iDate = find('date rated', 'created', 'modified');
  if (iId < 0) return setS('err', 'CSV içinde IMDb kimlik kolonu (Const) yok. IMDb > Your Ratings > Export dosyasını seç.');

  await ensureGenres().catch(() => {});
  let added = 0, updated = 0, failed = 0;
  const misses = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const imdbId = String(r[iId] || '').trim();
    setS('', 'İçe aktarılıyor… ' + (i + 1) + '/' + rows.length + ' · yeni: ' + added + (failed ? ' · atlanan: ' + failed : ''));
    if (!IMDB_RE.test(imdbId)) { failed++; continue; }

    let hit = null, tries = 0;
    while (tries < 3 && !hit) {
      tries++;
      try { hit = (await searchByImdb(imdbId))[0] || null; break; }
      catch (e) {
        const rate = e && (e.status === 429 || /429|kota/i.test(String(e.message)));
        if (rate && tries < 3) { setS('', 'TMDB kotası doldu, 3 sn bekleniyor… (' + (i + 1) + '/' + rows.length + ')'); await sleep(3000); }
        else break;
      }
    }
    if (!hit) { failed++; if (misses.length < 8) misses.push(String(r[iTitle] || imdbId)); continue; }

    const k = keyOf(hit);
    const cur = db.movies[k];
    const rating = parseInt(r[iRate], 10);
    const patch = {
      lists: Object.assign({ watched: false, favorite: false, watchlist: false }, cur && cur.lists, { watched: true }),
      imdb_id: imdbId,
    };
    if (rating >= 1 && rating <= 10) patch.myRating = rating;
    const dt = iDate >= 0 ? new Date(r[iDate]) : null;
    if (dt && !isNaN(dt.getTime())) patch.addedAt = dt.toISOString();
    upsert(hit, patch);
    if (cur) updated++; else added++;
    if (i % 25 === 24) saveDB();
    await sleep(110);
  }

  saveDB(); refreshActive();
  setS('ok', '✓ ' + added + ' yeni, ' + updated + ' güncellenen kayıt.'
    + (failed ? ' ' + failed + ' satır eşlenemedi' + (misses.length ? ' (örn: ' + misses.slice(0, 4).join(', ') + ')' : '') + '.' : ''));
}

/* -------------------------------- routing -------------------------------- */

let activeView = 'search';
function go(view) {
  activeView = view;
  $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + view; });
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  const mainEl = $('#main');
  if (mainEl) mainEl.scrollTop = 0; else window.scrollTo({ top: 0 });
  refreshActive();
}
function refreshActive() {
  renderCounts();
  if (activeView === 'library') renderLibrary();
  if (activeView === 'stats') renderStats();
  if (activeView === 'search' && $('#q').value) runSearch($('#q').value);
}

/* ---------------------------------- init --------------------------------- */

function init() {
  renderCounts();

  // sekmeler
  $$('.tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.view)));
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  $('#btn-settings').addEventListener('click', () => go('settings'));

  // arama
  const q = $('#q');
  q.addEventListener('input', () => { $('#q-clear').hidden = !q.value; runSearch(q.value); });
  $('#q-clear').addEventListener('click', () => { q.value = ''; $('#q-clear').hidden = true; runSearch(''); q.focus(); });

  // liste sekmeleri
  $$('.seg-btn').forEach((b) => b.addEventListener('click', () => {
    $$('.seg-btn').forEach((x) => x.classList.remove('is-active'));
    b.classList.add('is-active');
    currentList = b.dataset.list;
    renderLibrary();
  }));
  $('#lib-filter').addEventListener('input', renderLibrary);
  $('#lib-sort').addEventListener('change', renderLibrary);
  $('#lib-series').addEventListener('change', renderLibrary);
  $('#ser-gaps').addEventListener('change', renderSeriesView);
  $('#ser-scan').addEventListener('click', () => scanSeries(false));
  $('#ser-rescan').addEventListener('click', () => scanSeries(true));

  // bir serinin eksik halkalarını topluca izleyeceklerime ekle
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sergroup]');
    if (!b) return;
    const g = seriesGroups().find((x) => x.id === b.dataset.sergroup);
    if (!g) return;
    let n = 0;
    g.notInDb.forEach((p) => {
      upsert(p, { lists: { watched: false, favorite: false, watchlist: true } });
      n++;
    });
    renderSeriesView();
    toast(n + ' yapım izleyeceklerine eklendi');
  });

  // öneriler
  $('#rec-refresh').addEventListener('click', () => { bumpRound(); buildRecs(); });
  document.querySelector('.tab[data-view="recs"]').addEventListener('click', () => {
    // sekmeye her girildiğinde boşuna sorgu atma; liste doluysa olduğu gibi kalsın
    if (!$('#rec-results').children.length) buildRecs();
  });

  // kart tıklama (delegasyon)
  document.addEventListener('click', (ev) => {
    const quick = ev.target.closest('.quick-btn');
    if (quick) {
      ev.preventDefault(); ev.stopPropagation();
      const id = quick.dataset.id;
      const src = cacheMovies.get(String(id)) || db.movies[String(id)];
      if (!src) return;
      toggleList(src, quick.dataset.act);
      refreshCard(id);
      if (activeView === 'library') renderLibrary();
      return;
    }
    const hit = ev.target.closest('[data-id]');
    const card = hit && hit.closest('.card-movie');
    if (card) openMovie(hit.dataset.id);
  });

  // klavye ile afiş açma
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const p = ev.target.closest('.card-movie .poster[data-id]');
    if (p) { ev.preventDefault(); openMovie(p.dataset.id); }
  });

  // sheet kapatma
  $$('[data-close]').forEach((el) => el.addEventListener('click', closeSheet));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  // ayarlar
  const keyInput = $('#apikey');
  keyInput.value = getKey();
  $('#apikey-save').addEventListener('click', async () => {
    localStorage.setItem(LS.key, keyInput.value.trim());
    const s = $('#apikey-status');
    s.className = 'status'; s.textContent = 'Doğrulanıyor…';
    try {
      await tmdb('/configuration');
      db.genres = {}; await ensureGenres();
      renderProviderPicker();
      s.className = 'status ok'; s.textContent = '✓ Anahtar çalışıyor. Artık film ve dizi arayabilirsin.';
      refreshKeyPrompts();
    } catch (err) { s.className = 'status err'; s.textContent = err.message; }
  });

  const lang = $('#lang');
  lang.value = getLang();
  lang.addEventListener('change', () => { localStorage.setItem(LS.lang, lang.value); db.genres = {}; saveDB(); localStorage.removeItem(LS.provcache); renderProviderPicker(); toast('Dil güncellendi'); });

  // veri
  renderBackupStatus();
  const keyBox = $('#export-keys');
  keyBox.checked = localStorage.getItem('izlence.exportkeys') === '1';
  keyBox.addEventListener('change', () => {
    localStorage.setItem('izlence.exportkeys', keyBox.checked ? '1' : '0');
    $('#keys-warn').hidden = !keyBox.checked;
  });
  $('#keys-warn').hidden = !keyBox.checked;

  $('#export').addEventListener('click', () => {
    const withKeys = keyBox.checked;
    const out = Object.assign({}, db, { app: { name: APP.name, version: APP.version } });
    if (withKeys) {
      out.keys = {
        tmdb: localStorage.getItem(LS.key) || '',
        google: localStorage.getItem(LS.gkey) || '',
        gmodel: localStorage.getItem(LS.gmodel) || '',
        lang: getLang(),
        providers: getProviders(),
      };
    }
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'izlence' + (withKeys ? '-anahtarli-' : '-') + new Date().toISOString().slice(0, 10) + '.json';
    a.click(); URL.revokeObjectURL(a.href);
    const st = $('#data-status');
    st.className = 'status' + (withKeys ? '' : ' ok');
    st.textContent = withKeys
      ? '⚠️ Yedek indirildi — içinde API anahtarların var, bu dosyayı kimseyle paylaşma.'
      : '✓ Yedek indirildi (anahtarlar dahil edilmedi).';
    toast('Yedek indirildi');
    localStorage.setItem(LS.lastbackup, String(Date.now()));
    renderBackupStatus();
  });
  $('#imdb-btn').addEventListener('click', () => $('#imdb-csv').click());
  $('#imdb-csv').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (f) importImdbCsv(f);
  });

  // platform filtresi
  renderProviderPicker();
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-prov]');
    if (!t) return;
    const id = String(t.dataset.prov);
    const cur = getProviders();
    const idx = cur.indexOf(id);
    if (idx >= 0) cur.splice(idx, 1); else cur.push(id);
    setProviders(cur);
    t.classList.toggle('is-on', idx < 0);
    provStatus();
  });
  $('#prov-clear').addEventListener('click', () => {
    setProviders([]);
    $$('[data-prov]').forEach((b) => b.classList.remove('is-on'));
    provStatus();
  });

  // uygulama bilgileri
  $('#app-version').textContent = 'v' + APP.version;
  $('#app-build').textContent = APP.build;
  $('#app-dev').textContent = APP.developer;

  $('#import-btn').addEventListener('click', () => $('#import').click());
  $('#import').addEventListener('change', (ev) => {
    const file = ev.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      const s = $('#data-status');
      try {
        const inc = JSON.parse(r.result);
        if (!inc || typeof inc.movies !== 'object') throw new Error('biçim');
        let added = 0;
        Object.entries(inc.movies).forEach(([id, m]) => { if (!db.movies[id]) added++; db.movies[id] = m; });
        if (inc.genres) db.genres = Object.assign({}, inc.genres, db.genres);
        if (inc.aiMemory) { db.aiMemory = trimMemory(inc.aiMemory); localStorage.setItem(LS.memory, db.aiMemory); }

        // anahtarlar (yedek anahtarlı alındıysa)
        let keyNote = '';
        const k = inc.keys;
        if (k && (k.tmdb || k.google)) {
          if (k.tmdb) { localStorage.setItem(LS.key, k.tmdb); const ki = $('#apikey'); if (ki) ki.value = k.tmdb; }
          if (k.google) { localStorage.setItem(LS.gkey, k.google); const gi = $('#gkey'); if (gi) gi.value = k.google; }
          if (k.gmodel) localStorage.setItem(LS.gmodel, k.gmodel);
          if (k.lang) { localStorage.setItem(LS.lang, k.lang); const li = $('#lang'); if (li) li.value = k.lang; }
          if (Array.isArray(k.providers)) setProviders(k.providers);
          refreshKeyPrompts();
          db.genres = {};
          ensureGenres().then(() => refreshActive()).catch(() => {});
          renderProviderPicker();
          if (typeof initAI === 'function') { try { restoreAI(); } catch (e) {} }
          keyNote = ' API anahtarları da geri yüklendi — tekrar girmene gerek yok.';
        }

        saveDB(); refreshActive();
        s.className = 'status ok'; s.textContent = `✓ İçe aktarıldı: ${added} yeni kayıt (toplam ${Object.keys(db.movies).length}).` + keyNote;
      } catch (e) { s.className = 'status err'; s.textContent = 'Dosya okunamadı. Geçerli bir İzlence JSON yedeği seç.'; }
    };
    r.readAsText(file);
    ev.target.value = '';
  });
  $('#wipe').addEventListener('click', () => {
    if (!confirm('Tüm listelerin, puanların ve notların silinecek. Emin misin?')) return;
    db = JSON.parse(JSON.stringify(DEFAULT_DB));
    saveDB(); refreshActive();
    $('#data-status').textContent = 'Tüm veri silindi.';
  });

  // kurulum
  let deferred;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#install').hidden = false; });
  $('#install').addEventListener('click', async () => { if (deferred) { deferred.prompt(); deferred = null; $('#install').hidden = true; } });

  refreshKeyPrompts();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        swReg = reg;
        // yeni surum indi ve beklemede -> bandi goster
        if (reg.waiting) showUpdateBar();
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar();
          });
        });
      }).catch(() => {});
    });
    // yeni service worker devraldiginda tek sefer yenile
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  }

  blockZoom();
  backupReminder();

  checkUpdate(false);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkUpdate(false);
  });
  const upBtn = $('#update-now');
  if (upBtn) upBtn.addEventListener('click', applyUpdate);
  const chk = $('#check-update');
  if (chk) chk.addEventListener('click', () => checkUpdate(true));
}

/* --------------------------- yakinlastirmayi kapat ------------------------
   iOS Safari viewport'taki user-scalable=no'yu yok sayiyor; parmakla
   yakinlastirma icin gesture olaylarini, cift dokunus icin de ikinci
   dokunusu engelliyoruz. Tek dokunus, kaydirma ve yatay kaydirma calisir. */

function blockZoom() {
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => {
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  });
  let lastAt = 0, lastX = 0, lastY = 0;
  document.addEventListener('touchend', (e) => {
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const now = Date.now();
    const near = Math.abs(t.clientX - lastX) < 40 && Math.abs(t.clientY - lastY) < 40;
    // yalnizca ayni noktaya gelen hizli ikinci dokunusu engelle; boylece
    // farkli dugmelere art arda basmak calismaya devam eder
    if (now - lastAt < 320 && near) e.preventDefault();
    lastAt = now; lastX = t.clientX; lastY = t.clientY;
  }, { passive: false });
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
}

/* --------------------------- anahtar cagrilarini gizle --------------------
   Anahtar kaydedildikten sonra bos ekranlardaki "anahtar ekle" dugmeleri
   duruyordu; anahtar varsa dugme ve metin gizlenir. */

function refreshKeyPrompts() {
  const sBtn = $('#search-key-cta');
  if (sBtn) sBtn.hidden = !!getKey();

  const aBtn = $('#ai-key-cta');
  if (aBtn) aBtn.hidden = !!getGKey();

  const aTxt = $('#ai-empty-text');
  if (aTxt) {
    aTxt.textContent = getGKey()
      ? 'En az 3 film ekle, sonra "Oneri iste" dugmesine bas. Gemini zevkini yorumlayip neden onerdigini de yazar.'
      : 'Ucretsiz bir Google AI Studio anahtari gir, en az 3 film ekle. Gemini zevkini yorumlayip neden onerdigini de yazar.';
  }
}

/* ------------------------------- yedek uyarisi ----------------------------
   Veriler yalnizca tarayicida duruyor; tarayici verisi temizlenince gidiyor.
   Otuz gundur yedek alinmadiysa Ayarlar'da uyari, acilista da bir hatirlatma. */

LS.lastbackup = 'izlence.lastbackup';
const BACKUP_DUE = 30 * 24 * 60 * 60 * 1000;

function backupAge() {
  const t = parseInt(localStorage.getItem(LS.lastbackup) || '0', 10);
  return t ? Date.now() - t : null;   // null: hic yedek alinmamis
}

function backupDue() {
  if (allItems().length < 10) return false;   // yeni kullanicilari rahatsiz etme
  const age = backupAge();
  return age === null || age > BACKUP_DUE;
}

function renderBackupStatus() {
  const el = $('#backup-status');
  if (!el) return;
  const age = backupAge();
  const days = age === null ? null : Math.floor(age / 86400000);
  if (!backupDue()) {
    el.className = 'status';
    el.textContent = days === null ? '' : 'Son yedek ' + (days === 0 ? 'bugun alindi.' : days + ' gun once alindi.');
    return;
  }
  el.className = 'status err';
  el.textContent = days === null
    ? 'Henuz yedek almadin. Tarayici verisi temizlenirse listelerin siler.'
    : 'Son yedegin ' + days + ' gunluk. Yeni bir yedek almanin tam zamani.';
}

function backupReminder() {
  if (!backupDue()) return;
  const shown = sessionStorage.getItem('izlence.backupnag');
  if (shown) return;
  try { sessionStorage.setItem('izlence.backupnag', '1'); } catch (e) { /* yoksay */ }
  setTimeout(() => toast('Yedek almayali cok oldu - Ayarlar > JSON disa aktar'), 2500);
}

/* ------------------------------ surum kontrolu ---------------------------
   iOS'ta ana ekrana eklenen PWA eski kabuga takilabiliyor. Uygulama acildikca
   (ve one geldikce) sunucudaki version.json okunur; surum farkliysa ust bantta
   guncelleme cikar, kullanici dokununca tum onbellek temizlenip yeniden yuklenir.
   -------------------------------------------------------------------------- */

let swReg = null;
let lastCheck = 0;
const CHECK_TTL = 30 * 60 * 1000; // en fazla yarim saatte bir

function showUpdateBar(remote) {
  const bar = $('#update-bar');
  if (!bar) return;
  const t = $('#update-text');
  if (t) t.textContent = remote
    ? 'Yeni surum hazir: v' + remote + ' (senin surumun v' + APP.version + ')'
    : 'Yeni surum hazir.';
  bar.hidden = false;
}

async function checkUpdate(manual) {
  const st = $('#update-status');
  if (!manual && Date.now() - lastCheck < CHECK_TTL) return;
  lastCheck = Date.now();
  if (manual && st) { st.className = 'status'; st.textContent = 'Kontrol ediliyor...'; }
  if (swReg) swReg.update().catch(() => {});
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    const remote = String(d.version || '').trim();
    if (remote && remote !== APP.version) {
      showUpdateBar(remote);
      if (manual && st) { st.className = 'status'; st.textContent = 'Yeni surum var: v' + remote; }
    } else if (manual && st) {
      st.className = 'status ok'; st.textContent = 'Guncelsin (v' + APP.version + ').';
    }
  } catch (e) {
    if (manual && st) { st.className = 'status err'; st.textContent = 'Surum bilgisi alinamadi. Baglantini kontrol et.'; }
  }
}

async function applyUpdate() {
  const btn = $('#update-now');
  if (btn) { btn.disabled = true; btn.textContent = 'Guncelleniyor...'; }
  try {
    if (swReg && swReg.waiting) swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
  } catch (e) { /* yoksay */ }
  // onbellegi atlayarak yeniden yukle
  location.replace(location.pathname + '?v=' + Date.now());
}

document.addEventListener('DOMContentLoaded', init);

/* ==========================================================================
   AI ÖNERİLERİ — Google Gemini (isteğe bağlı)
   Anahtar kullanıcının kendi cihazında saklanır; sunucu/proxy gerekmez.
   ========================================================================== */

LS.gkey = 'izlence.gkey';
LS.gmodel = 'izlence.gmodel';
LS.memory = 'izlence.aimemory';
LS.airecs = 'izlence.airecs';
LS.gmodels = 'izlence.gmodels2';  // keşfedilen model listesi (cache)
LS.glast = 'izlence.glastmodel'; // en son başarılı model

const getGKey = () => (localStorage.getItem(LS.gkey) || '').trim();
const getGPref = () => localStorage.getItem(LS.gmodel) || 'auto';
const getMemory = () => localStorage.getItem(LS.memory) || '';

/* Hafiza her istekte modele geri veriliyor; sinirsiz buyurse istem sisip
   kotayi hizli tuketir. Cumle sinirinda kesip son 1200 karakteri tutuyoruz. */
const MEMORY_MAX = 1200;
function trimMemory(text) {
  const t = String(text || '').trim();
  if (t.length <= MEMORY_MAX) return t;
  const cut = t.slice(t.length - MEMORY_MAX);
  const dot = cut.search(/[.!?]\s/);
  return (dot > -1 && dot < 200 ? cut.slice(dot + 2) : cut).trim();
}

/* -------------------- model keşfi: en güncel ücretsiz model ----------------
   Google model adları zamanla değişiyor (2.5 -> 3.0 ...). Sabit isim yazmak
   yerine anahtarın erişebildiği modelleri API'den listeleyip puanlıyoruz.
   -------------------------------------------------------------------------- */

const GAPI = 'https://generativelanguage.googleapis.com/v1beta';
const MODELS_TTL = 12 * 60 * 60 * 1000; // 12 saat

// ücretsiz katmanda anlamsız / uyumsuz olanlar
const MODEL_DENY = /embedding|aqa|imagen|veo|image-generation|tts|native-audio|live|robotics|learnlm|gemma/i;

function scoreModel(id) {
  // id örn: "gemini-2.5-flash", "gemini-3-pro-preview"
  // Siralama yetenek onceligine gore: once en yeni surumun en guclu modeli,
  // kota/erisim hatasinda zincir kademe kademe daha hafif modellere iner.
  let score = 0;
  const v = id.match(/gemini-(\d+)(?:[.-](\d+))?/);
  if (v) score += (parseInt(v[1], 10) * 1000) + (parseInt(v[2] || '0', 10) * 100); // sürüm en baskın
  if (/ultra/.test(id)) score += 50;          // varsa en tepedeki model
  else if (/pro/.test(id)) score += 40;       // en yetenekli yaygın kademe
  else if (/flash-lite/.test(id)) score += 10;
  else if (/flash/.test(id)) score += 20;
  if (/thinking/.test(id)) score += 5;        // aynı kademede daha güçlü akıl yürütme
  if (/preview|exp/.test(id)) score -= 2;     // eşitlikte kararlı sürüm öne geçsin
  if (/latest/.test(id)) score -= 1;          // takma ad, sabit sürüm tercih edilir
  if (/8b|nano|lite/.test(id)) score -= 3;
  return score;
}

function prettyModel(id) {
  return id
    .replace(/^gemini-/, 'Gemini ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace('Flash Lite', 'Flash-Lite');
}

// güvenlik ağı: liste çekilemezse bunları sırayla dene
const FALLBACK_MODELS = [
  'gemini-3.8-pro',
  'gemini-3.8-flash',
  'gemini-3-pro-preview',
  'gemini-2.5-pro',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
];

function cachedModels() {
  try {
    const c = JSON.parse(localStorage.getItem(LS.gmodels) || 'null');
    if (c && Array.isArray(c.ids) && c.ids.length) {
      c.ids = c.ids.slice().sort((a, b) => scoreModel(b) - scoreModel(a));
      return c;
    }
  } catch (e) { /* yoksay */ }
  return null;
}

async function discoverModels(force) {
  const cached = cachedModels();
  if (!force && cached && Date.now() - cached.at < MODELS_TTL) return cached.ids;
  if (!getGKey()) return cached ? cached.ids : FALLBACK_MODELS.slice();

  try {
    const r = await fetch(GAPI + '/models?pageSize=200', { headers: { 'x-goog-api-key': getGKey() } });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    const ids = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1)
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((id) => /^gemini-/.test(id) && !MODEL_DENY.test(id))
      .sort((a, b) => scoreModel(b) - scoreModel(a));
    if (!ids.length) throw new Error('bos');
    localStorage.setItem(LS.gmodels, JSON.stringify({ at: Date.now(), ids }));
    return ids;
  } catch (e) {
    return cached ? cached.ids : FALLBACK_MODELS.slice();
  }
}

// Denenecek sıra: son çalışan -> kullanıcı seçimi -> keşfedilen sıra -> yedekler
async function modelChain() {
  const discovered = await discoverModels(false);
  const pref = getGPref();
  const last = localStorage.getItem(LS.glast);
  const chain = [];
  const push = (id) => { if (id && chain.indexOf(id) === -1) chain.push(id); };

  if (pref !== 'auto') push(pref);   // kullanıcı elle seçtiyse önce o
  discovered.forEach(push);          // otomatikte en tepedeki modelden başla
  push(last);                        // en son çalışan model son çare olarak da dursun
  FALLBACK_MODELS.forEach(push);
  return chain.slice(0, 8);          // en fazla 8 deneme
}

const REC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    memory: { type: 'STRING' },
    recommendations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },       // TMDB'de aranacak orijinal başlık
          year: { type: 'INTEGER' },
          reason: { type: 'STRING' },      // Türkçe, 1-2 cümle gerekçe
          mood: { type: 'STRING' },        // kısa etiket: "yavaş tempolu dram" vb.
        },
        required: ['title', 'year', 'reason'],
      },
    },
  },
  required: ['recommendations'],
};

async function gemini(prompt, onTry) {
  const key = getGKey();
  if (!key) throw new ApiError('Google AI anahtarı yok. Ayarlar sekmesinden ekle.');

  const chain = await modelChain();
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 1.0,
      responseMimeType: 'application/json',
      responseSchema: REC_SCHEMA,
    },
  });

  let lastErr = null;
  const tried = [];

  for (const model of chain) {
    if (onTry) onTry(model, tried.length, chain.length);
    let res;
    try {
      res = await fetch(GAPI + '/models/' + model + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body,
      });
    } catch (e) {
      throw new ApiError('Google AI’a ulaşılamıyor. İnternet bağlantını kontrol et.');
    }

    // anahtar hatası: model değiştirmek fayda etmez, hemen çık
    if (res.status === 401 || res.status === 403) {
      throw new ApiError('Anahtar geçersiz veya yetkisiz (' + res.status + '). Ayarlar’dan Google AI anahtarını kontrol et.');
    }

    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
      if (text) {
        try {
          const parsed = JSON.parse(text);
          localStorage.setItem(LS.glast, model);   // bir dahakine önce bunu dene
          parsed.__model = model;
          parsed.__tried = tried.slice();
          return parsed;
        } catch (e) {
          lastErr = 'yanıt çözümlenemedi';
        }
      } else {
        lastErr = 'boş yanıt';
      }
    } else if (res.status === 404) {
      lastErr = 'model bulunamadı';
    } else if (res.status === 429) {
      lastErr = 'kota doldu';
    } else if (res.status >= 500) {
      lastErr = 'sunucu hatası ' + res.status;
    } else if (res.status === 400) {
      lastErr = 'istek reddedildi (400)';
    } else {
      lastErr = 'hata ' + res.status;
    }

    tried.push(model + ' → ' + lastErr);   // sıradaki modele geç
  }

  throw new ApiError(
    'Hiçbir model yanıt vermedi. Denenenler: ' + tried.join(', ') +
    (String(lastErr).indexOf('kota') !== -1 ? ' · Ücretsiz kota yenilenince tekrar dene.' : '')
  );
}

/* --------------------------- istem (prompt) kurulumu --------------------- */

function buildPrompt(userAsk) {
  const p = tasteProfile();
  const line = (m) => `${m.title} (${year(m.release_date)})${m.myRating ? ' — puanım ' + m.myRating + '/10' : ''}${m.note ? ' — notum: ' + m.note.slice(0, 120) : ''}`;

  const favs = listItems('favorite').map(line);
  const loved = listItems('watched').filter((m) => m.myRating >= 8).map(line);
  const meh = listItems('watched').filter((m) => m.myRating && m.myRating <= 5).map(line);
  const plan = listItems('watchlist').map((m) => `${m.title} (${year(m.release_date)})`);
  const seen = allItems().map((m) => `${m.title} (${year(m.release_date)})`);

  const genres = p.topGenres.map(([g, w]) => `${genreName(g)} %${Math.round((w / p.total) * 100)}`).join(', ');
  const people = p.topPeople.slice(0, 6).map(([n]) => n).join(', ');
  const mem = getMemory();

  return `Sen bir sinema ve dizi küratörüsün. Kullanıcının izleme günlüğünü inceleyip ona 8 yapım (film veya dizi) önereceksin.

${mem ? `## Daha önce bu kullanıcı hakkında öğrendiklerin\n${mem}\n` : ''}
## Baskın türleri
${genres || 'henüz belirsiz'}

## Sık çıkan isimler
${people || 'henüz belirsiz'}

## Favorileri
${favs.join('\n') || 'yok'}

## Çok beğendikleri (8+ puan)
${loved.join('\n') || 'yok'}

## Beğenmedikleri (5 ve altı)
${meh.join('\n') || 'yok'}

## İzlemeyi planladıkları (bunları önerme, ama zevk sinyali olarak kullan)
${plan.join('\n') || 'yok'}

## Kesinlikle önermemen gerekenler (zaten listesinde)
${seen.join(' | ') || 'yok'}

${userAsk ? `## Kullanıcının bu seferki özel isteği\n"${userAsk}"\nBu isteği her şeyin önünde tut.\n` : ''}
Kurallar:
- Yukarıdaki "önermemen gerekenler" listesindeki hiçbir filmi tekrarlama.
- Gerçekten var olan filmler öner; "title" alanına filmin ORJİNAL başlığını yaz (TMDB'de aranacak), "year" alanına doğru vizyon yılını.
- Önerilerin 8 tanesi olsun; en az 2 tanesi az bilinen ama isabetli bir keşif olsun.
- Kullanıcının listesinde dizi de varsa önerilerin en az 2-3 tanesi dizi olsun; "type" alanına "film" veya "dizi" yaz.
- "reason" alanını Türkçe yaz, 1-2 cümle, ve MUTLAKA kullanıcının kendi listesinden somut bir filme bağla (örn. "Shutter Island'a verdiğin 8 puanı düşünürsek...").
- "mood" alanına 2-4 kelimelik Türkçe bir etiket yaz.
- "memory" alanına, bu kullanıcının zevkini bir sonraki sefere taşıyacak 3-5 cümlelik kalıcı bir profil notu yaz (Türkçe). Varsa önceki notu güncelle, sıfırdan yazma.`;
}

/* ------------------------------ TMDB ile eşleme -------------------------- */

async function resolveMovie(rec) {
  if (!getKey()) return null;
  try {
    let hits = await searchTitles(rec.title, { year: rec.year });
    if (!hits.length) hits = await searchTitles(rec.title);
    if (rec.type) {
      const want = rec.type === 'dizi' || rec.type === 'tv' ? 'tv' : 'movie';
      const typed = hits.filter((h) => h.mtype === want);
      if (typed.length) hits = typed;
    }
    return hits[0] || null;
  } catch (e) { return null; }
}

/* --------------------------------- render -------------------------------- */

function aiCardHTML(item) {
  const m = item.movie;
  const inLib = m && db.movies[keyOf(m)];
  const poster = m && m.poster_path
    ? `<img loading="lazy" src="${IMG}w185${m.poster_path}" alt="" />`
    : `<div class="poster-fallback">🎞️</div>`;
  const title = m ? m.title : item.rec.title;
  const yr = m ? year(m.release_date) : item.rec.year;
  const sub = [m ? typeLabel(m) : null, yr, m && m.vote_average ? 'TMDB ' + m.vote_average.toFixed(1) : null].filter(Boolean).join(' · ');

  return `<button class="ai-card" ${m ? `data-id="${keyOf(m)}"` : 'disabled style="cursor:default"'}>
    <div class="ai-poster">${poster}</div>
    <div class="ai-body">
      <div class="ai-name">${esc(title)}</div>
      <div class="ai-sub">${esc(sub)}</div>
      <div class="ai-why">${esc(item.rec.reason || '')}</div>
      ${item.rec.mood ? `<span class="ai-tag">${esc(item.rec.mood)}</span>` : ''}
      ${inLib ? '<span class="ai-tag warn">Zaten listende</span>' : ''}
      ${!m ? '<span class="ai-tag warn">TMDB’de eşlenemedi</span>' : ''}
    </div>
  </button>`;
}

function renderMemory() {
  const box = $('#ai-memory-box'), txt = $('#ai-memory-text');
  const mem = getMemory();
  box.hidden = !mem;
  txt.textContent = mem;
}

function renderAIResults(items) {
  $('#ai-results').innerHTML = items.map(aiCardHTML).join('');
}

/* --------------------------------- akış ---------------------------------- */

async function runAI() {
  const status = $('#ai-status'), empty = $('#ai-empty'), btn = $('#ai-run');
  const ask = $('#ai-prompt').value.trim();

  if (!getGKey()) { status.className = 'status err'; status.textContent = 'Ayarlar’dan Google AI anahtarını ekle.'; return; }
  if (allItems().length < 3) { status.className = 'status err'; status.textContent = 'En az 3 film ekledikten sonra AI önerisi isteyebilirsin.'; return; }

  empty.hidden = true;
  btn.disabled = true;
  status.className = 'status'; status.textContent = 'Gemini zevk profilini okuyor…';

  try {
    await ensureGenres().catch(() => {});
    const out = await gemini(buildPrompt(ask), (model, i, total) => {
      status.textContent = i === 0
        ? prettyModel(model) + ' zevk profilini okuyor…'
        : prettyModel(model) + ' deneniyor… (' + (i + 1) + '/' + total + ')';
    });
    const recs = (out.recommendations || []).slice(0, 10);
    if (!recs.length) throw new ApiError('Model öneri üretmedi. Tekrar dene.');

    status.textContent = 'Filmler TMDB ile eşleniyor…';
    const items = [];
    for (const rec of recs) {
      const movie = await resolveMovie(rec);
      if (movie) cacheMovies.set(String(movie.id), movie);
      items.push({ rec, movie });
    }

    if (out.memory) {
      const mem = trimMemory(out.memory);
      localStorage.setItem(LS.memory, mem);
      db.aiMemory = mem; saveDB();
      renderMemory();
    }
    localStorage.setItem(LS.airecs, JSON.stringify({ at: Date.now(), ask, items }));

    renderAIResults(items);
    const matched = items.filter((i) => i.movie).length;
    status.className = 'status ok';
    const fellBack = (out.__tried && out.__tried.length)
      ? ' · ' + out.__tried.length + ' model atlandı'
      : '';
    status.textContent = items.length + ' öneri · ' + matched + ' tanesi TMDB’de eşlendi · '
      + prettyModel(out.__model || '') + fellBack;
  } catch (err) {
    status.className = 'status err';
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function restoreAI() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS.airecs) || 'null');
    if (saved && saved.items && saved.items.length) {
      saved.items.forEach((i) => { if (i.movie) cacheMovies.set(String(i.movie.id), i.movie); });
      renderAIResults(saved.items);
      $('#ai-empty').hidden = true;
      const mins = Math.round((Date.now() - saved.at) / 60000);
      $('#ai-status').textContent = 'Son öneri listesi' + (mins < 1 ? ' · az önce' : ` · ${mins} dk önce`);
      if (saved.ask) $('#ai-prompt').value = saved.ask;
    }
  } catch (e) { /* yoksay */ }
}

/* ---------------------------------- init --------------------------------- */

function initAI() {
  const gkey = $('#gkey'), gmodel = $('#gmodel');
  gkey.value = getGKey();

  // seçici: "Otomatik" + anahtarın erişebildiği gerçek modeller
  function fillModels(ids) {
    const pref = getGPref();
    const best = ids && ids.length ? ids[0] : null;
    const opts = ['<option value="auto">Otomatik — en güçlü model, hata olursa alta iner'
      + (best ? ' (' + prettyModel(best) + ')' : '') + '</option>'];
    (ids || []).forEach((id) => {
      opts.push('<option value="' + id + '">' + prettyModel(id) + '</option>');
    });
    gmodel.innerHTML = opts.join('');
    gmodel.value = (ids || []).indexOf(pref) !== -1 ? pref : 'auto';
  }

  const cached = cachedModels();
  fillModels(cached ? cached.ids : FALLBACK_MODELS);

  async function refreshModels(force) {
    const s = $('#gkey-status');
    if (!getGKey()) return;
    s.className = 'status'; s.textContent = 'Kullanılabilir modeller taranıyor…';
    try {
      const r = await fetch(GAPI + '/models?pageSize=200', { headers: { 'x-goog-api-key': getGKey() } });
      if (r.status === 400 || r.status === 401 || r.status === 403) throw new ApiError('Anahtar geçersiz görünüyor (' + r.status + '). AI Studio’dan yeni bir anahtar al.');
      if (!r.ok) throw new ApiError('Google AI yanıt vermedi (' + r.status + '). Kayıtlı model listesi kullanılacak.');
      localStorage.removeItem(LS.gmodels);
      const ids = await discoverModels(true);
      fillModels(ids);
      s.className = 'status ok';
      s.textContent = '✓ Anahtar çalışıyor · ' + ids.length + ' model bulundu · seçilen: ' + prettyModel(ids[0]);
    } catch (err) {
      s.className = 'status err'; s.textContent = err.message;
    }
  }

  $('#gkey-save').addEventListener('click', () => {
    localStorage.setItem(LS.gkey, gkey.value.trim());
    localStorage.removeItem(LS.glast);
    refreshKeyPrompts();
    refreshModels(true);
  });

  gmodel.addEventListener('change', () => {
    localStorage.setItem(LS.gmodel, gmodel.value);
    toast(gmodel.value === 'auto' ? 'Model seçimi otomatik' : 'Model: ' + prettyModel(gmodel.value));
  });

  // arka planda sessizce tazele (12 saatte bir)
  if (getGKey()) discoverModels(false).then(fillModels).catch(() => {});

  $('#ai-run').addEventListener('click', runAI);
  $('#ai-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runAI();
  });
  $('#ai-memory-clear').addEventListener('click', () => {
    localStorage.removeItem(LS.memory); renderMemory(); toast('AI hafızası sıfırlandı');
  });

  renderMemory();
  restoreAI();
}

document.addEventListener('DOMContentLoaded', initAI);

/* ------------------- kurulum rehberi: kopyala butonları ------------------ */
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('.copy-btn');
  if (!b) return;
  const text = b.dataset.copy || '';
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    const old = b.textContent; b.textContent = '✓ Kopyalandı';
    setTimeout(() => { b.textContent = old; }, 1400);
  } catch (e) { toast('Kopyalanamadı, elle seçip kopyalayabilirsin'); }
});
