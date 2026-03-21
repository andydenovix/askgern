// netlify/functions/scrape.mjs
// Crawls denovix.com via sitemap — fetches posts, pages and portfolio content.
// Runs nightly at 2am UTC.
// ─────────────────────────────────────────────────────────────────────────────

import { getStore } from "@netlify/blobs";

const CACHE_KEY = "gern_knowledge_cache";

// ── Sitemap config ─────────────────────────────────────────────────────────────
// We fetch these three sub-sitemaps — they cover all meaningful public content.
const SUB_SITEMAPS = [
  "https://www.denovix.com/page-sitemap.xml",      // product pages, support, about
  "https://www.denovix.com/post-sitemap.xml",       // blog posts and news
  "https://www.denovix.com/tm_portfolio-sitemap.xml", // technical notes / case studies
];

// URLs containing these strings are skipped — not useful for Q&A
const SKIP_PATTERNS = [
  "/author/", "/tag/", "/category/", "/feed/", "/wp-",
  "/cart/", "/checkout/", "/my-account/", "/privacy",
  "/cookie", "/terms", "/login", "/register",
  "?", "#",
];

// Prioritise these paths — scraped first and given higher char limits
const PRIORITY_PATTERNS = [
  "/products/", "/technical-notes/", "/faq/",
  "/celldrop/", "/ds-11/", "/ds-series/", "/qfx/",
];

const MAX_PAGES       = 50;   // hard cap on total pages scraped per run
const MAX_CHARS_PRI   = 8000; // chars per priority page
const MAX_CHARS_STD   = 3000;  // chars per standard page
const FETCH_TIMEOUT   = 10000; // ms per page fetch
const CONCURRENCY     = 3;     // parallel fetches

// ── HTML → text ───────────────────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8[01]7;/g, "'")
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

// Extract page title from HTML
function extractTitle(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (!m) return null;
  return m[1].replace(/\s*[|\-–]\s*DeNovix.*$/i, "").trim();
}

// ── Sitemap fetching ──────────────────────────────────────────────────────────
async function fetchSitemapUrls(sitemapUrl) {
  try {
    const res = await fetch(sitemapUrl, {
      headers: { "User-Agent": "AskGern-Bot/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const urls = [...xml.matchAll(/<loc>(https:\/\/www\.denovix\.com[^<]*)<\/loc>/gi)]
      .map(m => m[1].trim());
    return urls;
  } catch (err) {
    console.warn(`[scrape] Sitemap fetch failed: ${sitemapUrl} — ${err.message}`);
    return [];
  }
}

function shouldSkip(url) {
  return SKIP_PATTERNS.some(p => url.includes(p));
}

function isPriority(url) {
  return PRIORITY_PATTERNS.some(p => url.includes(p));
}

// ── Page scraping ─────────────────────────────────────────────────────────────
async function scrapePage(url) {
  const priority = isPriority(url);
  const maxChars = priority ? MAX_CHARS_PRI : MAX_CHARS_STD;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "AskGern-Bot/1.0 (DeNovix Knowledge Assistant)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const title = extractTitle(html) || url;
    const text = stripHtml(html);

    if (!text || text.length < 80) throw new Error("Insufficient content");

    return {
      label: title,
      url,
      type: "url",
      priority,
      status: "ready",
      content: text.slice(0, maxChars),
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { label: url, url, status: "error", error: err.message };
  }
}

// Run promises in batches to limit concurrency
async function batchFetch(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults.map(r =>
      r.status === "fulfilled" ? r.value : { status: "error", error: r.reason?.message }
    ));
    // Small pause between batches to be polite to the server
    if (i + batchSize < items.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return results;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler() {
  console.log("[scrape] Starting DeNovix sitemap crawl…");
  const START = Date.now();
  const HARD_LIMIT_MS = 24000; // stop before Netlify's 26s timeout

  // 1. Collect all URLs from the three sub-sitemaps
  const allUrlSets = await Promise.all(SUB_SITEMAPS.map(fetchSitemapUrls));
  let allUrls = allUrlSets.flat();

  // 2. Deduplicate and filter
  allUrls = [...new Set(allUrls)].filter(u => !shouldSkip(u));
  console.log(`[scrape] ${allUrls.length} URLs after filtering`);

  // 3. Sort — priority pages first
  allUrls.sort((a, b) => {
    const ap = isPriority(a) ? 0 : 1;
    const bp = isPriority(b) ? 0 : 1;
    return ap - bp;
  });

  // 4. Cap total pages
  if (allUrls.length > MAX_PAGES) {
    console.log(`[scrape] Capping at ${MAX_PAGES} pages`);
    allUrls = allUrls.slice(0, MAX_PAGES);
  }

  // 5. Scrape all pages in batches — stop if approaching timeout
  console.log(`[scrape] Scraping ${allUrls.length} pages…`);
  const scraped = [];
  for (let i = 0; i < allUrls.length; i += CONCURRENCY) {
    if (Date.now() - START > HARD_LIMIT_MS) {
      console.log(`[scrape] Timeout guard triggered at page ${i}`);
      break;
    }
    const batch = allUrls.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map(scrapePage));
    scraped.push(...batchResults.map(r =>
      r.status === "fulfilled" ? r.value : { status: "error", error: r.reason?.message }
    ));
    if (i + CONCURRENCY < allUrls.length) await new Promise(r => setTimeout(r, 300));
  }

  // 6. Report
  const ready   = scraped.filter(s => s.status === "ready").length;
  const errors  = scraped.filter(s => s.status === "error").length;
  const priority = scraped.filter(s => s.status === "ready" && s.priority).length;
  console.log(`[scrape] Done: ${ready} ready (${priority} priority), ${errors} errors`);

  // 7. Save to Blobs
  const store = getStore("gern");
  await store.setJSON(CACHE_KEY, {
    sources: scraped.filter(s => s.status === "ready"),
    updatedAt: new Date().toISOString(),
    stats: { ready, errors, total: allUrls.length },
  });

  return new Response(
    JSON.stringify({
      ok: true,
      ready,
      errors,
      total: allUrls.length,
      priority,
      sources: scraped
        .filter(s => s.status === "ready")
        .slice(0, 20)
        .map(s => ({ label: s.label, url: s.url, priority: s.priority })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
