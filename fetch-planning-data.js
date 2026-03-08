"use strict";

/**
 * fetch-planning-data.js
 *
 * Crawls the UK Planning Inspectorate NSIP site and extracts the single
 * best-matching Secretary of State decision document for each project.
 *
 * Three accepted input URL forms:
 *
 *   1. Project search/filter page
 *      e.g. https://national-infrastructure-consenting.planninginspectorate.gov.uk/project-search?sector=energy&stage=post_decision
 *      → Discovers every project on the results page (follows pagination),
 *        then visits each project's documents page.
 *      → Writes results to sos-decisions.json in the current directory.
 *
 *   2. Single project page
 *      e.g. https://.../projects/EN010085
 *      → Visits only that project's documents page.
 *      → Prints the result to stdout.
 *
 *   3. Single project documents page
 *      e.g. https://.../projects/EN010085/documents
 *      → Scrapes the documents page directly.
 *      → Prints the result to stdout.
 *
 * Usage:
 *   node fetch-planning-data.js <url>
 */

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL =
  "https://national-infrastructure-consenting.planninginspectorate.gov.uk";

const INPUT_URL = process.argv[2] || "";

/** Minimum score before a document is considered a candidate. */
const MINIMUM_SCORE = 3;

/** Max concurrent project fetches (be respectful to the server). */
const CONCURRENCY = 3;

/** Milliseconds to wait between HTTP requests. */
const REQUEST_DELAY_MS = 400;

/** Output file path for multi-project mode. */
const OUTPUT_FILE = path.join(process.cwd(), "sos-decisions.json");

// ---------------------------------------------------------------------------
// Scoring rules
// ---------------------------------------------------------------------------

/**
 * Stage/category keywords indicating the final decision stage.
 * Matched against the normalised stage label from the page.
 *
 * NOTE: "decision" is intentionally broad so it also matches the exact
 * stage label "Decision" used in the NSIP document table.
 */
const DECISION_STAGE_KEYWORDS = [
  "recommendation and decision",
  "recommendation & decision",
  // "decision" alone must come last – it's a substring of the above two,
  // so order doesn't matter for includes(), but keep it explicit.
  "decision",
];

/**
 * Positive title-scoring rules.
 * Rules are cumulative; a document can match several.
 */
const TITLE_SCORE_RULES = [
  {
    weight: 5,
    test: (t) => t.includes("secretary of state") && t.includes("decision"),
    reason: 'title contains "secretary of state" + "decision"',
  },
  {
    weight: 4,
    test: (t) => t.includes("decision letter"),
    reason: 'title contains "decision letter"',
  },
  {
    weight: 4,
    test: (t) => t.includes("letter from the secretary of state"),
    reason: 'title contains "letter from the secretary of state"',
  },
  {
    weight: 3,
    test: (t) => t.includes("decision") && t.includes("statement of reasons"),
    reason: 'title contains "decision" + "statement of reasons"',
  },
  {
    weight: 2,
    test: (t) => t.includes("secretary of state"),
    reason: 'title contains "secretary of state"',
  },
];

/** Penalty rules — reduce score for non-SoS-decision documents. */
const TITLE_PENALTY_RULES = [
  {
    penalty: 4,
    test: (t) =>
      /\brecommendation\b/.test(t) &&
      !t.includes("decision") &&
      !t.includes("secretary of state"),
    reason: "recommendation-only document",
  },
  {
    penalty: 3,
    test: (t) =>
      t.includes("inspector") &&
      !t.includes("secretary of state") &&
      !t.includes("decision"),
    reason: "inspector's report (not SoS decision)",
  },
  {
    penalty: 5,
    test: (t) =>
      t.includes("procedural decision") || /rule\s*[68]\s*decision/.test(t),
    reason: "procedural decision",
  },
  {
    penalty: 4,
    test: (t) =>
      t.includes("acceptance decision") ||
      t.includes("accepted for examination"),
    reason: "acceptance decision",
  },
  {
    penalty: 3,
    test: (t) =>
      t.includes("notification of decision") &&
      !t.includes("secretary of state"),
    reason: "notification of decision (not the SoS decision letter itself)",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lowercase + whitespace-normalise a string.
 * Safe to call on null/undefined.
 *
 * @param {string|null|undefined} str
 * @returns {string}
 */
function normaliseText(str) {
  if (!str) return "";
  return str.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Resolve a potentially relative href to an absolute URL.
 *
 * @param {string} href
 * @param {string} base
 * @returns {string|null}
 */
function resolveUrl(href, base) {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/**
 * Return true if the stage label indicates the final decision stage.
 *
 * @param {string|null} stage
 * @returns {boolean}
 */
function isDecisionStage(stage) {
  const s = normaliseText(stage);
  // Exclude "post-decision" — that is the stage *after* the decision
  if (s.includes("post-decision") || s.includes("post decision")) return false;
  return DECISION_STAGE_KEYWORDS.some((kw) => s.includes(kw));
}

/**
 * Score a document against the SoS decision heuristics.
 *
 * @param {{ title: string, stage: string|null, documentType: string|null }} doc
 * @returns {{ score: number, reasons: string[] }}
 */
function scoreDecisionDocument(doc) {
  const title = normaliseText(doc.title);
  // Also score against documentType if available (NSIP table has a 4th column)
  const docType = normaliseText(doc.documentType);
  const combined = `${title} ${docType}`.trim();

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

  if (isDecisionStage(doc.stage)) {
    score += 2;
    reasons.push("+2: document is in the Decision stage");
  }

  return { score, reasons };
}

/**
 * Pick the best-scoring SoS decision from a list of candidates.
 * Returns null if nothing meets MINIMUM_SCORE.
 *
 * @param {Array<object>} docs
 * @returns {object|null}
 */
function pickBestDecision(docs) {
  const scored = docs
    .map((doc) => {
      const { score, reasons } = scoreDecisionDocument(doc);
      return { ...doc, score, matchedReason: reasons.join("; ") };
    })
    .filter((d) => d.score >= MINIMUM_SCORE)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-break 1: prefer docs in a decision-related stage
      const aD = isDecisionStage(a.stage) ? 0 : 1;
      const bD = isDecisionStage(b.stage) ? 0 : 1;
      if (aD !== bD) return aD - bD;
      // Tie-break 2: alphabetical (deterministic)
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
      "Mozilla/5.0 (compatible; NSIP-SoS-Decision-Scraper/1.0; +research)",
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "en-GB,en;q=0.9",
  },
  timeout: 30_000,
});

/**
 * Fetch a URL and return a Cheerio instance.
 * Throws on HTTP errors.
 *
 * @param {string} url
 * @returns {Promise<cheerio.CheerioAPI>}
 */
async function fetchPage(url) {
  const res = await httpClient.get(url);
  return cheerio.load(res.data);
}

/** Simple promise-based sleep. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Level 1 — Project search/list page
// ---------------------------------------------------------------------------

/**
 * Scrape all project links from a project search/filter page, following
 * pagination until exhausted.
 *
 * The NSIP project list renders rows like:
 *   <tr>
 *     <td><a href="/projects/EN010085">Cleve Hill Solar Park</a></td>
 *     <td>Cleve Hill Solar Park Ltd</td>
 *     <td>Decided</td>
 *   </tr>
 *
 * @param {string} searchUrl
 * @returns {Promise<Array<{ name: string, projectUrl: string }>>}
 */
async function scrapeProjectList(searchUrl) {
  const projects = [];
  const seen = new Set();
  let pageUrl = searchUrl;
  let pageNum = 1;

  while (pageUrl) {
    process.stderr.write(`  [list] page ${pageNum}: ${pageUrl}\n`);
    let $;
    try {
      $ = await fetchPage(pageUrl);
    } catch (err) {
      process.stderr.write(`  [list] fetch error: ${err.message}\n`);
      break;
    }

    // Project links: href matches /projects/XXXXXXXX (letters+digits, no sub-path)
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      // Match /projects/EN010085 style — no trailing path segment
      if (!/\/projects\/[A-Z]{2}\d{6}(?:\/)?$/.test(href)) return;
      const absolute = resolveUrl(href.replace(/\/$/, ""), BASE_URL);
      if (seen.has(absolute)) return;
      seen.add(absolute);
      projects.push({
        name: $(el).text().trim(),
        projectUrl: absolute,
      });
    });

    // Pagination: look for a "Next" link
    const $next = $("a[rel='next']").first();
    if ($next.length) {
      pageUrl = resolveUrl($next.attr("href"), pageUrl);
      pageNum++;
      await sleep(REQUEST_DELAY_MS);
    } else {
      // Also try common text-based pagination links
      let nextHref = null;
      $("a").each((_, el) => {
        const t = normaliseText($(el).text());
        if (t === "next" || t === "next page" || t === "›" || t === "»") {
          nextHref = $(el).attr("href");
        }
      });
      if (nextHref) {
        pageUrl = resolveUrl(nextHref, pageUrl);
        pageNum++;
        await sleep(REQUEST_DELAY_MS);
      } else {
        pageUrl = null;
      }
    }
  }

  return projects;
}

// ---------------------------------------------------------------------------
// Level 2 — Project documents page
// ---------------------------------------------------------------------------

/**
 * Given a project page URL (e.g. /projects/EN010085), construct the
 * documents page URL by appending /documents.
 *
 * @param {string} projectUrl
 * @returns {string}
 */
function buildDocumentsUrl(projectUrl) {
  return projectUrl.replace(/\/$/, "") + "/documents";
}

/**
 * On the NSIP documents page there is a left-hand filter sidebar.
 * Stage filters appear as links whose text is e.g. "Decision (16)".
 * This function returns the href of the Decision stage filter link,
 * or null if not found.
 *
 * @param {cheerio.CheerioAPI} $
 * @param {string} baseUrl
 * @returns {string|null}
 */
function findDecisionFilterUrl($, baseUrl) {
  let filterHref = null;

  $("a[href]").each((_, el) => {
    if (filterHref) return; // already found
    const text = normaliseText($(el).text());
    // Matches "decision (16)" or just "decision" but NOT "post-decision"
    if (
      /^decision(\s*\(\d+\))?$/.test(text) ||
      /^recommendation\s*(and|&)\s*decision(\s*\(\d+\))?$/.test(text)
    ) {
      filterHref = resolveUrl($(el).attr("href"), baseUrl);
    }
  });

  return filterHref;
}

/**
 * Extract document rows from the NSIP documents table.
 *
 * The table on /projects/XXXXX/documents has these columns:
 *   1. Title (link + optional "From [Author]" sub-line)
 *   2. Date published
 *   3. Stage
 *   4. Document type
 *
 * This function also strips "(PDF, NNNkb)" size suffixes from titles.
 *
 * @param {cheerio.CheerioAPI} $
 * @param {string} baseUrl
 * @returns {Array<{ title, url, publishedDate, stage, documentType }>}
 */
function extractDocumentRows($, baseUrl) {
  const docs = [];

  // The main content table — skip header rows
  $("table tr").each((_, row) => {
    const $cells = $(row).find("td");
    if ($cells.length < 2) return; // header or empty row

    const $titleCell = $cells.eq(0);
    const $link = $titleCell.find("a[href]").first();
    if (!$link.length) return;

    const rawTitle = $link.text().trim();
    // Strip PDF size annotation, e.g. " (PDF, 480KB)"
    const title = rawTitle.replace(/\s*\(pdf[^)]*\)/i, "").trim();
    const url = resolveUrl($link.attr("href"), baseUrl);

    const publishedDate = $cells.eq(1).text().trim() || null;
    const stage = $cells.eq(2).text().trim() || null;
    const documentType = $cells.eq(3).text().trim() || null;

    if (!title || !url) return;

    docs.push({ title, url, publishedDate, stage, documentType });
  });

  return docs;
}

/**
 * Fetch a project documents page and return the best-matching SoS decision.
 *
 * Strategy:
 *   1. Load the documents page.
 *   2. Look for a "Decision" filter link in the sidebar → follow it so we
 *      only see Decision-stage documents (avoids paginating through hundreds
 *      of unrelated docs).
 *   3. Extract document rows from the (filtered) table.
 *   4. If the filtered page is empty or no filter link was found, fall back
 *      to the unfiltered page and keep only rows where stage === "Decision".
 *   5. Score remaining documents and return the top pick.
 *
 * @param {string} projectUrl   e.g. https://.../projects/EN010085
 * @returns {Promise<object|null>}
 */
async function findSoSDecisionForProject(projectUrl) {
  const docsUrl = buildDocumentsUrl(projectUrl);

  let $;
  try {
    $ = await fetchPage(docsUrl);
  } catch (err) {
    process.stderr.write(`    [docs] fetch error for ${docsUrl}: ${err.message}\n`);
    return null;
  }

  // Try the Decision stage filter link first
  const filterUrl = findDecisionFilterUrl($, docsUrl);
  let docs = [];

  if (filterUrl && filterUrl !== docsUrl) {
    await sleep(REQUEST_DELAY_MS);
    try {
      const $filtered = await fetchPage(filterUrl);
      docs = extractDocumentRows($filtered, filterUrl);
    } catch {
      // Fall through to unfiltered approach
    }
  }

  // Fallback: use unfiltered page, restrict to Decision-stage rows only
  if (docs.length === 0) {
    const allDocs = extractDocumentRows($, docsUrl);
    docs = allDocs.filter((d) => isDecisionStage(d.stage));
  }

  // If still nothing, try the full unfiltered list (last resort — expensive
  // for large projects but catches edge cases)
  if (docs.length === 0) {
    const allDocs = extractDocumentRows($, docsUrl);
    docs = allDocs;
  }

  return pickBestDecision(docs);
}

// ---------------------------------------------------------------------------
// URL mode detection
// ---------------------------------------------------------------------------

/**
 * Determine what kind of NSIP URL was passed.
 *
 * @param {string} url
 * @returns {"search"|"project"|"documents"|"unknown"}
 */
function detectUrlMode(url) {
  const u = url.toLowerCase();
  if (u.includes("/project-search") || u.includes("/projects?")) return "search";
  if (/\/projects\/[a-z]{2}\d{6}\/documents/.test(u)) return "documents";
  if (/\/projects\/[a-z]{2}\d{6}/.test(u)) return "project";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Process an array of items with bounded concurrency.
 * Calls `fn(item)` for each item, running at most `limit` at a time.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function pooledMap(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

(async () => {
  if (!INPUT_URL) {
    console.error(
      "Error: No URL provided.\n\n" +
        "Usage:\n" +
        "  node fetch-planning-data.js <url>\n\n" +
        "URL forms accepted:\n" +
        "  1. Project search page  — crawls all listed projects\n" +
        "     e.g. https://national-infrastructure-consenting.planninginspectorate.gov.uk/project-search?sector=energy&stage=post_decision\n\n" +
        "  2. Single project page  — e.g. https://.../projects/EN010085\n\n" +
        "  3. Project documents page — e.g. https://.../projects/EN010085/documents"
    );
    process.exit(1);
  }

  const mode = detectUrlMode(INPUT_URL);

  // ── Mode 1: Project search/filter page ────────────────────────────────────
  if (mode === "search" || mode === "unknown") {
    console.log(`Mode: project search\nInput: ${INPUT_URL}\n`);

    process.stderr.write("Collecting project links...\n");
    const projects = await scrapeProjectList(INPUT_URL);

    if (projects.length === 0) {
      console.log("No project links found on the search page.");
      process.exit(0);
    }

    console.log(`Found ${projects.length} project(s). Fetching decision documents...\n`);

    let done = 0;
    const results = await pooledMap(projects, CONCURRENCY, async (project) => {
      const decision = await findSoSDecisionForProject(project.projectUrl);
      done++;
      const status = decision ? `score=${decision.score}` : "not found";
      process.stderr.write(
        `  [${done}/${projects.length}] ${project.name} — ${status}\n`
      );
      return {
        project: project.name,
        projectUrl: project.projectUrl,
        sosDecision: decision,
      };
    });

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf8");
    const found = results.filter((r) => r.sosDecision).length;
    console.log(
      `\nDone. ${found}/${projects.length} projects have a matched SoS decision.`
    );
    console.log(`Results written to: ${OUTPUT_FILE}`);
    return;
  }

  // ── Mode 2: Single project page ───────────────────────────────────────────
  if (mode === "project") {
    console.log(`Mode: single project\nInput: ${INPUT_URL}\n`);
    const decision = await findSoSDecisionForProject(INPUT_URL);
    if (decision) {
      console.log("Secretary of State decision document found:\n");
      console.log(JSON.stringify(decision, null, 2));
    } else {
      console.log("No Secretary of State decision document found.");
    }
    return;
  }

  // ── Mode 3: Documents page directly ───────────────────────────────────────
  if (mode === "documents") {
    console.log(`Mode: documents page\nInput: ${INPUT_URL}\n`);
    let $;
    try {
      $ = await fetchPage(INPUT_URL);
    } catch (err) {
      console.error(`Failed to fetch page: ${err.message}`);
      process.exit(1);
    }

    // Try Decision filter link first
    const filterUrl = findDecisionFilterUrl($, INPUT_URL);
    let docs = [];

    if (filterUrl && filterUrl !== INPUT_URL) {
      try {
        const $filtered = await fetchPage(filterUrl);
        docs = extractDocumentRows($filtered, filterUrl);
      } catch { /* fall through */ }
    }

    if (docs.length === 0) {
      docs = extractDocumentRows($, INPUT_URL).filter((d) =>
        isDecisionStage(d.stage)
      );
    }

    if (docs.length === 0) {
      docs = extractDocumentRows($, INPUT_URL);
    }

    const decision = pickBestDecision(docs);
    if (decision) {
      console.log("Secretary of State decision document found:\n");
      console.log(JSON.stringify(decision, null, 2));
    } else {
      console.log("No Secretary of State decision document found.");
    }
  }
})();
