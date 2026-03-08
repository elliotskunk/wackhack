"use strict";

/**
 * fetch-planning-data.js
 *
 * Scrapes a UK Planning Inspectorate NSIP project document library page and
 * returns ONLY the best-matching Secretary of State decision document.
 *
 * Usage:
 *   node fetch-planning-data.js <project-library-url>
 *   node fetch-planning-data.js  (uses the PROJECT_URL constant below)
 */

const axios = require("axios");
const cheerio = require("cheerio");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Replace with the target NSIP project library URL, or pass it as argv[2].
const PROJECT_URL =
  process.argv[2] || "PROJECT_LIBRARY_PAGE_URL";

// Minimum score a document must reach before it is considered a candidate.
// Tune upward to be stricter, downward to be more lenient.
const MINIMUM_SCORE = 3;

// ---------------------------------------------------------------------------
// Stage/category keywords that indicate the final decision stage.
// Matched against the normalised stage/category label on the page.
// ---------------------------------------------------------------------------
const DECISION_STAGE_KEYWORDS = [
  "decision",
  "recommendation and decision",
  "recommendation & decision",
];

// ---------------------------------------------------------------------------
// Title scoring rules.
// Each rule carries a weight; the weights are additive.
// Rules are tested against the normalised (lowercase, trimmed) title.
// ---------------------------------------------------------------------------
const TITLE_SCORE_RULES = [
  // Highest confidence: both "secretary of state" and "decision" present
  {
    weight: 5,
    test: (t) => t.includes("secretary of state") && t.includes("decision"),
    reason: 'title contains "secretary of state" and "decision"',
  },
  // "decision letter" is a very strong signal on its own
  {
    weight: 4,
    test: (t) => t.includes("decision letter"),
    reason: 'title contains "decision letter"',
  },
  // "letter from the secretary of state" — common phrasing
  {
    weight: 4,
    test: (t) =>
      t.includes("letter from the secretary of state"),
    reason: 'title contains "letter from the secretary of state"',
  },
  // "decision and statement of reasons" or "decision letter and statement of reasons"
  {
    weight: 3,
    test: (t) =>
      t.includes("decision") && t.includes("statement of reasons"),
    reason: 'title contains "decision" and "statement of reasons"',
  },
  // Plain "secretary of state" in title (weaker on its own)
  {
    weight: 2,
    test: (t) => t.includes("secretary of state"),
    reason: 'title contains "secretary of state"',
  },
  // Stage bonus: document lives in a decision-related stage
  // (applied separately in scoreDecisionDocument)
];

// ---------------------------------------------------------------------------
// Penalty rules — subtract from score when these patterns match the title.
// Keeps recommendation-only documents from being selected unless they also
// clearly reference the final decision.
// ---------------------------------------------------------------------------
const TITLE_PENALTY_RULES = [
  // Recommendation report alone (not bundled with the decision)
  {
    penalty: 4,
    test: (t) =>
      /\brecommendation\b/.test(t) &&
      !t.includes("decision") &&
      !t.includes("secretary of state"),
    reason: "title appears to be a recommendation-only document",
  },
  // Inspector's report / examining authority report
  {
    penalty: 3,
    test: (t) =>
      t.includes("inspector") &&
      !t.includes("secretary of state") &&
      !t.includes("decision"),
    reason: "title appears to be an inspector's report, not the SoS decision",
  },
  // Procedural decisions (e.g. "procedural decision", "rule 8 decision")
  {
    penalty: 5,
    test: (t) =>
      t.includes("procedural decision") ||
      /rule\s*[68]\s*decision/.test(t),
    reason: "title appears to be a procedural decision, not the final SoS decision",
  },
  // Acceptance decision (pre-examination stage)
  {
    penalty: 4,
    test: (t) => t.includes("acceptance decision") || t.includes("accepted for examination"),
    reason: "title appears to be an acceptance decision",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a lowercase, whitespace-normalised copy of `str`.
 * Safe to call on null/undefined — returns "".
 *
 * @param {string|null|undefined} str
 * @returns {string}
 */
function normaliseText(str) {
  if (!str) return "";
  return str.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Resolves a potentially relative `href` against `baseUrl`.
 *
 * @param {string} href   - The raw href attribute value.
 * @param {string} baseUrl - The page URL used as the base.
 * @returns {string} - Absolute URL.
 */
function resolveUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href; // return as-is if resolution fails
  }
}

/**
 * Returns true when the stage/category label suggests this is the
 * final decision stage of the project.
 *
 * @param {string|null} stage
 * @returns {boolean}
 */
function isDecisionStage(stage) {
  const s = normaliseText(stage);
  return DECISION_STAGE_KEYWORDS.some((kw) => s.includes(kw));
}

/**
 * Scores a candidate document object against the Secretary of State
 * decision heuristics.
 *
 * Returns an object:
 *   { score: number, reasons: string[] }
 *
 * @param {{ title: string, stage: string|null }} doc
 * @returns {{ score: number, reasons: string[] }}
 */
function scoreDecisionDocument(doc) {
  const title = normaliseText(doc.title);
  const reasons = [];
  let score = 0;

  // Apply positive title rules
  for (const rule of TITLE_SCORE_RULES) {
    if (rule.test(title)) {
      score += rule.weight;
      reasons.push(`+${rule.weight}: ${rule.reason}`);
    }
  }

  // Apply penalty rules
  for (const rule of TITLE_PENALTY_RULES) {
    if (rule.test(title)) {
      score -= rule.penalty;
      reasons.push(`-${rule.penalty}: ${rule.reason}`);
    }
  }

  // Stage bonus: +2 if the document is in a decision-related stage
  if (isDecisionStage(doc.stage)) {
    score += 2;
    reasons.push("+2: document is in a decision-related stage/category");
  }

  return { score, reasons };
}

/**
 * Returns true when a document's final score makes it a plausible
 * Secretary of State decision.
 *
 * @param {{ score: number }} scored
 * @returns {boolean}
 */
function isLikelySecretaryOfStateDecision(scored) {
  return scored.score >= MINIMUM_SCORE;
}

// ---------------------------------------------------------------------------
// Page parsing
// ---------------------------------------------------------------------------

/**
 * Extracts all candidate documents from a loaded Cheerio instance.
 *
 * The Planning Inspectorate document library is structured with stage/category
 * headings (h2, h3, or labelled sections) followed by lists of documents.
 * This function walks every anchor on the page, then attempts to discover
 * the nearest heading to use as the stage label.
 *
 * Assumptions about page structure:
 *   - Documents are represented as <a> tags with an href pointing to a PDF
 *     or document viewer page.
 *   - Stage/category labels are present as heading elements (h2/h3) or
 *     elements with class names containing "stage", "category", or "heading"
 *     that precede the document links.
 *   - Published dates, when present, appear in a sibling or parent element
 *     close to the link (e.g. a <td> or <span> with a date-like string).
 *
 * If the page structure differs significantly, adjust the selectors below.
 *
 * @param {cheerio.CheerioAPI} $
 * @param {string} baseUrl
 * @returns {Array<{ title, url, publishedDate, stage }>}
 */
function extractDocuments($, baseUrl) {
  const docs = [];

  $("a[href]").each((_, el) => {
    const $el = $(el);
    const rawTitle = $el.text().trim();
    const rawHref = $el.attr("href");

    // Skip anchors with no meaningful text or href
    if (!rawTitle || !rawHref) return;
    // Skip anchors that look like navigation (very short text, no path)
    if (rawTitle.length < 4 && !/\w{3}/.test(rawTitle)) return;

    const url = resolveUrl(rawHref, baseUrl);

    // --- Attempt to resolve the stage/category label ---
    // Walk up the DOM looking for a heading or labelled ancestor.
    let stage = null;

    // Strategy 1: look for a preceding h2/h3 sibling or a heading inside a
    // parent section/article element.
    const $parent = $el.closest("section, article, div, tr");
    if ($parent.length) {
      // Check for a heading inside this container
      const headingInContainer = $parent
        .find("h2, h3, h4, [class*='stage'], [class*='category'], [class*='heading']")
        .first()
        .text()
        .trim();
      if (headingInContainer) {
        stage = headingInContainer;
      }

      // If no heading found inside, walk upward
      if (!stage) {
        let $cursor = $parent;
        while ($cursor.length && $cursor[0].tagName !== "body") {
          const $prev = $cursor.prev("h2, h3, h4");
          if ($prev.length) {
            stage = $prev.text().trim();
            break;
          }
          $cursor = $cursor.parent();
        }
      }
    }

    // Strategy 2: look for the nearest preceding heading in the document flow
    if (!stage) {
      let $cursor = $el;
      while ($cursor.length) {
        $cursor = $cursor.prev();
        if (!$cursor.length) {
          $cursor = $cursor.parent();
          if (!$cursor.length || $cursor[0].tagName === "body") break;
          continue;
        }
        const tag = $cursor[0] && $cursor[0].tagName;
        if (tag === "h2" || tag === "h3" || tag === "h4") {
          stage = $cursor.text().trim();
          break;
        }
      }
    }

    // --- Attempt to find a published date near the link ---
    let publishedDate = null;
    const $row = $el.closest("tr");
    if ($row.length) {
      // Table layout: look for a date in sibling cells
      $row.find("td").each((_, td) => {
        const cellText = $(td).text().trim();
        if (
          !publishedDate &&
          /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}/i.test(
            cellText
          )
        ) {
          publishedDate = cellText;
        }
      });
    }

    if (!publishedDate) {
      // Non-table: check nearby spans/divs for date-like content
      const $nearestParent = $el.closest("li, div, p");
      if ($nearestParent.length) {
        const parentText = $nearestParent.text();
        const dateMatch = parentText.match(
          /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4})\b/i
        );
        if (dateMatch) publishedDate = dateMatch[1];
      }
    }

    docs.push({
      title: rawTitle,
      url,
      publishedDate: publishedDate || null,
      stage: stage || null,
    });
  });

  return docs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Fetches the NSIP project library page and returns the single best-matching
 * Secretary of State decision document, or null if none found above the
 * minimum confidence threshold.
 *
 * @param {string} url
 * @returns {Promise<object|null>}
 */
async function fetchSoSDecision(url) {
  let html;
  try {
    const res = await axios.get(url, {
      headers: {
        // Mimic a browser request; the Planning Inspectorate site may reject
        // plain axios user-agents.
        "User-Agent":
          "Mozilla/5.0 (compatible; NSIP-SoS-Decision-Scraper/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      timeout: 30_000,
    });
    html = res.data;
  } catch (err) {
    throw new Error(`Failed to fetch page: ${err.message}`);
  }

  const $ = cheerio.load(html);

  // Extract all documents from the page
  const allDocs = extractDocuments($, url);

  if (allDocs.length === 0) {
    console.warn("No documents found on the page. Check the URL or page structure.");
    return null;
  }

  // Score every document
  const scored = allDocs
    .map((doc) => {
      const { score, reasons } = scoreDecisionDocument(doc);
      return { ...doc, score, matchedReason: reasons.join("; ") };
    })
    // Keep only those above the minimum threshold
    .filter(isLikelySecretaryOfStateDecision)
    // Sort highest score first; break ties by preferring documents in a
    // decision-related stage, then alphabetically by title for determinism.
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aIsDecision = isDecisionStage(a.stage) ? 0 : 1;
      const bIsDecision = isDecisionStage(b.stage) ? 0 : 1;
      if (aIsDecision !== bIsDecision) return aIsDecision - bIsDecision;
      return a.title.localeCompare(b.title);
    });

  if (scored.length === 0) {
    console.warn(
      `No document met the minimum confidence threshold (score >= ${MINIMUM_SCORE}).`
    );
    return null;
  }

  // Return only the top-ranked result in the required shape
  const best = scored[0];
  return {
    title: best.title,
    url: best.url,
    publishedDate: best.publishedDate,
    stage: best.stage,
    matchedReason: best.matchedReason,
    score: best.score,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

(async () => {
  if (!PROJECT_URL || PROJECT_URL === "PROJECT_LIBRARY_PAGE_URL") {
    console.error(
      "Error: No URL provided.\n" +
        "Usage: node fetch-planning-data.js <project-library-url>"
    );
    process.exit(1);
  }

  console.log(`Fetching: ${PROJECT_URL}\n`);

  const result = await fetchSoSDecision(PROJECT_URL);

  if (result) {
    console.log("Secretary of State decision document found:\n");
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("No Secretary of State decision document found.");
  }
})();
