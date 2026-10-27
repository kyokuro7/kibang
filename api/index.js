// Unofficial API untuk mirainime.com (metadata saja)
// Jalankan: npm i express cheerio && node server.js
const express = require("express");
const cheerio = require("cheerio");

const BASE = "https://mirainime.com";
const app = express();

// CORS: izinkan website memanggil API dari browser.
// Untuk lebih ketat, isi env ALLOW_ORIGIN dengan domain websitemu (mis. https://anime.rexxgraph.my.id).
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.set("Access-Control-Allow-Headers", "x-api-key, content-type");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
const cache = new Map();

// Rate limit sederhana per IP: 60 request/menit.
// Catatan: hitungannya per instance serverless, jadi ini pengaman dasar saja.
const hits = new Map();
const LIMIT = 60;
const WINDOW = 60 * 1000;
app.use((req, res, next) => {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.reset) {
    h = { n: 0, reset: now + WINDOW };
    hits.set(ip, h);
  }
  h.n++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);

  res.set("X-RateLimit-Limit", String(LIMIT));
  res.set("X-RateLimit-Remaining", String(Math.max(0, LIMIT - h.n)));
  if (h.n > LIMIT) {
    res.set("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
    res.set("Cache-Control", "no-store");
    return res.status(429).json({ ok: false, error: "Terlalu banyak request, coba lagi sebentar" });
  }
  next();
});

// API key: kalau env API_KEY diisi, semua request wajib kirim header "x-api-key".
// Kalau API_KEY kosong, API terbuka untuk umum.
const crypto = require("crypto");
const API_KEY = process.env.API_KEY || "";
const sameKey = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (sameKey(req.get("x-api-key") || "", API_KEY)) return next();
  res.set("Cache-Control", "no-store");
  res.status(401).json({ ok: false, error: "API key salah atau tidak ada" });
});

// Tanpa API key: boleh disimpan di edge Vercel (publik).
// Dengan API key: jangan di-cache publik, supaya respons tidak bocor ke yang tidak punya key.
app.use((req, res, next) => {
  res.set(
    "Cache-Control",
    API_KEY ? "private, max-age=300" : "public, s-maxage=300, stale-while-revalidate=600"
  );
  next();
});
const TTL = 5 * 60 * 1000; // cache 5 menit supaya tidak membebani situs

async function getHtml(path) {
  const url = path.startsWith("http") ? path : BASE + path;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < TTL) return hit.html;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; UnofficialAPI/1.0)" },
  });
  if (!res.ok) throw new Error(`Upstream ${res.status} untuk ${url}`);
  const html = await res.text();
  cache.set(url, { html, t: Date.now() });
  return html;
}

const abs = (u) => (u ? new URL(u, BASE).href : null);
const slugOf = (href) => (href.match(/\/anime\/([^/?#]+)/) || [])[1];

// Info tambahan dari teks kartu: skor, nomor episode, tipe
function cardInfo(text) {
  const t = text.replace(/\s+/g, " ");
  const score = t.match(/[★⭐]\s*(\d+(?:\.\d+)?)/);
  const ep = t.match(/\bEP\s*(\d+)/i) || t.match(/(\d+)\s*EP\b/i);
  const type = t.match(/\b(TV|ONA|OVA|Movie|Special)\b/);
  return {
    score: score ? Number(score[1]) : null,
    episode: ep ? Number(ep[1]) : null,
    type: type ? type[1] : null,
  };
}

// Ambil kartu anime dari link /anime/{slug} (tanpa /episode/)
function parseAnimeLinks($) {
  const bySlug = new Map();
  $('a[href*="/anime/"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    if (href.includes("/episode/")) return;
    const slug = slugOf(href);
    if (!slug) return;
    const title = $(el).find("img").attr("alt") || $(el).text().trim();
    if (!title) return;
    const info = cardInfo($(el).text());
    const prev = bySlug.get(slug);
    if (prev) {
      // link kedua untuk anime yang sama: isi field yang masih kosong
      for (const k of Object.keys(info)) if (prev[k] == null) prev[k] = info[k];
      if (!prev.poster) prev.poster = abs($(el).find("img").attr("src"));
      return;
    }
    bySlug.set(slug, {
      slug,
      title: title.replace(/\s+/g, " ").slice(0, 150),
      poster: abs($(el).find("img").attr("src")),
      ...info,
      url: abs(href),
    });
  });
  return [...bySlug.values()];
}

// Filter opsional: ?type=TV  ?max_ep=13  ?min_score=7 (field kosong tidak dibuang)
function applyFilters(list, q) {
  const type = q.type && String(q.type).toLowerCase();
  const maxEp = q.max_ep && Number(q.max_ep);
  const minScore = q.min_score && Number(q.min_score);
  return list.filter(
    (a) =>
      (!type || !a.type || a.type.toLowerCase() === type) &&
      (!maxEp || a.episode == null || a.episode <= maxEp) &&
      (!minScore || a.score == null || a.score >= minScore)
  );
}

// Ambil episode dari link /anime/{slug}/episode/{n}
function parseEpisodes($) {
  const byHref = new Map();
  $('a[href*="/episode/"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/\/anime\/([^/]+)\/episode\/(\d+)/);
    if (!m) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const prev = byHref.get(href);
    if (!prev || text.length > prev.text.length) {
      byHref.set(href, { anime: m[1], number: Number(m[2]), text, href });
    }
  });
  return [...byHref.values()].map((e) => ({
    anime: e.anime,
    number: e.number,
    title: (e.text.match(/EP\d+\s*-\s*(.+?)\s*(?:Subtitle|Sub)\s*Indo/i) || [])[1] || null,
    date: (e.text.match(/•\s*(.+)$/) || [])[1] || null,
    url: abs(e.href),
  }));
}

const wrap = (fn) => async (req, res) => {
  try {
    res.json({ ok: true, data: await fn(req) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
};

app.get("/", (_, res) =>
  res.json({
    endpoints: [
      "/home",
      "/ongoing",
      "/upcoming",
      "/schedule",
      "/anime?page=1",
      "/search?q=",
      "/genre/:name",
      "/anime/:slug",
      "/anime/:slug/episode/:n",
    ],
  })
);

app.get("/home", wrap(async () => {
  const $ = cheerio.load(await getHtml("/"));
  return { latestEpisodes: parseEpisodes($), anime: parseAnimeLinks($) };
}));

app.get("/ongoing", wrap(async (req) => applyFilters(parseAnimeLinks(cheerio.load(await getHtml("/ongoing"))), req.query)));
app.get("/upcoming", wrap(async () => parseAnimeLinks(cheerio.load(await getHtml("/upcoming")))));
const DAYS = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];

function parseSchedule($) {
  const out = Object.fromEntries(DAYS.map((d) => [d, []]));
  const seen = new Set();
  $('a[href*="/anime/"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    if (href.includes("/episode/")) return;
    const slug = slugOf(href);
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const time = text.match(/\b([01]\d|2[0-3]):[0-5]\d\b/);
    const day = text.match(new RegExp(DAYS.join("|")));
    if (!slug || !time || !day || seen.has(slug + day[0])) return;
    seen.add(slug + day[0]);
    out[day[0]].push({
      slug,
      title: ($(el).find("img").attr("alt") || text.split(time[0])[0]).trim(),
      poster: abs($(el).find("img").attr("src")),
      time: time[0],
      ...cardInfo(text),
      url: abs(href),
    });
  });
  for (const d of DAYS) out[d].sort((a, b) => a.time.localeCompare(b.time));
  return out;
}

// /schedule  atau  /schedule?day=selasa
app.get("/schedule", wrap(async (req) => {
  let sched = parseSchedule(cheerio.load(await getHtml("/jadwal-tayang-anime")));
  if (!DAYS.some((d) => sched[d].length)) sched = parseSchedule(cheerio.load(await getHtml("/")));
  const want = DAYS.find((d) => d.toLowerCase() === String(req.query.day || "").toLowerCase());
  return want ? { [want]: sched[want] } : sched;
}));

app.get("/search", wrap(async (req) => {
  const q = encodeURIComponent(req.query.q || "");
  return applyFilters(parseAnimeLinks(cheerio.load(await getHtml(`/search?q=${q}`))), req.query);
}));

app.get("/genre/:name", wrap(async (req) =>
  parseAnimeLinks(cheerio.load(await getHtml(`/genre/${encodeURIComponent(req.params.name)}`)))
));

const animeList = wrap(async (req) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const q = page > 1 ? `?page=${page}` : "";
  let lastErr;
  for (const base of ["/anime-list", "/anime"]) {
    try {
      const $ = cheerio.load(await getHtml(base + q));
      const results = parseAnimeLinks($);
      if (results.length) return { page, source: base, results };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Daftar anime kosong");
});
app.get("/anime", animeList);
app.get("/anime-list", animeList);

app.get("/anime/:slug", wrap(async (req) => {
  const $ = cheerio.load(await getHtml(`/anime/${encodeURIComponent(req.params.slug)}`));

  // Abaikan menu genre di navigasi (isinya puluhan genre di setiap halaman)
  const genres = new Set();
  $('a[href*="/genre/"]').each((_, el) => {
    let box = $(el).parent();
    while (box.length && box.find('a[href*="/genre/"]').length < 2) box = box.parent();
    if (box.find('a[href*="/genre/"]').length > 15) return;
    const g = $(el).text().trim();
    if (g) genres.add(g);
  });

  const meta = (n) => $(`meta[property="${n}"]`).attr("content") || $(`meta[name="${n}"]`).attr("content") || null;
  const rawTitle = $("h1").first().text().trim() || (meta("og:title") || "").split(" - ")[0] || "";
  const title = rawTitle.replace(/\s*(?:Sub(?:title)?\s*Indo.*|:\s*Episode.*|Episode\s*\d+.*)$/i, "").trim() || null;

  // Sinopsis = paragraf terpanjang yang bukan teks SEO
  const seo = /nonton|streaming|download|subtitle indonesia|batch/i;
  let synopsis = null;
  $("p").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (synopsis || t.length <= 60 || seo.test(t) || $(el).closest("a").length) return;
    synopsis = t;
  });

  return {
    slug: req.params.slug,
    title,
    synopsis: synopsis || meta("og:description") || meta("description"),
    poster: abs(meta("og:image")),
    genres: [...genres],
    episodes: parseEpisodes($),
  };
}));

app.get("/anime/:slug/episode/:n", wrap(async (req) => {
  const $ = cheerio.load(await getHtml(`/anime/${req.params.slug}/episode/${req.params.n}`));
  return {
    title: $("h1").first().text().trim(),
    anime: req.params.slug,
    episode: Number(req.params.n),
    url: `${BASE}/anime/${req.params.slug}/episode/${req.params.n}`,
  };
}));

app.use((req, res) =>
  res.status(404).json({ ok: false, error: `Route tidak ada: ${req.path}`, see: "/" })
);

// Jalan lokal: node api/index.js | Di Vercel: diekspor sebagai handler
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, "0.0.0.0", () => console.log(`API jalan di port ${PORT}`));
}

module.exports = app;
