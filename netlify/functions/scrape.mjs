// netlify/functions/scrape.mjs
// Scrapes curated DeNovix pages nightly at 2am UTC.
// ─────────────────────────────────────────────────

import { getStore } from "@netlify/blobs";

const CACHE_KEY = "gern_knowledge_cache";
const MAX_CHARS = 12000;
const FETCH_TIMEOUT = 12000;

const SOURCES = [
  { label: "DeNovix Homepage",                      url: "https://www.denovix.com" },
  { label: "DS-Series Product Range",               url: "https://www.denovix.com/products/ds-series/" },
  { label: "DS-11 Series Spectrophotometer",        url: "https://www.denovix.com/products/ds-11-fx-spectrophotometer-fluorometer/" },
  { label: "DS-8X Eight Channel Spectrophotometer", url: "https://www.denovix.com/products/ds-8x-eight-channel-spectrophotometer/" },
  { label: "DS-7 Spectrophotometer",                url: "https://www.denovix.com/products/ds-7-spectrophotometer/" },
  { label: "Helium Spectrophotometer",              url: "https://www.denovix.com/products/helium-spectrophotometer/" },
  { label: "DS-C Cuvette Spectrophotometer",        url: "https://www.denovix.com/products/ds-c-cuvette-spectrophotometer/" },
  { label: "QFX Fluorometer",                       url: "https://www.denovix.com/products/qfx-fluorometer/" },
  { label: "CellDrop Automated Cell Counter",       url: "https://www.denovix.com/products/celldrop/" },
  { label: "Fluorescence Quantification Assays",    url: "https://www.denovix.com/products/assays/" },
  { label: "CellDrop Viability Assays",             url: "https://www.denovix.com/products/celldrop-assays/" },
  { label: "DS-11 Series Technical Notes",          url: "https://www.denovix.com/products/technical-notes/" },
  { label: "CellDrop Technical Notes",              url: "https://www.denovix.com/products/celldrop/celldrop-technical-notes/" },
  { label: "QFX Technical Notes",                   url: "https://www.denovix.com/products/qfx-technical-notes/" },
  { label: "eBooks and Infographics",               url: "https://www.denovix.com/ebooks/" },
  { label: "Publication Resources",                 url: "https://www.denovix.com/publication-resources/" },
  { label: "Quick Start Video Guides",              url: "https://www.denovix.com/products/quick-start-video-guides/" },
  { label: "CellDrop Videos",                       url: "https://www.denovix.com/products/celldrop-videos/" },
  { label: "DS-Series Videos",                      url: "https://www.denovix.com/products/videos/" },
  { label: "QFX Videos",                            url: "https://www.denovix.com/products/qfx-videos/" },
  { label: "Webinars",                              url: "https://www.denovix.com/webinars/" },
  { label: "About DeNovix",                         url: "https://www.denovix.com/about-us/" },
  { label: "Special Offers",                        url: "https://www.denovix.com/special-offers/" },
];

function extractVideoUrls(html) {
  const videos = [];
  const patterns = [
    /src=["'][^"']*youtube\.com\/embed\/([a-zA-Z0-9_-]{11})[^"']*/gi,
    /href=["']https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})[^"']*/gi,
    /href=["']https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})[^"']*/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) videos.push(`https://www.youtube.com/watch?v=${m[1]}`);
  }
  const vimRe = /src=["'][^"']*vimeo\.com\/(?:video\/)?([0-9]+)[^"']*/gi;
  let m;
  while ((m = vimRe.exec(html)) !== null) videos.push(`https://vimeo.com/${m[1]}`);
  return [...new Set(videos)];
}

function extractTitle(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].replace(/\s*[|\-]\s*DeNovix.*$/i, "").trim() : null;
}

function stripHtml(html) {
  const videoUrls = extractVideoUrls(html);
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#8[01]7;/g, "'")
    .replace(/\s{3,}/g, "\n\n").trim();
  if (videoUrls.length > 0)
    text += "\n\nVIDEOS ON THIS PAGE:\n" + videoUrls.map(u => `- ${u}`).join("\n");
  return text;
}

async function scrapeSource({ label, url }) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "AskGern-Bot/1.0 (DeNovix Knowledge Assistant)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const pageTitle = extractTitle(html) || label;
    const text = stripHtml(html).slice(0, MAX_CHARS);
    if (!text || text.length < 80) throw new Error("Insufficient content");
    return { label: pageTitle, url, status: "ready", content: text, scrapedAt: new Date().toISOString() };
  } catch (err) {
    console.error(`[scrape] Failed: ${label} — ${err.message}`);
    return { label, url, status: "error", error: err.message };
  }
}

export default async function handler() {
  console.log(`[scrape] Starting — ${SOURCES.length} sources`);
  const results = [];
  const BATCH = 4;
  for (let i = 0; i < SOURCES.length; i += BATCH) {
    const batch = SOURCES.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(scrapeSource));
    results.push(...settled.map(r => r.status === "fulfilled" ? r.value : { status: "error", error: r.reason?.message }));
    if (i + BATCH < SOURCES.length) await new Promise(r => setTimeout(r, 250));
  }

  const ready = results.filter(s => s.status === "ready").length;
  console.log(`[scrape] Done: ${ready}/${SOURCES.length} ready`);

  const store = getStore("gern");
  await store.setJSON(CACHE_KEY, {
    sources: results.filter(s => s.status === "ready"),
    updatedAt: new Date().toISOString(),
    stats: { ready, total: SOURCES.length },
  });

  return new Response(
    JSON.stringify({ ok: true, ready, total: SOURCES.length, sources: results.map(s => ({ label: s.label, status: s.status, error: s.error })) }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
