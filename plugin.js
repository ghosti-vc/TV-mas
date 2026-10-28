// TV mas: canales de TV en vivo (CXTv) para Kino.
// El plugin lee las categorías y los canales de la página y, al dar play,
// saca el enlace de video del atributo data-stream-url de cada canal.

const BASE = "https://www.cxtvenvivo.com";
const MIME_HLS = "application/vnd.apple.mpegurl";
const ID_OK = /^[A-Za-z0-9._~-]{1,128}$/;

// Canal que ya sabemos que funciona: siempre aparece, aunque falle la página.
const DESTACADOS = [
  {
    id: "telemundo-51-miami",
    title: "Telemundo 51 Miami",
    number: 51,
    logo: "https://www.cxtv.com.br/img/Tvs/Logo/webp-l/70ef4b19ce0f5b973ff48dffd540d3d8.webp",
    url: "https://d368vp0qqzvkid.cloudfront.net/manifest/3fec3e5cac39a52b2132f9c66c83dae043dc17d4/prod_default_nbc-direct/32d83610-b3ed-4e0c-bc1a-9cf4055cc405/3.m3u8",
  },
];

// ---------- utilidades ----------

function decode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&raquo;/g, "»")
    .replace(/&laquo;/g, "«")
    .replace(/&rsaquo;/g, "›")
    .replace(/&lsaquo;/g, "‹")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripTags(s) {
  return decode(String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

function attr(tag, name) {
  const m = new RegExp("(?:^|[\\s\"'])" + name + "=[\"']([^\"']*)[\"']", "i").exec(tag || "");
  return m ? decode(m[1]) : "";
}

function absolute(href, from) {
  try {
    return new URL(href, from || BASE + "/").toString();
  } catch (e) {
    return "";
  }
}

function isOurHost(url) {
  return /^https:\/\/(www\.)?cxtvenvivo\.com(\/|$)/i.test(url);
}

async function getHtml(url) {
  const r = await kino.fetch(url);
  if (r.status === 404) throw kino.error("not_found", "página " + r.status);
  if (r.status === 429) throw kino.error("rate_limited", "página " + r.status);
  if (!r.ok) throw kino.error("unavailable", "la página respondió " + r.status);
  let t = typeof r.text === "function" ? r.text() : r.text;
  t = await t;
  return typeof t === "string" ? t : String(t || "");
}

// Texto del primer encabezado (h1 a h6) dentro de un pedazo de HTML.
function headingText(html) {
  const m = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(html || "");
  return m ? stripTags(m[1]) : "";
}

function parseCategories(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*?)href=["']([^"']*\/tv\/categorias\/([a-z0-9][a-z0-9._~-]*))\/?["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const slug = m[3];
    if (seen.has(slug) || !ID_OK.test("c-" + slug)) continue;
    const tag = m[1] + " " + m[4];
    let title = attr(tag, "title") || headingText(m[5]) || stripTags(m[5]);
    if (!title) {
      const img = /<img\b[^>]*>/i.exec(m[5]);
      title = img ? attr(img[0], "alt") : "";
    }
    if (!title) title = slug.replace(/-/g, " ");
    seen.add(slug);
    out.push({ id: "c-" + slug, title: title.slice(0, 60) });
  }
  return out;
}

// En la página de una categoría cada canal es: <a href=".../tv-en-vivo/slug">
//   <img src="logo"> <h4>Nombre</h4> <div><img class="flag"> País - Ciudad</div> ... </a>
function parseChannels(html, pageUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*?)href=["']([^"']*\/tv-en-vivo\/([a-z0-9][a-z0-9._~-]*))\/?["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const slug = m[3];
    if (seen.has(slug) || !ID_OK.test(slug)) continue;
    const tag = m[1] + " " + m[4];
    const inner = m[5];
    // El logo es la primera imagen que no es la banderita del país.
    let logoTag = "";
    const imgRe = /<img\b[^>]*>/gi;
    let im;
    while ((im = imgRe.exec(inner))) {
      if (!/class=["'][^"']*\bflag\b/i.test(im[0])) {
        logoTag = im[0];
        break;
      }
    }
    let title = headingText(inner) || attr(tag, "title") || attr(logoTag, "alt") || attr(logoTag, "title");
    if (!title) title = slug.replace(/-/g, " ");
    let logo = attr(logoTag, "data-src") || attr(logoTag, "src");
    logo = logo ? absolute(logo, pageUrl) : "";
    seen.add(slug);
    const item = { id: slug, title: title.slice(0, 120), ref: slug };
    if (/^https?:\/\//i.test(logo)) item.logo = logo;
    out.push(item);
  }
  return out;
}

// Número de página que indica una dirección (?pagina=2, ?page=2, ?p=2, /pagina/2). Sin número = 1.
function pageNum(url) {
  let m = /[?&](?:pagina|page|pag|p)=(\d+)/i.exec(url);
  if (!m) m = /\/(?:pagina|page|pag|p)\/(\d+)\/?(?:[?#]|$)/i.exec(url);
  return m ? Number(m[1]) : 1;
}

function pathOf(url) {
  return url.replace(/[?#].*$/, "").replace(/\/(?:pagina|page|pag|p)\/\d+\/?$/i, "").replace(/\/+$/, "");
}

function findNext(html, pageUrl) {
  const cur = pageNum(pageUrl);
  const base = pathOf(pageUrl);
  const tried = [];

  // 1) Marcado rel="next".
  let m = /<link\b[^>]*rel=["']next["'][^>]*>/i.exec(html);
  if (m) tried.push(attr(m[0], "href"));
  m = /<a\b[^>]*rel=["']next["'][^>]*>/i.exec(html);
  if (m) tried.push(attr(m[0], "href"));

  // 2) Enlaces de la misma categoría cuyo número de página es el siguiente.
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let a;
  while ((a = re.exec(html))) {
    const href = attr(a[1], "href");
    if (!href || href === "#") continue;
    const abs = absolute(href, pageUrl);
    if (!abs || !isOurHost(abs)) continue;
    if (pathOf(abs) === base && pageNum(abs) === cur + 1) tried.push(href);
    const text = stripTags(a[2]);
    if (/^(siguiente|next|»|›|>|>>)$/i.test(text) || /siguiente|next/i.test(attr(a[1], "aria-label"))) {
      tried.push(href);
    }
  }

  for (const href of tried) {
    if (!href || href === "#") continue;
    const next = absolute(href, pageUrl);
    if (next && next !== pageUrl && isOurHost(next) && next.length <= 2000 && pageNum(next) !== cur) return next;
  }
  return undefined;
}

// ---------- funciones que llama Kino ----------

// Kino pide home o search; este plugin solo tiene canales.
export async function home() {
  await null;
  return [];
}

export async function liveCategories() {
  await null;
  const cats = [{ id: "destacados", title: "Destacados", country: "US" }];
  try {
    const html = await getHtml(BASE + "/tv/categorias");
    for (const c of parseCategories(html)) {
      if (cats.length >= 200) break;
      cats.push(c);
    }
  } catch (e) {
    kino.log("categorias: " + (e && e.code ? e.code : "error"));
  }
  return cats;
}

export async function liveChannels({ categoryId, cursor }) {
  await null;
  if (categoryId === "destacados") {
    return {
      items: DESTACADOS.map((c) => ({
        id: c.id,
        title: c.title,
        categoryId,
        number: c.number,
        logo: c.logo,
        ref: c.id,
        stream: { url: c.url, mime: MIME_HLS },
      })),
    };
  }
  if (typeof categoryId !== "string" || categoryId.indexOf("c-") !== 0) return { items: [] };
  const slug = categoryId.slice(2);
  const url = cursor && isOurHost(cursor) ? cursor : BASE + "/tv/categorias/" + encodeURIComponent(slug);

  const r = await kino.fetch(url);
  let html = typeof r.text === "function" ? r.text() : r.text;
  html = await html;
  html = typeof html === "string" ? html : String(html || "");
  const items = r.ok ? parseChannels(html, url).map((c) => ({ ...c, categoryId })) : [];

  if (!items.length) {
    // Aviso temporal para saber qué pasó (se quita cuando todo funcione).
    const inicio = html.replace(/\s+/g, " ").slice(0, 70);
    kino.log("sin canales en " + url + " estado=" + r.status + " largo=" + html.length);
    return {
      items: [
        { id: "aviso-estado", title: "Aviso: sin canales (estado " + r.status + ", " + html.length + " caracteres)", categoryId, ref: "aviso-estado" },
        { id: "aviso-inicio", title: "Inicio: " + (inicio || "(vacío)"), categoryId, ref: "aviso-inicio" },
      ],
    };
  }

  const next = findNext(html, url);
  return next ? { items, next } : { items };
}

// Se llama al dar play y otra vez si la señal se corta.
export async function resolve(ref) {
  await null;
  const known = DESTACADOS.find((c) => c.id === ref);
  if (typeof ref !== "string" || !ID_OK.test(ref)) throw kino.error("not_found", "canal inválido");
  let html;
  try {
    html = await getHtml(BASE + "/tv-en-vivo/" + encodeURIComponent(ref));
  } catch (e) {
    if (known) return { url: known.url, mime: MIME_HLS };
    throw e;
  }
  let url = (/data-stream-url=["']([^"']+)["']/i.exec(html) || [])[1];
  if (!url) {
    const m = /https?:\\?\/\\?\/[^"'\s<>\\]+?\.m3u8[^"'\s<>]*/i.exec(html);
    if (m) url = m[0].replace(/\\\//g, "/");
  }
  url = decode(url || "");
  if (!/^https?:\/\//i.test(url)) {
    if (known) return { url: known.url, mime: MIME_HLS };
    throw kino.error("unavailable", "este canal no trae señal directa");
  }
  return /\.m3u8/i.test(url) ? { url, mime: MIME_HLS } : { url };
}
