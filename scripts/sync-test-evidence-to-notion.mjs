#!/usr/bin/env node
/**
 * Sync QA test evidence (screenshots + structured AC outcomes) from Linear
 * comments into the "McGill Test Evidence" Notion database, including real
 * embedded images.
 *
 * Why this script exists: Linear Loops can only call structured MCP connector
 * actions, not arbitrary HTTP requests. That blocks two things a real sync
 * needs: (a) an authenticated GET of screenshot bytes from Linear's
 * uploads.linear.app, and (b) the raw multipart POST that Notion's upload flow
 * requires. This script has a real HTTP client (Node's built-in fetch) and
 * does both directly. The "Sync MCG test evidence to Notion" Loop's only job
 * is to detect a #test-output / #regression-test-output comment on an issue
 * that just moved to Passed QA, and commit a trigger file
 * (.github/triggers/<ISSUE-ID>.json) to this repo; a GitHub Actions workflow
 * then runs this script.
 *
 * Comment format parsed (the real production template):
 *
 *   #test-output
 *   Environment: SIT
 *   Product: McGill Portal
 *   Iteration/Sprint: Sprint 14
 *   Record: https://example.com/testrecord/1
 *   AC1: <description>
 *   Outcome: Pass
 *   Evidence: <text> [zero or more pasted screenshots]
 *   AC2: <description>
 *   Outcome: Fail
 *   Evidence: <text> [zero or more pasted screenshots]
 *   ...
 *
 * Evidence/Record can optionally be tagged with the AC number(s) they apply
 * to, e.g. "Evidence (AC1, AC2): ..." or "Record (AC2, AC3): ..." so one
 * screenshot or link can cover multiple ACs. An AC-level Record overrides the
 * top-level Record for that AC only (never shown at all when Environment is
 * DEV - the QA team reading this doc has no DEV access).
 *
 * Regression comments use #regression-test-output and add a "Scenario:" name
 * field; a single scenario's testing can be split across multiple comments -
 * every comment naming the same Scenario is treated as part of that scenario.
 *
 * Multi-comment behaviour (per Elizabeth, 2026-08-27): there is no audit
 * trail. Every #test-output comment on the issue is scanned, but for a given
 * AC number the LATEST comment that mentions that AC wins outright - its
 * outcome, evidence and record fully replace whatever an earlier comment said
 * about that same AC. Same rule per Scenario name for #regression-test-output
 * comments. The Notion page is rewritten from scratch every run to reflect
 * only this current merged state - no superseded entries, no history.
 *
 * NOTE on table/column width: the Notion public API does not expose column
 * widths or the page "full width" toggle - those are client-only settings,
 * so wider/A4-like tables need a one-time manual adjustment in Notion.
 *
 * Required environment variables (set as GitHub Actions repo secrets):
 *   LINEAR_API_KEY      - Linear personal API key, read (and comment) access
 *   NOTION_TOKEN         - Notion internal integration token, shared with the
 *                          "McGill Test Evidence" database
 *   NOTION_DATABASE_ID   - the database's id (from its URL)
 *   ISSUE_IDENTIFIER     - e.g. "MCG-147"
 */

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const ISSUE_IDENTIFIER = process.env.ISSUE_IDENTIFIER;

const TEST_MARKER = '#test-output';
const REGRESSION_MARKER = '#regression-test-output';
// Every comment this script posts carries this signature. It is excluded from
// marker matching so the sync never mistakes its own confirmation/failure
// comments for a new piece of test evidence on the next run. The message text
// also deliberately never spells out the literal "#test-output" /
// "#regression-test-output" hashtags, as a second line of defence.
const AUTOMATION_SIGNATURE = 'posted automatically by the McGill Notion sync';

const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';
const LINEAR_API = 'https://api.linear.app/graphql';

// Outcome -> Notion rich_text colour annotation. Applied everywhere an outcome
// word is rendered: the Summary callout's Overall status, AC Outcomes tables,
// Scenario headings, and each AC's Outcome line in the Evidence Log.
const OUTCOME_COLOR = {
  Pass: 'green',
  Fail: 'red',
  Partial: 'yellow',
};

function assertEnv() {
  const missing = [];
  if (!LINEAR_API_KEY) missing.push('LINEAR_API_KEY');
  if (!NOTION_TOKEN) missing.push('NOTION_TOKEN');
  if (!NOTION_DATABASE_ID) missing.push('NOTION_DATABASE_ID');
  if (!ISSUE_IDENTIFIER) missing.push('ISSUE_IDENTIFIER');
  if (missing.length) {
    throw new Error(`Missing required secrets/env vars: ${missing.join(', ')}`);
  }
}

async function linearGraphQL(query, variables) {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Linear personal API keys go directly in Authorization, no "Bearer" prefix.
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`Linear GraphQL error: ${res.status} ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

async function getIssueWithComments(identifier) {
  // Linear's comments connection defaults to a single page (first 50, oldest
  // first) when no pagination args are given. On an issue with a long testing
  // history that silently hides every comment added after that cutoff. Page
  // through the full connection explicitly so we always see every comment.
  const query = `
    query IssueComments($id: String!, $after: String) {
      issue(id: $id) {
        id
        identifier
        title
        url
        comments(first: 100, after: $after) {
          nodes { id url body createdAt user { name } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  let after = null;
  let allComments = [];
  let issueMeta = null;
  for (;;) {
    const data = await linearGraphQL(query, { id: identifier, after });
    if (!data.issue) throw new Error(`Linear issue "${identifier}" not found`);
    issueMeta = data.issue;
    allComments = allComments.concat(data.issue.comments.nodes);
    if (data.issue.comments.pageInfo.hasNextPage) {
      after = data.issue.comments.pageInfo.endCursor;
    } else {
      break;
    }
  }
  // Do not trust the connection's implicit order (observed to not reliably be
  // creation-ascending across pagination) - sort explicitly so "latest
  // comment per AC" merging is actually correct regardless of API ordering.
  allComments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return { ...issueMeta, comments: { nodes: allComments } };
}

// Linear silently rewrites a bare URL pasted into a comment into markdown
// link syntax, e.g. `[https://example.com/x](<https://example.com/x>)`. Every
// place that reads a Record: value takes the rest of the line verbatim, so
// without this it stores the whole `[...](...)` string as the link instead
// of the URL - producing a broken/wrong link in Notion. QA shouldn't have to
// remember to "paste as plain text" for this to work, so unwrap it here.
function unwrapMarkdownLink(text) {
  if (!text) return text;
  const trimmed = text.trim();
  const m = trimmed.match(/^\[[^\]]*\]\(<?([^)>\s]+)>?\)$/);
  return m ? m[1].trim() : trimmed;
}

// A QA tester sometimes writes several screenshots into one Evidence block
// with explanatory text between them, e.g. "step 1 [img] then step 2 [img]".
// Tokenize the block into an ordered sequence of text/image segments instead
// of bucketing all text together and all images together, so the original
// interleaving survives into Notion instead of being silently reordered.
function tokenizeEvidenceContent(content) {
  const tokens = [];
  const re = /!\[[^\]]*\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(content)) !== null) {
    const textBefore = content.slice(lastIndex, m.index).trim();
    if (textBefore) tokens.push({ type: 'text', text: textBefore });
    // Linear embeds pasted screenshots as markdown image syntax pointing at
    // uploads.linear.app. Authenticated download only - see downloadLinearAsset.
    tokens.push({ type: 'image', url: m[1] });
    lastIndex = re.lastIndex;
  }
  const textAfter = content.slice(lastIndex).trim();
  if (textAfter) tokens.push({ type: 'text', text: textAfter });
  return tokens;
}

function parseHeaderFields(body, endIndex) {
  const headerText = body.slice(0, endIndex);
  const get = (label) => {
    const re = new RegExp(`^${label}:\\s*(.+)$`, 'mi');
    const mm = headerText.match(re);
    return mm ? mm[1].trim() : null;
  };
  return {
    scenario: get('Scenario'),
    environment: get('Environment'),
    product: get('Product'),
    iteration: get('Iteration/Sprint'),
    record: unwrapMarkdownLink(get('Record')),
  };
}

/**
 * Parse every "AC<n>: <description> / Outcome: <Pass|Fail|Partial> / Evidence: ..."
 * block out of a single #test-output or #regression-test-output comment body.
 *
 * Outcome stays scoped strictly to each AC's own "AC<n>:" header line up to
 * the next "AC<n>:" header (or end of comment).
 *
 * Evidence and Record are parsed as standalone markers that can each
 * optionally be tagged with the AC number(s) they apply to, e.g.:
 *   Evidence (AC1, AC2): <text/screenshots shared by both ACs>
 *   Record (AC2, AC3): <link shown for AC2 and AC3 only, overriding the
 *                        top-level Record for those two ACs>
 * An untagged "Evidence:" / "Record:" marker (no parens) applies to whichever
 * AC header most recently precedes it. A marker's content runs up to the next
 * AC header or the next marker, whichever comes first, so a tagged marker can
 * sit after the last AC header it covers.
 */
function parseACBlocks(body) {
  const acHeaderRe = /^AC(\d+):\s*(.*)$/gm;
  const acHeaders = [];
  let m;
  while ((m = acHeaderRe.exec(body)) !== null) {
    acHeaders.push({ index: m.index, number: m[1], description: m[2].trim() });
  }
  if (acHeaders.length === 0) return { acs: [], firstIndex: body.length };

  const acData = new Map();
  for (let i = 0; i < acHeaders.length; i++) {
    const blockStart = acHeaders[i].index;
    const blockEnd = i + 1 < acHeaders.length ? acHeaders[i + 1].index : body.length;
    const blockText = body.slice(blockStart, blockEnd);
    const outcomeMatch = blockText.match(/Outcome:\s*(Pass|Fail|Partial)/i);
    const rawOutcome = outcomeMatch ? outcomeMatch[1] : null;
    const outcome = rawOutcome
      ? rawOutcome[0].toUpperCase() + rawOutcome.slice(1).toLowerCase()
      : 'Not specified';
    acData.set(acHeaders[i].number, {
      number: acHeaders[i].number,
      description: acHeaders[i].description,
      outcome,
      evidenceSegments: [],
      record: null,
      _blockText: blockText, // kept only for the no-Evidence-marker fallback below
    });
  }

  const markerRe = /^(Evidence|Record)\s*(?:\(([^)]*)\))?:\s*/gim;
  const markers = [];
  while ((m = markerRe.exec(body)) !== null) {
    markers.push({
      index: m.index,
      contentStart: m.index + m[0].length,
      kind: m[1].toLowerCase(),
      tag: m[2] || null,
    });
  }

  const boundaries = [...acHeaders.map((h) => h.index), ...markers.map((mk) => mk.index)].sort((a, b) => a - b);
  const nextBoundaryAfter = (pos) => boundaries.find((b) => b > pos) ?? body.length;

  for (const marker of markers) {
    const contentEnd = nextBoundaryAfter(marker.index);
    const content = body.slice(marker.contentStart, contentEnd);

    let targetNumbers;
    if (marker.tag) {
      targetNumbers = marker.tag
        .split(',')
        .map((s) => s.trim().replace(/^AC/i, ''))
        .filter(Boolean);
    } else {
      let nearest = null;
      for (const h of acHeaders) {
        if (h.index <= marker.index) nearest = h;
        else break;
      }
      targetNumbers = nearest ? [nearest.number] : [];
    }

    for (const num of targetNumbers) {
      const data = acData.get(num);
      if (!data) continue; // marker tags an AC number that doesn't exist in this comment
      if (marker.kind === 'evidence') {
        data.evidenceSegments = data.evidenceSegments.concat(tokenizeEvidenceContent(content));
      } else if (marker.kind === 'record') {
        const link = unwrapMarkdownLink(content.split('\n')[0]);
        if (link) data.record = link;
      }
    }
  }

  // Backward compatibility: an AC with no Evidence marker at all falls back
  // to treating its whole header-to-next-header span as evidence.
  for (const data of acData.values()) {
    if (data.evidenceSegments.length === 0) {
      data.evidenceSegments = tokenizeEvidenceContent(data._blockText);
    }
    delete data._blockText;
  }

  const acs = acHeaders.map((h) => acData.get(h.number));
  return { acs, firstIndex: acHeaders[0].index };
}

/**
 * Overall status from a set of outcome strings: Pass only if every one is
 * Pass, Fail only if every tested one is Fail, Partial if it's a mix, Not
 * tested if nothing was Pass/Fail/Partial. Used both for a set of ACs and for
 * a set of regression scenario statuses (combining scenarios into one
 * ticket-level regression status).
 */
function overallFromOutcomes(outcomes) {
  const tested = outcomes.filter((o) => o === 'Pass' || o === 'Fail' || o === 'Partial');
  if (tested.length === 0) return 'Not tested';
  if (tested.every((o) => o === 'Pass')) return 'Pass';
  if (tested.every((o) => o === 'Fail')) return 'Fail';
  return 'Partial';
}

function calcOverallStatus(acs) {
  return overallFromOutcomes(acs.map((ac) => ac.outcome));
}

/**
 * Merge a series of same-kind comments (all #test-output, or all
 * #regression-test-output comments for one Scenario), oldest first. For each
 * AC number, the LATEST comment that mentions it wins outright - its outcome,
 * evidence, and record fully replace any earlier comment's data for that same
 * AC. Header fields (Environment/Product/Iteration/Record) merge the same
 * way: the latest comment that sets a given field wins for that field.
 */
function mergeSeries(commentsAscending) {
  let header = { scenario: null, environment: null, product: null, iteration: null, record: null };
  const acMap = new Map();
  let latestContributing = null;
  for (const c of commentsAscending) {
    const { acs, firstIndex } = parseACBlocks(c.body);
    const h = parseHeaderFields(c.body, firstIndex);
    for (const key of ['scenario', 'environment', 'product', 'iteration', 'record']) {
      if (h[key]) header[key] = h[key];
    }
    if (acs.length > 0) {
      for (const ac of acs) acMap.set(ac.number, ac);
      latestContributing = c;
    }
  }
  const acs = Array.from(acMap.values()).sort((a, b) => Number(a.number) - Number(b.number));
  return { header, acs, latestContributing };
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// --- Small rich_text builders, so every outcome word gets the same treatment
// wherever it appears (Summary callout, AC Outcomes tables, Scenario headings,
// Evidence Log). ---

function plainText(content) {
  return { type: 'text', text: { content } };
}

function boldText(content) {
  return { type: 'text', text: { content }, annotations: { bold: true } };
}

function linkText(content, url) {
  return { type: 'text', text: { content, link: { url } } };
}

function outcomeText(outcome) {
  const color = OUTCOME_COLOR[outcome];
  return {
    type: 'text',
    text: { content: outcome },
    annotations: color ? { bold: true, color } : { bold: true },
  };
}

function labelValue(label, valueRuns) {
  // "**Label:** value" as a single rich_text run array.
  return [boldText(`${label}: `), ...(Array.isArray(valueRuns) ? valueRuns : [plainText(valueRuns)])];
}

async function downloadLinearAsset(url) {
  const res = await fetch(url, {
    headers: { Authorization: LINEAR_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`Failed to download Linear asset ${url}: HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || 'image/png';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

async function notionFetch(path, options = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      ...(options.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Notion API error on ${path}: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function findOrCreateNotionPage(issue) {
  const query = await notionFetch(`/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: {
        property: 'Linear ID',
        rich_text: { equals: issue.identifier },
      },
    }),
  });

  if (query.results && query.results.length > 0) {
    return { pageId: query.results[0].id, url: query.results[0].url };
  }

  const created = await notionFetch('/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Title: { title: [{ text: { content: `Test Evidence: ${issue.title}` } }] },
        'Linear ID': { rich_text: [{ text: { content: issue.identifier } }] },
        'Linear ticket': { url: issue.url },
      },
    }),
  });
  return { pageId: created.id, url: created.url };
}

async function updateNotionPageProperties(pageId, props) {
  const properties = {
    Title: { title: [{ text: { content: props.title } }] },
    'Linear ID': { rich_text: [{ text: { content: props.linearId } }] },
    'Linear ticket': { url: props.linearTicketUrl },
    'Test marker': { rich_text: [{ text: { content: props.testMarker } }] },
    Environment: props.environment ? { select: { name: props.environment } } : { select: null },
    Product: { rich_text: [{ text: { content: props.product || '' } }] },
    'Iteration/Sprint': { rich_text: [{ text: { content: props.iteration || '' } }] },
    Record: { url: props.record || null },
    'Final test status': props.finalStatus ? { select: { name: props.finalStatus } } : { select: null },
    'Last synced': { date: { start: new Date().toISOString() } },
    'AC summary': { rich_text: [{ text: { content: props.acSummary || '' } }] },
    'Linear comment': { url: props.linearCommentUrl || null },
  };
  return notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties }),
  });
}

/**
 * The Notion page body is rewritten from scratch every run (no history, per
 * the merge rules above) - so clear out whatever children the page currently
 * has before appending the fresh content.
 */
async function clearPageBody(pageId) {
  let cursor = undefined;
  const ids = [];
  for (;;) {
    const q = cursor ? `?start_cursor=${cursor}` : '';
    const res = await notionFetch(`/blocks/${pageId}/children${q}`, { method: 'GET' });
    ids.push(...res.results.map((b) => b.id));
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  for (const id of ids) {
    await notionFetch(`/blocks/${id}`, { method: 'DELETE' });
  }
}

async function createFileUpload(filename, contentType) {
  return notionFetch('/file_uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content_type: contentType }),
  });
}

async function sendFileUpload(fileUploadId, buffer, filename, contentType) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), filename);
  const res = await fetch(`${NOTION_API}/file_uploads/${fileUploadId}/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      // Deliberately no Content-Type here - fetch sets the multipart boundary itself.
    },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Notion file upload send failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function appendBlocks(pageId, children) {
  return notionFetch(`/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ children }),
  });
}

async function appendSummaryCallout(pageId, issue, header, overallStatus) {
  const rich_text = [
    ...labelValue('Ticket', [linkText(`${issue.identifier} — ${issue.title}`, issue.url)]),
    plainText('\n\n'),
    ...labelValue('Overall status', [outcomeText(overallStatus)]),
    plainText('\n\n'),
    ...labelValue('Environment', header.environment || 'Not specified'),
    plainText('\n\n'),
    ...labelValue('Product', header.product || 'Not specified'),
    plainText('\n\n'),
    ...labelValue('Iteration/Sprint', header.iteration || 'Not specified'),
  ];

  return appendBlocks(pageId, [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [plainText('Summary')] },
    },
    {
      object: 'block',
      type: 'callout',
      callout: {
        rich_text,
        icon: { type: 'emoji', emoji: '🗂️' },
      },
    },
  ]);
}

// rows: [{ label, description, outcome }]. Used both for ticket-level ACs
// (label "AC1") and, when a ticket has no #test-output comments at all, for a
// combined table of regression ACs prefixed by scenario name.
async function appendOutcomesTable(pageId, heading, rows) {
  const headerRow = {
    object: 'block',
    type: 'table_row',
    table_row: {
      cells: [[plainText('AC #')], [plainText('Description')], [plainText('Outcome')]],
    },
  };
  const dataRows = rows.map((r) => ({
    object: 'block',
    type: 'table_row',
    table_row: {
      cells: [[plainText(r.label)], [plainText(r.description)], [outcomeText(r.outcome)]],
    },
  }));

  return appendBlocks(pageId, [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [plainText(heading)] },
    },
    {
      object: 'block',
      type: 'table',
      table: {
        table_width: 3,
        has_column_header: true,
        has_row_header: false,
        children: [headerRow, ...dataRows],
      },
    },
  ]);
}

async function appendEvidenceLogHeader(pageId, dateIso, testerName) {
  const headerRow = {
    object: 'block',
    type: 'table_row',
    table_row: { cells: [[plainText('Date')], [plainText('Tester name')]] },
  };
  const dataRow = {
    object: 'block',
    type: 'table_row',
    table_row: {
      cells: [[plainText(formatDate(dateIso))], [plainText(testerName || 'Unknown')]],
    },
  };

  return appendBlocks(pageId, [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [plainText('Evidence Log')] },
    },
    {
      object: 'block',
      type: 'table',
      table: {
        table_width: 2,
        has_column_header: true,
        has_row_header: false,
        children: [headerRow, dataRow],
      },
    },
  ]);
}

async function appendEvidenceLogACBlock(pageId, ac, header, isDev) {
  const blocks = [
    { object: 'block', type: 'divider', divider: {} },
    {
      object: 'block',
      type: 'heading_3',
      heading_3: { rich_text: [plainText(`AC${ac.number} — ${ac.description}`)] },
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: labelValue('Outcome', [outcomeText(ac.outcome)]) },
    },
  ];

  // An AC-level "Record:" (optionally tagged to multiple ACs) overrides the
  // top-level comment Record for that AC only; other ACs fall back to it.
  // QA reads this doc without DEV access - never link to a DEV record, at
  // either level.
  const record = ac.record || header.record;
  if (record && !isDev) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: labelValue('Record', [linkText('Open test record', record)]) },
    });
  }

  blocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [boldText('Evidence')] },
  });

  // Text and screenshots within this AC's Evidence block are appended
  // separately, in original order, by appendACWithImages below - a screenshot
  // requires an async download/upload round-trip, so it can't be built as a
  // block literal here alongside the text.
  return appendBlocks(pageId, blocks);
}

// Regression comments carry a "Scenario:" name; render it as a heading_2, the
// same visual weight as Summary / AC Outcomes / Evidence Log, with the
// scenario's overall status colour+bold. Individual ACs underneath still
// render as heading_3 blocks via appendEvidenceLogACBlock.
async function appendScenarioHeading(pageId, scenarioName, overallStatus) {
  return appendBlocks(pageId, [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [plainText(`Scenario: ${scenarioName} — `), outcomeText(overallStatus)],
      },
    },
  ]);
}

async function appendImageBlock(pageId, fileUploadId) {
  return appendBlocks(pageId, [
    {
      object: 'block',
      type: 'image',
      image: { type: 'file_upload', file_upload: { id: fileUploadId } },
    },
  ]);
}

async function postLinearComment(issueId, body) {
  const mutation = `
    mutation CreateComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `;
  return linearGraphQL(mutation, { issueId, body });
}

async function main() {
  assertEnv();
  console.log(`Syncing test evidence for ${ISSUE_IDENTIFIER}...`);

  const issue = await getIssueWithComments(ISSUE_IDENTIFIER);
  const isRelevant = (c) => !c.body.includes(AUTOMATION_SIGNATURE);
  const testOutputComments = issue.comments.nodes.filter((c) => c.body.includes(TEST_MARKER) && isRelevant(c));
  const regressionComments = issue.comments.nodes.filter((c) => c.body.includes(REGRESSION_MARKER) && isRelevant(c));

  if (testOutputComments.length === 0 && regressionComments.length === 0) {
    console.log(`No ${TEST_MARKER} or ${REGRESSION_MARKER} comment found on ${ISSUE_IDENTIFIER} - nothing to do.`);
    return;
  }

  // Ticket-level merge: latest comment per AC number wins.
  const mergedTicket = testOutputComments.length > 0 ? mergeSeries(testOutputComments) : null;

  // Regression merge: group by Scenario name (first-mention order), latest
  // comment per AC number wins within each scenario.
  const scenarioGroups = new Map(); // name -> comments[]
  for (const c of regressionComments) {
    const { firstIndex } = parseACBlocks(c.body);
    const h = parseHeaderFields(c.body, firstIndex);
    const name = h.scenario || 'Unnamed scenario';
    if (!scenarioGroups.has(name)) scenarioGroups.set(name, []);
    scenarioGroups.get(name).push(c);
  }
  const scenarios = Array.from(scenarioGroups.entries()).map(([name, comments]) => {
    const merged = mergeSeries(comments);
    return { name, header: merged.header, acs: merged.acs, latestContributing: merged.latestContributing };
  });
  for (const s of scenarios) {
    s.overallStatus = calcOverallStatus(s.acs);
  }

  if ((!mergedTicket || mergedTicket.acs.length === 0) && scenarios.every((s) => s.acs.length === 0)) {
    throw new Error(
      `Found a ${TEST_MARKER}/${REGRESSION_MARKER} comment on ${ISSUE_IDENTIFIER} but could not parse any AC blocks from it (expected "AC1: ...", "Outcome: ...", "Evidence: ...")`
    );
  }

  const finalStatus =
    testOutputComments.length > 0
      ? calcOverallStatus(mergedTicket.acs)
      : overallFromOutcomes(scenarios.map((s) => s.overallStatus));

  // Environment/Product/Iteration/Record for the Summary callout and Notion
  // properties: from the merged #test-output comments if any exist, else
  // from the merged #regression-test-output comments (across all scenarios).
  const globalRegressionMerge = regressionComments.length > 0 ? mergeSeries(regressionComments) : null;
  const topHeader = mergedTicket ? mergedTicket.header : globalRegressionMerge ? globalRegressionMerge.header : {};

  // The single comment to link from the "Linear comment" property and to use
  // for the Evidence Log's Date/Tester row: the latest comment that actually
  // contributed AC data, preferring #test-output.
  const latestRelevantComment =
    (mergedTicket && mergedTicket.latestContributing) ||
    (scenarios.length > 0
      ? scenarios.reduce((latest, s) =>
          !latest || (s.latestContributing && new Date(s.latestContributing.createdAt) > new Date(latest.createdAt))
            ? s.latestContributing
            : latest,
        null)
      : null);

  const acSummary =
    testOutputComments.length > 0
      ? mergedTicket.acs.map((ac) => `AC${ac.number} ${ac.outcome}`).join(', ')
      : scenarios.map((s) => `${s.name} — ${s.acs.map((ac) => `AC${ac.number} ${ac.outcome}`).join(', ')}`).join('; ');

  const testMarkerValue = [
    testOutputComments.length > 0 ? TEST_MARKER : null,
    regressionComments.length > 0 ? REGRESSION_MARKER : null,
  ]
    .filter(Boolean)
    .join(', ');

  const { pageId, url: pageUrl } = await findOrCreateNotionPage(issue);

  await updateNotionPageProperties(pageId, {
    title: `Test Evidence: ${issue.title}`,
    linearId: issue.identifier,
    linearTicketUrl: issue.url,
    testMarker: testMarkerValue,
    environment: topHeader.environment,
    product: topHeader.product,
    iteration: topHeader.iteration,
    record: topHeader.record,
    finalStatus,
    acSummary,
    linearCommentUrl: latestRelevantComment ? latestRelevantComment.url : null,
  });

  await clearPageBody(pageId);
  await appendSummaryCallout(pageId, issue, topHeader, finalStatus);

  if (mergedTicket) {
    await appendOutcomesTable(
      pageId,
      'AC Outcomes',
      mergedTicket.acs.map((ac) => ({ label: `AC${ac.number}`, description: ac.description, outcome: ac.outcome }))
    );
  } else {
    const rows = scenarios.flatMap((s) =>
      s.acs.map((ac) => ({ label: `${s.name} AC${ac.number}`, description: ac.description, outcome: ac.outcome }))
    );
    await appendOutcomesTable(pageId, 'AC Outcomes', rows);
  }

  // A tagged "Evidence (AC1, AC2): ..." marker can attach the same image URL
  // to more than one AC. Dedup uploads by source URL so we only download from
  // Linear and upload to Notion once per distinct image, reusing the same
  // file_upload id for every AC block that references it.
  const uploadCache = new Map(); // Linear url -> { filename, bytes, fileUploadId }
  const uploadResults = [];
  async function appendACWithImages(ac, header, isDev, filenamePrefix) {
    await appendEvidenceLogACBlock(pageId, ac, header, isDev);
    let i = 0;
    // Walk the Evidence block's segments in the order QA actually wrote them -
    // text and screenshots can be interleaved (e.g. "step 1 [img] step 2
    // [img]") and this renders that same sequence into Notion, rather than
    // dumping all the text first and all the screenshots after.
    for (const seg of ac.evidenceSegments) {
      if (seg.type === 'text') {
        await appendBlocks(pageId, [
          { object: 'block', type: 'paragraph', paragraph: { rich_text: [plainText(seg.text)] } },
        ]);
        continue;
      }
      const url = seg.url;
      let cached = uploadCache.get(url);
      if (!cached) {
        const filename = `${filenamePrefix}-AC${ac.number}-${i}.png`;
        const { buffer, contentType } = await downloadLinearAsset(url);
        const upload = await createFileUpload(filename, contentType);
        await sendFileUpload(upload.id, buffer, filename, contentType);
        cached = { filename, bytes: buffer.length, fileUploadId: upload.id };
        uploadCache.set(url, cached);
      }
      await appendImageBlock(pageId, cached.fileUploadId);
      uploadResults.push({ ac: ac.number, filename: cached.filename, bytes: cached.bytes, fileUploadId: cached.fileUploadId });
      i++;
    }
  }

  if (mergedTicket) {
    const evidenceComment = latestRelevantComment || mergedTicket.latestContributing;
    await appendEvidenceLogHeader(pageId, evidenceComment.createdAt, evidenceComment.user?.name);
    const isDevTicket = (mergedTicket.header.environment || '').trim().toUpperCase() === 'DEV';
    for (const ac of mergedTicket.acs) {
      await appendACWithImages(ac, mergedTicket.header, isDevTicket, `${issue.identifier}-ticket`);
    }
  }

  for (const s of scenarios) {
    await appendScenarioHeading(pageId, s.name, s.overallStatus);
    const isDevScenario = (s.header.environment || '').trim().toUpperCase() === 'DEV';
    for (const ac of s.acs) {
      await appendACWithImages(ac, s.header, isDevScenario, `${issue.identifier}-${s.name.replace(/\W+/g, '-')}`);
    }
  }

  const lines = [`Notion test evidence synced successfully: **${finalStatus}**.`];
  if (scenarios.length > 0) {
    lines.push('');
    for (const s of scenarios) lines.push(`- ${s.name} — ${s.overallStatus}`);
  }
  lines.push('', `[Test evidence page](${pageUrl})`);
  if (finalStatus !== 'Pass') {
    lines.push('', 'Please double-check that your test-output and/or regression-test-output comments were formatted correctly.');
  }
  lines.push('', `_(${AUTOMATION_SIGNATURE})_`);

  console.log(lines.join('\n'));
  console.log(`Images synced: ${uploadResults.length}`);
  for (const r of uploadResults) {
    console.log(`  - AC${r.ac}: ${r.filename} (${r.bytes} bytes) -> Notion file_upload ${r.fileUploadId}`);
  }

  await postLinearComment(issue.id, lines.join('\n'));
}

main().catch(async (err) => {
  console.error(err);
  try {
    if (LINEAR_API_KEY && ISSUE_IDENTIFIER) {
      const issue = await getIssueWithComments(ISSUE_IDENTIFIER).catch(() => null);
      if (issue) {
        await postLinearComment(
          issue.id,
          `Notion sync failed: ${err.message}\n\nPlease try again - if this keeps happening, check that your test-output and/or regression-test-output comment is formatted correctly.\n\n_(${AUTOMATION_SIGNATURE})_`
        );
      }
    }
  } catch (reportErr) {
    console.error('Additionally failed to report the error back to Linear:', reportErr);
  }
  process.exit(1);
});
