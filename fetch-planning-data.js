"use strict";

/**
 * fetch-planning-data.js
 *
 * Crawls the UK Planning Inspectorate NSIP site and extracts the single
 * best-matching Secretary of State decision document for each project.
 *
 * Accepted input URL forms:
 *   1. Project search/filter page  → scrapes all projects, writes sos-decisions.json
 *   2. Single project page         → prints result to stdout
 *   3. Single project documents page → prints result to stdout
 *
 * Usage:
 *   node fetch-planning-data.js <url>
 *   node fetch-planning-data.js <url> --debug   ← saves raw HTML for inspection
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
const DEBUG_MODE = process.argv.includes("--debug");

const MINIMUM_SCORE = 3;
const CONCURRENCY = 3;
const REQUEST_DELAY_MS = 400;
const OUTPUT_FILE = path.join(process.cwd(), "sos-decisions.json");

// ---------------------------------------------------------------------------
// Scoring rules
// ---------------------------------------------------------------------------

const DECISION_STAGE_KEYWORDS = [
  "recommendation and decision",
  "recommendation & decision",
  "decision",
];

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
    reason: "notification of decision (not the SoS decision letter)",
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

function isDecisionStage(stage) {
  const s = normaliseText(stage);
  if (s.includes("post-decision") || s.includes("post decision")) return false;
  return DECISION_STAGE_KEYWORDS.some((kw) => s.includes(kw));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreDecisionDocument(doc) {
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
  if (isDecisionStage(doc.stage)) {
    score += 2;
    reasons.push("+2: document is in the Decision stage");
  }

  return { score, reasons };
}

function pickBestDecision(docs) {
  const scored = docs
    .map((doc) => {
      const { score, reasons } = scoreDecisionDocument(doc);
      return { ...doc, score, matchedReason: reasons.join("; ") };
    })
    .filter((d) => d.score >= MINIMUM_SCORE)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aD = isDecisionStage(a.stage) ? 0 : 1;
      const bD = isDecisionStage(b.stage) ? 0 : 1;
      if (aD !== bD) return aD - bD;
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
    const fname = `debug-${url.replace(/[^a-z0-9]/gi, "_").slice(-60)}.html`;
    fs.writeFileSync(fname, res.data, "utf8");
    process.stderr.write(`  [debug] saved HTML to ${fname}\n`);
  }
  return cheerio.load(res.data);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Document extraction — multiple strategies
//
// The NSIP documents page structure is not known ahead of time. We try three
// approaches in order and return the first non-empty result.
// ---------------------------------------------------------------------------

/**
 * Strategy A: standard HTML <table> with <tr>/<td> columns.
 * Expected column order: title, date, stage, document-type.
 */
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

/**
 * Strategy B: GOV.UK Design System summary list / definition list.
 * Each document might be a <dl> or <details> block.
 */
function extractFromDefinitionList($, baseUrl) {
  const docs = [];
  // Look for any container that has both a link and nearby dt/dd pairs
  $("dl, .govuk-summary-list").each((_, dl) => {
    const $dl = $(dl);
    const $link = $dl.find("a[href]").first();
    if (!$link.length) return;

    const title = $link.text().replace(/\s*\(pdf[^)]*\)/i, "").trim();
    const url = resolveUrl($link.attr("href"), baseUrl);
    if (!title || !url) return;

    let publishedDate = null;
    let stage = null;
    let documentType = null;

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

/**
 * Strategy C: generic link scan.
 *
 * For every document-like anchor, walk UP the DOM up to 5 levels looking for
 * a container (row, li, article, div) whose text content contains a known
 * stage label. Crucially, we only read text from WITHIN the same row-level
 * container — not from the sidebar — by stopping as soon as the container
 * text grows beyond ~800 characters (which would indicate we've gone too
 * high up and are reading page-level text including the sidebar).
 */
function extractFromGenericLinks($, baseUrl) {
  const docs = [];
  const seen = new Set();

  // Known stage names, used to detect stage column text
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
    // Skip obvious navigation / UI links
    if (/^(home|documents|back|next|previous|search|apply|filters?|results?\s+per\s+page|show\s+all)$/i.test(rawTitle)) return;

    const url = resolveUrl(href, baseUrl);
    if (!url || seen.has(url)) return;

    const title = rawTitle.replace(/\s*\(pdf[^)]*\)/i, "").trim();

    // Walk up the DOM to find a row-level container
    let stage = null;
    let publishedDate = null;
    let $container = $el;

    for (let depth = 0; depth < 6; depth++) {
      $container = $container.parent();
      if (!$container.length) break;
      const tag = ($container[0].tagName || "").toLowerCase();
      if (tag === "body" || tag === "main" || tag === "html") break;

      const text = $container.text();
      // Stop climbing if the container text is very large (page-level, includes sidebar)
      if (text.length > 900) break;

      if (!stage) {
        const m = text.match(STAGE_RE);
        if (m) stage = m[1];
      }
      if (!publishedDate) {
        const m = text.match(DATE_RE);
        if (m) publishedDate = m[1];
      }
      if (stage && publishedDate) break;
    }

    seen.add(url);
    docs.push({ title, url, publishedDate: publishedDate || null, stage: stage || null, documentType: null });
  });

  return docs;
}

/**
 * Run all three extraction strategies and return the first non-empty result.
 * If debug mode is on, prints a summary of what each strategy found.
 */
function extractAllDocuments($, baseUrl) {
  const strategies = [
    { name: "table", fn: extractFromTable },
    { name: "definition-list", fn: extractFromDefinitionList },
    { name: "generic-links", fn: extractFromGenericLinks },
  ];

  for (const { name, fn } of strategies) {
    const docs = fn($, baseUrl);
    if (DEBUG_MODE) {
      process.stderr.write(`  [debug] strategy=${name} found ${docs.length} docs\n`);
      if (docs.length > 0) {
        process.stderr.write(`    sample: ${JSON.stringify(docs[0])}\n`);
      }
    }
    if (docs.length > 0) return docs;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Filter / search URL discovery
//
// The documents page has a filter form with stage checkboxes.
// We try multiple ways to construct a URL that pre-filters to Decision docs.
// ---------------------------------------------------------------------------

/**
 * Inspect the documents page filter form and try to derive a URL that returns
 * only Decision-stage documents.
 *
 * Tries (in order):
 *   1. An <a> whose text is exactly "Decision" or "Decision (N)" (direct link)
 *   2. A <form> containing a checkbox/option with value containing "decision"
 *      → constructs the GET URL from form action + that input's name/value
 *   3. Known URL parameter patterns appended to the base docs URL
 *
 * Returns null if no useful filter URL can be determined.
 */
function findDecisionFilterUrl($, docsUrl) {
  // 1. Direct anchor link (e.g., some sites use links not forms for filters)
  let found = null;
  $("a[href]").each((_, el) => {
    if (found) return;
    const text = normaliseText($(el).text());
    if (
      /^decision(\s*\(\d+\))?$/.test(text) ||
      /^recommendation\s*(and|&)\s*decision(\s*\(\d+\))?$/.test(text)
    ) {
      found = resolveUrl($(el).attr("href"), docsUrl);
    }
  });
  if (found && found !== docsUrl) return found;

  // 2. Filter form: look for a checkbox/option with a "decision" value
  $("form").each((_, form) => {
    if (found) return;
    const $form = $(form);
    const action = $form.attr("action")
      ? resolveUrl($form.attr("action"), docsUrl)
      : docsUrl;

    // Find the input/select whose value or nearby label says "decision"
    $form.find("input[type=checkbox], input[type=radio], option").each((_, input) => {
      if (found) return;
      const val = normaliseText($(input).attr("value") || "");
      const labelText = normaliseText(
        $(input).closest("label").text() ||
        $(`label[for='${$(input).attr("id")}']`).text() ||
        $(input).parent().text()
      );

      if (val === "decision" || /^decision(\s*\(\d+\))?$/.test(labelText)) {
        const inputName = $(input).attr("name") || "stage";
        const params = new URLSearchParams();
        params.append(inputName, val || "decision");
        found = `${action}${action.includes("?") ? "&" : "?"}${params.toString()}`;
      }
    });
  });
  if (found && found !== docsUrl) return found;

  // 3. Try common URL parameter patterns
  const base = docsUrl.split("?")[0];
  const candidates = [
    `${base}?stage=Decision`,
    `${base}?stage=decision`,
    `${base}?filters%5Bstage%5D%5B%5D=decision`,  // filters[stage][]=decision
    `${base}?type=decision`,
    `${base}?category=decision`,
  ];
  // Return the first candidate — caller will verify if it returns useful results
  return candidates[0];
}

/**
 * From the project info page (/projects/EN010085), find the href of the
 * "Decision" stage link in the stage timeline list.
 * This sometimes points directly to a filtered view of the documents.
 */
function findDecisionStageLinkFromProjectPage($, projectUrl) {
  let found = null;
  $("a[href]").each((_, el) => {
    if (found) return;
    const text = normaliseText($(el).text());
    const href = $(el).attr("href");
    if (!href) return;
    // Match a "Decision" link that isn't the full documents page
    if (/^decision$/.test(text) && !href.includes("/documents")) {
      found = resolveUrl(href, projectUrl);
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Level 1 — Project search/list page
// ---------------------------------------------------------------------------

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

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      if (!/\/projects\/[A-Za-z]{2}\d{6}\/?$/.test(href)) return;
      const absolute = resolveUrl(href.replace(/\/$/, ""), BASE_URL);
      if (seen.has(absolute)) return;
      seen.add(absolute);
      projects.push({ name: $(el).text().trim(), projectUrl: absolute });
    });

    let nextHref = null;
    const $next = $("a[rel='next']").first();
    if ($next.length) {
      nextHref = $next.attr("href");
    } else {
      $("a").each((_, el) => {
        const t = normaliseText($(el).text());
        if (t === "next" || t === "next page" || t === "›" || t === "»") {
          nextHref = $(el).attr("href");
        }
      });
    }

    if (nextHref) {
      pageUrl = resolveUrl(nextHref, pageUrl);
      pageNum++;
      await sleep(REQUEST_DELAY_MS);
    } else {
      pageUrl = null;
    }
  }

  return projects;
}

// ---------------------------------------------------------------------------
// Level 2 — Per-project decision document lookup
// ---------------------------------------------------------------------------

function buildDocumentsUrl(projectUrl) {
  return projectUrl.replace(/\/$/, "") + "/documents";
}

/**
 * Main logic for finding the SoS decision document for one project.
 *
 * Flow:
 *   1. Fetch the documents page.
 *   2. Find a Decision-stage filter URL (via form inspection + URL patterns).
 *   3. Fetch the filtered page, extract docs, score.
 *   4. If the filtered page gives nothing, fall back to unfiltered full extraction
 *      and keep only rows where stage === "Decision".
 *   5. If still nothing, run scoring across ALL extracted docs (last resort).
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

  if (DEBUG_MODE) {
    // Print high-level DOM stats to help diagnose extraction issues
    process.stderr.write(
      `  [debug] ${docsUrl} — tables:${$("table").length} tr:${$("tr").length} ` +
        `li:${$("li").length} dl:${$("dl").length} a:${$("a").length}\n`
    );
  }

  // ── Step 2: Find a Decision filter URL ──────────────────────────────────
  const filterUrl = findDecisionFilterUrl($, docsUrl);

  // ── Step 3: Fetch the filtered page ─────────────────────────────────────
  let docs = [];

  if (filterUrl && filterUrl !== docsUrl) {
    await sleep(REQUEST_DELAY_MS);
    try {
      const $f = await fetchPage(filterUrl);
      docs = extractAllDocuments($f, filterUrl);
      if (DEBUG_MODE) {
        process.stderr.write(
          `  [debug] filterUrl=${filterUrl} → ${docs.length} docs extracted\n`
        );
      }
    } catch {
      // fall through
    }
  }

  // ── Step 4: Fallback — unfiltered page, keep only Decision-stage rows ───
  if (docs.length === 0) {
    const all = extractAllDocuments($, docsUrl);
    docs = all.filter((d) => isDecisionStage(d.stage));
    if (DEBUG_MODE) {
      process.stderr.write(
        `  [debug] fallback: extracted ${all.length} total, ${docs.length} decision-stage\n`
      );
    }
  }

  // ── Step 5: Last resort — score everything ───────────────────────────────
  if (docs.length === 0) {
    docs = extractAllDocuments($, docsUrl);
    if (DEBUG_MODE) {
      process.stderr.write(
        `  [debug] last-resort: extracted ${docs.length} total docs\n`
      );
    }
  }

  return pickBestDecision(docs);
}

// ---------------------------------------------------------------------------
// URL mode detection
// ---------------------------------------------------------------------------

function detectUrlMode(url) {
  const u = url.toLowerCase();
  if (u.includes("/project-search") || u.includes("/projects?")) return "search";
  if (/\/projects\/[a-z]{2}\d{6}\/documents/.test(u)) return "documents";
  if (/\/projects\/[a-z]{2}\d{6}/.test(u)) return "project";
  return "search"; // default: treat as search/list page
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

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

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

(async () => {
  if (!INPUT_URL) {
    console.error(
      "Usage:\n" +
        "  node fetch-planning-data.js <url>\n" +
        "  node fetch-planning-data.js <url> --debug\n\n" +
        "URL forms:\n" +
        "  1. Project search  — https://.../project-search?sector=energy&stage=post_decision\n" +
        "  2. Single project  — https://.../projects/EN010085\n" +
        "  3. Documents page  — https://.../projects/EN010085/documents\n\n" +
        "--debug  saves raw HTML files and prints DOM stats for troubleshooting"
    );
    process.exit(1);
  }

  const mode = detectUrlMode(INPUT_URL);

  // ── Single project documents page ────────────────────────────────────────
  if (mode === "documents") {
    console.log(`Mode: documents page\nInput: ${INPUT_URL}\n`);
    let $;
    try {
      $ = await fetchPage(INPUT_URL);
    } catch (err) {
      console.error(`Failed to fetch: ${err.message}`);
      process.exit(1);
    }
    const filterUrl = findDecisionFilterUrl($, INPUT_URL);
    let docs = [];
    if (filterUrl && filterUrl !== INPUT_URL) {
      try {
        const $f = await fetchPage(filterUrl);
        docs = extractAllDocuments($f, filterUrl);
      } catch { /* fall through */ }
    }
    if (docs.length === 0) {
      docs = extractAllDocuments($, INPUT_URL).filter((d) => isDecisionStage(d.stage));
    }
    if (docs.length === 0) {
      docs = extractAllDocuments($, INPUT_URL);
    }
    const decision = pickBestDecision(docs);
    if (decision) {
      console.log("Secretary of State decision document found:\n");
      console.log(JSON.stringify(decision, null, 2));
    } else {
      console.log("No Secretary of State decision document found.");
    }
    return;
  }

  // ── Single project page ───────────────────────────────────────────────────
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

  // ── Project search/filter page ────────────────────────────────────────────
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
    process.stderr.write(`  [${done}/${projects.length}] ${project.name} — ${status}\n`);
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
})();
