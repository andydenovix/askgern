// netlify/functions/scrape.mjs
// Scrapes DeNovix knowledge sources nightly at 2am UTC.
// ─────────────────────────────────────────────────────
// EDIT YOUR SOURCES HERE — add/remove entries as needed
// Types: "url" | "gdoc" | "pdf"
// ─────────────────────────────────────────────────────

const SOURCES = [
  {
    label: "DeNovix Homepage",
    url: "https://www.denovix.com",
    type: "url"
  },
  {
    label: "DS-11 Series Spectrophotometer / Fluorometer",
    url: "https://www.denovix.com/products/ds-11-fx-spectrophotometer-fluorometer/",
    type: "url"
  },
  {
    label: "CellDrop Automated Cell Counter",
    url: "https://www.denovix.com/products/celldrop/",
    type: "url"
  },
  {
    label: "QFX Fluorometer",
    url: "https://www.denovix.com/products/qfx-fluorometer/",
    type: "url"
  },
  {
    label: "DS-Series Product Range",
    url: "https://www.denovix.com/products/ds-series/",
    type: "url"
  },
  {
    label: "Fluorescence Quantification Assays",
    url: "https://www.denovix.com/products/assays/",
    type: "url"
  },
  {
    label: "DeNovix About Us",
    url: "https://www.denovix.com/about-us/",
    type: "url"
  },
];

// ─────────────────────────────────────────────────────

import { getStore } from "@netlify/blobs";

const CACHE_KEY = "gern_knowledge_cache";
const MAX_CHARS = 15000;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

async function scrapeSource(source) {
  const { label, url, type } = source;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "AskGern-Bot/1.0 (DeNovix Knowledge Assistant)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    let text = "";
    if (type === "gdoc") {
      text = await res.text();
    } else if (type === "pdf") {
      text = `[PDF source: ${label}]\nURL: ${url}\nNote: PDF document — direct users to download for full content.`;
    } else {
      const html = await res.text();
      text = stripHtml(html);
    }

    text = text.trim();
    if (!text || text.length < 30) throw new Error("Could not extract meaningful text");

    return {
      label, url, type,
      status: "ready",
      content: text.slice(0, MAX_CHARS),
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`[scrape] Failed: ${label} — ${err.message}`);
    return {
      label, url, type,
      status: "error",
      error: err.message,
      scrapedAt: new Date().toISOString(),
    };
  }
}

export default async function handler() {
  console.log(`[scrape] Starting scrape of ${SOURCES.length} sources…`);

  const results = await Promise.allSettled(SOURCES.map(scrapeSource));
  const scraped = results.map(r =>
    r.status === "fulfilled" ? r.value : { status: "error", error: r.reason?.message }
  );

  const ready = scraped.filter(s => s.status === "ready").length;
  console.log(`[scrape] Done. ${ready}/${SOURCES.length} ready.`);

  const store = getStore("gern");
  await store.setJSON(CACHE_KEY, {
    sources: scraped,
    updatedAt: new Date().toISOString(),
  });

  return new Response(
    JSON.stringify({
      ok: true,
      ready,
      total: SOURCES.length,
      sources: scraped.map(s => ({ label: s.label, status: s.status, error: s.error })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// Scheduled function — no custom path allowed
