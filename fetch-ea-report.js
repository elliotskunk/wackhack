"use strict";

/**
 * fetch-ea-report.js
 *
 * For each project in PROJECTS, searches the UK Planning Inspectorate NSIP
 * site, navigates to its Documents page, and extracts the best-matching
 * Examining Authority's Recommendation Report.
 *
 * Writes results to ea-reports.json.
 *
 * Usage:
 *   node fetch-ea-report.js
 *   node fetch-ea-report.js --debug
 */

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Projects to find
// ---------------------------------------------------------------------------

const PROJECTS = [
  "Cleve Hill Solar Park",
  "Galloper Offshore Wind Farm",
  "Gate Burton Energy Park",
  "Heckington Fen Solar Park",
  "Little Crow Solar Park",
  "Mallard Pass Solar Project",
  "Riverside Energy Park",
  "Net Zero Teesside Project",
  "Thurrock Flexible Generation Plant",
  "West Burton Solar Project",
  "White Rose Carbon Capture and Storage Project",
];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL =
  "https://national-infrastructure-consenting.planninginspectorate.gov.uk";
const SEARCH_URL = `${BASE_URL}/project-search`;
const DEBUG_MODE = process.argv.includes("--debug");
const REQUEST_DELAY_MS = 450;
const MINIMUM_SCORE = 3;
const OUTPUT_FILE = path.join(process.cwd(), "ea-reports.json");

// ---------------------------------------------------------------------------
// Scoring rules — Examining Authority Recommendation Report
// ---------------------------------------------------------------------------

const RECOMMENDATION_STAGE_KEYWORDS = [
  "recommendation and decision",
  "recommendation & decision",
  "recommendation",
];

// Helper — true if text signals an Examining Authority document
function isEAText(t) {
  return (
    t.includes("examining authority") ||
    t.includes("examining authorities") ||
    t.includes("examiners") ||
    t.includes("inspector's report") ||
    t.includes("inspectors report")
  );
}

const TITLE_SCORE_RULES = [
  {
    weight: 7,
    test: (t) => isEAText(t) && t.includes("recommendation") && t.includes("report"),
    reason: '"examining authority" + "recommendation" + "report"',
  },
  {
    weight: 6,
    // "Examining Authority's Report to the Secretary of State" — the canonical NSIP title
    test: (t) => isEAText(t) && t.includes("report") && t.includes("secretary of state"),
    reason: '"examining authority" + "report" + "secretary of state"',
  },
  {
    weight: 5,
    test: (t) => isEAText(t) && t.includes("recommendation"),
    reason: '"examining authority" + "recommendation"',
  },
  {
    weight: 5,
    // Bare "Examining Authority's Report" without further qualifiers
    test: (t) => isEAText(t) && t.includes("report") && !t.includes("decision letter"),
    reason: '"examining authority" + "report"',
  },
  {
    weight: 4,
    test: (t) => t.includes("recommendation report"),
    reason: '"recommendation report"',
  },
  {
    weight: 3,
    test: (t) => isEAText(t),
    reason: '"examining authority"',
  },
  {
    weight: 2,
    test: (t) => t.includes("recommendation"),
    reason: '"recommendation"',
  },
];

const TITLE_PENALTY_RULES = [
  {
    // Only penalise explicit SoS *decision* documents, NOT the EA report which is addressed *to* the SoS
    penalty: 6,
    test: (t) =>
      t.includes("secretary of state") &&
      (t.includes("decision letter") || t.includes("statement of reasons")) &&
      !isEAText(t),
    reason: "SoS decision letter/statement (not EA report)",
  },
  {
    penalty: 5,
    test: (t) => t.includes("decision letter") && !isEAText(t),
    reason: "decision letter (not EA report)",
  },
  {
    penalty: 4,
    test: (t) => t.includes("acceptance decision") || t.includes("accepted for examination"),
    reason: "acceptance decision",
  },
  {
    penalty: 4,
    test: (t) =>
      t.includes("procedural decision") || /rule\s*[68]\s*decision/.test(t),
    reason: "procedural decision",
  },
  {
    penalty: 3,
    test: (t) =>
      t.includes("notification of decision") && !isEAText(t),
    reason: "notification of decision",
  },
];

// ---------------------------------------------------------------------------
// Text / URL helpers
// ---------------------------------------------------------------------------

function normaliseText(str) {
  if (!str) return "";
  return str.toLowerCase().replace(/\s+/g, " ").trim();
}

function resolveUrl(href, base) {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function isRecommendationStage(stage) {
  const s = normaliseText(stage);
  return RECOMMENDATION_STAGE_KEYWORDS.some((kw) => s.includes(kw));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreDocument(doc) {
  const combined = `${normaliseText(doc.title)} ${normaliseText(doc.documentType)}`.trim();
  const reasons = [];
  let score = 0;

  for (const rule of TITLE_SCORE_RULES) {
    if (rule.test(combined)) {
      score += rule.weight;
      reasons.push(`+${rule.weight}: ${rule.reason}`);
    }
  }
  for (const rule of TITLE_PENALTY_RULES) {
    if (rule.test(combined)) {
      score -= rule.penalty;
      reasons.push(`-${rule.penalty}: ${rule.reason}`);
    }
  }
  if (isRecommendationStage(doc.stage)) {
    score += 2;
    reasons.push("+2: document is in the Recommendation stage");
  }

  return { score, reasons };
}

function pickBestDoc(docs) {
  const scored = docs
    .map((doc) => {
      const { score, reasons } = scoreDocument(doc);
      return { ...doc, score, matchedReason: reasons.join("; ") };
    })
    .filter((d) => d.score >= MINIMUM_SCORE)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aR = isRecommendationStage(a.stage) ? 0 : 1;
      const bR = isRecommendationStage(b.stage) ? 0 : 1;
      if (aR !== bR) return aR - bR;
      return (a.title || "").localeCompare(b.title || "");
    });

  if (scored.length === 0) return null;
  const best = scored[0];
  return {
    title: best.title,
    url: best.url,
    publishedDate: best.publishedDate || null,
    stage: best.stage || null,
    documentType: best.documentType || null,
    matchedReason: best.matchedReason,
    score: best.score,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const httpClient = axios.create({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    "Cache-Control": "no-cache",
  },
  timeout: 30_000,
});

async function fetchPage(url) {
  const res = await httpClient.get(url);
  if (DEBUG_MODE) {
    const fname = `debug-ea-${url.replace(/[^a-z0-9]/gi, "_").slice(-60)}.html`;
    fs.writeFileSync(fname, res.data, "utf8");
    process.stderr.write(`  [debug] saved HTML → ${fname}\n`);
  }
  return cheerio.load(res.data);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Document extraction — reuse all four strategies from fetch-planning-data.js
// ---------------------------------------------------------------------------

function extractFromSectionResults($, baseUrl) {
  const docs = [];
  $("li.section-results__result").each((_, li) => {
    const $li = $(li);
    const $link = $li.find("a").first();
    if (!$link.length) return;
    const href = $link.attr("href");
    if (!href) return;
    const rawTitle = $link.text().trim();
    if (!rawTitle || rawTitle.length < 5) return;
    const title = rawTitle
      .replace(/\s*&nbsp;\s*/gi, " ")
      .replace(/\s*\(pdf[^)]*\)/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    const url = resolveUrl(href, baseUrl);
    if (!url) return;
    const publishedDate = $li.find('[data-cy="published-date"]').text().trim() || null;
    const stage = $li.find('[data-cy="published-stage"]').text().trim() || null;
    const documentType = $li.find('[data-cy="published-title"]').text().trim() || null;
    docs.push({ title, url, publishedDate, stage, documentType });
  });
  return docs;
}

function extractFromTable($, baseUrl) {
  const docs = [];
  $("table tr, .govuk-table__row").each((_, row) => {
    const $cells = $(row).find("td, .govuk-table__cell");
    if ($cells.length < 2) return;
    const $link = $cells.eq(0).find("a[href]").first();
    if (!$link.length) return;
    const title = $link.text().replace(/\s*\(pdf[^)]*\)/i, "").trim();
    const url = resolveUrl($link.attr("href"), baseUrl);
    if (!title || !url) return;
    const publishedDate = $cells.eq(1).text().trim() || null;
    const stage = $cells.eq(2).text().trim() || null;
    const documentType = $cells.length >= 4 ? $cells.eq(3).text().trim() : null;
    docs.push({ title, url, publishedDate, stage, documentType });
  });
  return docs;
}

function extractFromDefinitionList($, baseUrl) {
  const docs = [];
  $("dl, .govuk-summary-list").each((_, dl) => {
    const $dl = $(dl);
    const $link = $dl.find("a[href]").first();
    if (!$link.length) return;
    const title = $link.text().replace(/\s*\(pdf[^)]*\)/i, "").trim();
    const url = resolveUrl($link.attr("href"), baseUrl);
    if (!title || !url) return;
    let publishedDate = null, stage = null, documentType = null;
    $dl.find("dt, .govuk-summary-list__key").each((_, dt) => {
      const key = normaliseText($(dt).text());
      const val = $(dt).next("dd, .govuk-summary-list__value").text().trim();
      if (key.includes("date")) publishedDate = val;
      if (key.includes("stage") || key.includes("category")) stage = val;
      if (key.includes("type") || key.includes("description")) documentType = val;
    });
    docs.push({ title, url, publishedDate, stage, documentType });
  });
  return docs;
}

function extractFromGenericLinks($, baseUrl) {
  const docs = [];
  const seen = new Set();
  const STAGE_RE =
    /\b(Pre-application|Developer['']s?\s+application|Acceptance|Pre-examination|Examination|Recommendation|Decision|Post-decision|Withdrawn)\b/i;
  const DATE_RE =
    /\b(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})\b/i;

  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    const rawTitle = $el.text().trim();
    if (!href || !rawTitle || rawTitle.length < 6) return;
    if (href.startsWith("#") || href.startsWith("javascript:")) return;
    if (/^(home|documents|back|next|previous|search|apply|filters?|results?\s+per\s+page|show\s+all)$/i.test(rawTitle)) return;
    const url = resolveUrl(href, baseUrl);
    if (!url || seen.has(url)) return;
    const title = rawTitle.replace(/\s*\(pdf[^)]*\)/i, "").trim();
    let stage = null, publishedDate = null;
    let $container = $el;
    for (let depth = 0; depth < 6; depth++) {
      $container = $container.parent();
      if (!$container.length) break;
      const tag = ($container[0].tagName || "").toLowerCase();
      if (tag === "body" || tag === "main" || tag === "html") break;
      const text = $container.text();
      if (text.length > 900) break;
      if (!stage) { const m = text.match(STAGE_RE); if (m) stage = m[1]; }
      if (!publishedDate) { const m = text.match(DATE_RE); if (m) publishedDate = m[1]; }
      if (stage && publishedDate) break;
    }
    seen.add(url);
    docs.push({ title, url, publishedDate: publishedDate || null, stage: stage || null, documentType: null });
  });
  return docs;
}

function extractAllDocuments($, baseUrl) {
  const strategies = [
    { name: "section-results", fn: extractFromSectionResults },
    { name: "table", fn: extractFromTable },
    { name: "definition-list", fn: extractFromDefinitionList },
    { name: "generic-links", fn: extractFromGenericLinks },
  ];
  for (const { name, fn } of strategies) {
    const docs = fn($, baseUrl);
    if (DEBUG_MODE) {
      process.stderr.write(`  [debug] strategy=${name} found ${docs.length} docs\n`);
      if (docs.length > 0) process.stderr.write(`    sample: ${JSON.stringify(docs[0])}\n`);
    }
    if (docs.length > 0) return docs;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Filter URL — Recommendation stage
// ---------------------------------------------------------------------------

function findRecommendationFilterUrl($, docsUrl) {
  let found = null;

  // 1. Direct anchor whose text is "Recommendation" or "Recommendation (N)"
  $("a[href]").each((_, el) => {
    if (found) return;
    const text = normaliseText($(el).text());
    if (/^recommendation(\s*\(\d+\))?$/.test(text)) {
      found = resolveUrl($(el).attr("href"), docsUrl);
    }
  });
  if (found && found !== docsUrl) return found;

  // 2. Form checkbox/radio/option whose value or label contains "recommendation"
  $("form").each((_, form) => {
    if (found) return;
    const $form = $(form);
    const action = $form.attr("action")
      ? resolveUrl($form.attr("action"), docsUrl)
      : docsUrl;

    $form.find("input[type=checkbox], input[type=radio], option").each((_, input) => {
      if (found) return;
      const val = $(input).attr("value") || "";
      const valNorm = normaliseText(val);
      const labelText = normaliseText(
        $(input).closest("label").text() ||
        $(`label[for='${$(input).attr("id")}']`).text() ||
        $(input).parent().text()
      );

      const isEAReport =
        valNorm.includes("examining authority") && valNorm.includes("recommendation");
      const isRecommendation =
        valNorm === "recommendation" || /^recommendation(\s*\(\d+\))?$/.test(labelText);

      if (isEAReport || isRecommendation) {
        const inputName = $(input).attr("name") || "stage";
        const params = new URLSearchParams();
        params.append(inputName, val || "recommendation");
        const sep = action.includes("?") ? "&" : "?";
        const candidate = `${action}${sep}${params.toString()}`;
        if (isEAReport || !found) found = candidate;
      }
    });
  });
  if (found && found !== docsUrl) return found;

  // 3. Hardcoded fallbacks — try all known NSIP document-type strings
  //    The NSIP site uses ?stage-recommendation=<exact document type label>
  const base = docsUrl.split("?")[0];
  // Return the most specific known value; we'll try alternates in the caller
  return `${base}?stage-recommendation=` +
    encodeURIComponent("Examining Authority's Report to the Secretary of State");
}

/** All known filter URL variants for the Recommendation stage. */
function recommendationFilterCandidates(docsUrl) {
  const base = docsUrl.split("?")[0];
  // Try both the long document-type value form AND simple stage= forms
  const longTypes = [
    "Examining Authority's Report to the Secretary of State",
    "Examining Authority's Recommendation Report",
    "Recommendation Report",
    "Examining Authority's Report",
  ].map((t) => `${base}?stage-recommendation=${encodeURIComponent(t)}`);

  const simpleTypes = [
    `${base}?stage=recommendation`,
    `${base}?stage=Recommendation`,
    `${base}?stage-recommendation=recommendation`,
  ];

  return [...longTypes, ...simpleTypes];
}

// ---------------------------------------------------------------------------
// Paginated fetch
// ---------------------------------------------------------------------------

async function fetchAllPages(startUrl) {
  const allDocs = [];
  let pageUrl = startUrl;
  let page = 0;
  const MAX_PAGES = 10;

  while (pageUrl && page < MAX_PAGES) {
    page++;
    if (page > 1) await sleep(REQUEST_DELAY_MS);
    let $p;
    try { $p = await fetchPage(pageUrl); } catch { break; }
    allDocs.push(...extractAllDocuments($p, pageUrl));

    let nextHref = $p("a[rel='next']").attr("href") || null;
    if (!nextHref) {
      $p("a").each((_, el) => {
        if (nextHref) return;
        const t = normaliseText($p(el).text());
        if (t === "next" || t === "next page" || t === "›" || t === "»") {
          nextHref = $p(el).attr("href");
        }
      });
    }
    pageUrl = nextHref ? resolveUrl(nextHref, pageUrl) : null;
  }
  return allDocs;
}

// ---------------------------------------------------------------------------
// Per-project lookup
// ---------------------------------------------------------------------------

async function findEAReportForProject(projectUrl) {
  const docsUrl = projectUrl.replace(/\/$/, "") + "/documents";
  let $;
  try {
    $ = await fetchPage(docsUrl);
  } catch (err) {
    process.stderr.write(`    [docs] fetch error: ${err.message}\n`);
    return null;
  }

  // Step 1: try all filter URL candidates (auto-detected from DOM + hardcoded variants)
  const autoFilter = findRecommendationFilterUrl($, docsUrl);
  const candidates = [autoFilter, ...recommendationFilterCandidates(docsUrl)].filter(
    (u, i, arr) => u && u !== docsUrl && arr.indexOf(u) === i
  );

  let docs = [];

  for (const filterUrl of candidates) {
    if (docs.length > 0) break;
    try {
      await sleep(REQUEST_DELAY_MS);
      const fetched = await fetchAllPages(filterUrl);
      process.stderr.write(`    [filter] ${filterUrl.replace(/.*\/documents/, "/documents")} → ${fetched.length} docs\n`);
      if (fetched.length > 0) docs = fetched;
    } catch (e) {
      process.stderr.write(`    [filter] error: ${e.message}\n`);
    }
  }

  // Step 2: paginate through ALL pages of the unfiltered docs, filter by Recommendation stage
  if (docs.length === 0) {
    process.stderr.write(`    [fallback] paginating all unfiltered docs...\n`);
    const allPaged = await fetchAllPages(docsUrl);
    process.stderr.write(`    [fallback] total docs across all pages: ${allPaged.length}\n`);
    docs = allPaged.filter((d) => isRecommendationStage(d.stage));
    process.stderr.write(`    [fallback] recommendation-stage docs: ${docs.length}\n`);

    // Step 3: if still nothing, score everything from all pages
    if (docs.length === 0) {
      docs = allPaged;
      process.stderr.write(`    [last-resort] scoring all ${docs.length} docs\n`);
    }
  }

  const result = pickBestDoc(docs);

  // Always show top candidates to aid diagnosis
  if (!result && docs.length > 0) {
    const top = docs
      .map((d) => {
        const { score } = scoreDocument(d);
        return { title: d.title, stage: d.stage, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    process.stderr.write(`    [diag] top candidates (none above threshold):\n`);
    for (const c of top) {
      process.stderr.write(`      score=${c.score} stage="${c.stage}" title="${c.title}"\n`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Project search — find project URL by name
// ---------------------------------------------------------------------------

async function findProjectByName(name) {
  const searchUrl = `${SEARCH_URL}?searchTerm=${encodeURIComponent(name)}`;
  let $;
  try {
    $ = await fetchPage(searchUrl);
  } catch (err) {
    process.stderr.write(`  [search] fetch error for "${name}": ${err.message}\n`);
    return null;
  }

  // Look for a project link matching the name (or close to it)
  const nameLower = normaliseText(name);
  let bestHref = null;
  let bestScore = 0;

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !/\/projects\/[A-Za-z]{2}\d{6}\/?$/.test(href)) return;
    const linkText = normaliseText($(el).text());
    // Exact match
    if (linkText === nameLower) { bestHref = href; bestScore = 100; return; }
    // Substring match — count shared words
    const nameWords = nameLower.split(" ");
    const matched = nameWords.filter((w) => linkText.includes(w)).length;
    const ratio = matched / nameWords.length;
    if (ratio > bestScore) { bestScore = ratio; bestHref = href; }
  });

  if (!bestHref) return null;
  return resolveUrl(bestHref.replace(/\/$/, ""), BASE_URL);
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

async function runWithConcurrency(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.error(`Fetching EA Recommendation Reports for ${PROJECTS.length} projects...\n`);

  const results = [];

  // Process projects one at a time to be polite to the server
  for (let i = 0; i < PROJECTS.length; i++) {
    const name = PROJECTS[i];
    process.stderr.write(`  [${i + 1}/${PROJECTS.length}] ${name}\n`);

    // Find project URL
    const projectUrl = await findProjectByName(name);
    if (!projectUrl) {
      process.stderr.write(`    → project not found in search\n`);
      results.push({ projectName: name, projectUrl: null, document: null });
      await sleep(REQUEST_DELAY_MS);
      continue;
    }
    process.stderr.write(`    → ${projectUrl}\n`);
    await sleep(REQUEST_DELAY_MS);

    // Find EA report
    const doc = await findEAReportForProject(projectUrl);
    if (doc) {
      process.stderr.write(`    → found: score=${doc.score} — ${doc.title}\n`);
    } else {
      process.stderr.write(`    → not found\n`);
    }

    results.push({ projectName: name, projectUrl, document: doc });
    await sleep(REQUEST_DELAY_MS);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf8");
  console.error(`\nDone. Written to ${OUTPUT_FILE}`);

  // Print a human-readable summary
  console.log("\n=== Examining Authority Recommendation Reports ===\n");
  for (const r of results) {
    console.log(`Project: ${r.projectName}`);
    console.log(`  Page:  ${r.projectUrl || "not found"}`);
    if (r.document) {
      console.log(`  Title: ${r.document.title}`);
      console.log(`  Date:  ${r.document.publishedDate || "unknown"}`);
      console.log(`  URL:   ${r.document.url}`);
      console.log(`  Stage: ${r.document.stage || "unknown"}`);
    } else {
      console.log(`  Document: NOT FOUND`);
    }
    console.log();
  }
})();
