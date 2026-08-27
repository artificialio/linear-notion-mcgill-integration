#!/usr/bin/env node
/**
 * Sync screenshots embedded in a Linear comment (marked with #img-upload-experiment)
 * into the "McGill Test Evidence" Notion database as genuine embedded images,
 * grouped under the AC block they were pasted as evidence for.
 *
 * Why this script exists: Linear Loops can only call structured MCP connector actions,
 * not arbitrary HTTP requests. That blocks two things a real image sync needs:
 *   (a) an authenticated GET of the screenshot bytes from Linear's uploads.linear.app
 *   (b) the raw multipart POST that Notion's upload flow requires
 * This script has a real HTTP client (Node's built-in fetch) and does both directly.
 *
 * Page formatting mirrors Elizabeth's reformatted example doc ("Test Evidence Doc
 * example" in Notion), compared against the production Loop's older plain-text
 * template:
 *   - Summary is a callout block (Ticket / Overall status / Environment / Product
 *     / Iteration/Sprint), with Overall status in colour+bold.
 *   - AC Outcomes table has only AC # / Description / Outcome columns (no Evidence
 *     column) - Outcome is colour+bold: green=Pass, red=Fail, yellow=Partial.
 *   - Evidence Log has a Date / Tester name table, then one block per AC with bold
 *     "Outcome:", bold "Record:" (omitted entirely when Environment is DEV - the
 *     QA team reading this doc has no DEV access), a bold "Evidence" subheading,
 *     and a divider between each AC's block.
 *   - Anywhere Pass/Fail/Partial appears as a test outcome, it gets the same
 *     colour+bold treatment.
 *   - Evidence and Record can each optionally be tagged with the AC number(s)
 *     they apply to, e.g. "Evidence (AC1, AC2): ..." or "Record (AC2, AC3): ...",
 *     so one screenshot/link can cover multiple ACs at once. An AC-level Record
 *     overrides the top-level Record for that AC only (DEV suppression applies
 *     at both levels). A "Scenario:" header field (regression-style comments)
 *     renders its own heading above the AC blocks, same weight as Summary / AC
 *     Outcomes / Evidence Log.
 *
 * NOTE on table/column width: the Notion public API does not expose column widths
 * or the page "full width" toggle - those are client-only settings with no API
 * surface, so the "wider, A4-like tables with a wide Description column" request
 * can't be automated here. That still needs a one-time manual drag in Notion.
 *
 * Comment format this parses (mirrors the real "Sync MCG test evidence to Notion"
 * production Loop's #test-output / #regression-test-output template):
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
 * Each AC's evidence images are scoped to the text between that AC's header line
 * and the next AC header (or end of comment), so images stay associated with the
 * correct AC and stay in paste order - a comment can have any number of ACs, and
 * any number of images per AC (tested with 10-20+ in mind).
 *
 * Required environment variables (set as GitHub Actions repo secrets):
 *   LINEAR_API_KEY      - Linear personal API key, read (and comment) access
 *   NOTION_TOKEN         - Notion internal integration token, shared with the
 *                          "McGill Test Evidence" database
 *   NOTION_DATABASE_ID   - the database's id (from its URL)
 *   ISSUE_IDENTIFIER     - e.g. "MCG-147" (passed as a workflow_dispatch input)
 */

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const ISSUE_IDENTIFIER = process.env.ISSUE_IDENTIFIER || 'MCG-147';
const MARKER = '#img-upload-experiment';
// Our own follow-up comments (posted by this script) also contain MARKER as
// substring text ("#img-upload-experiment diagnostic (GitHub Actions bridge)"),
// which would otherwise make them look like the "most recent marked comment" on
// every subsequent run. Exclude anything carrying this diagnostic-reply marker.
const DIAGNOSTIC_MARKER = 'diagnostic (GitHub Actions bridge)';

const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';
const LINEAR_API = 'https://api.linear.app/graphql';

// Outcome -> Notion rich_text colour annotation. Applied everywhere an outcome
// word is rendered: the Summary callout's Overall status, the AC Outcomes table,
// and each AC's Outcome line in the Evidence Log.
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
  // history that silently hides every comment added after that cutoff -
  // including the very comment we're supposed to sync. Page through the full
  // connection explicitly so we always see the truly most recent comments.
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
  // creation-ascending across pagination) - sort explicitly so "most recent
  // marked comment" picks are actually correct regardless of API ordering.
  allComments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return { ...issueMeta, comments: { nodes: allComments } };
}

function extractImageUrls(text) {
  // Linear embeds pasted screenshots as markdown image syntax pointing at
  // uploads.linear.app. Authenticated download only - see downloadLinearAsset.
  const urls = [];
  const re = /!\[[^\]]*\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    urls.push(m[1]);
  }
  return urls;
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
    record: get('Record'),
  };
}

/**
 * Parse every "AC<n>: <description> / Outcome: <Pass|Fail|Partial> / Evidence: ..."
 * block out of a #test-output or #regression-test-output style comment body.
 *
 * Outcome stays scoped strictly to each AC's own "AC<n>:" header line up to the
 * next "AC<n>:" header (or end of comment) - same as before.
 *
 * Evidence and Record are now parsed as standalone markers that can each
 * optionally be tagged with the AC number(s) they apply to, e.g.:
 *   Evidence (AC1, AC2): <text/screenshots shared by both ACs>
 *   Record (AC2, AC3): <link shown for AC2 and AC3 only, overriding the
 *                        top-level Record for those two ACs>
 * An untagged "Evidence:" / "Record:" marker (no parens) applies to whichever
 * AC header most recently precedes it, exactly as before. A marker's content
 * runs up to the next AC header or the next marker, whichever comes first, so
 * a tagged marker can sit after the last AC header it covers.
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
      evidenceText: '',
      imageUrls: [],
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
      if (!data) continue; // marker tags an AC number that doesn't exist - ignore
      if (marker.kind === 'evidence') {
        const text = content.replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim();
        if (text) data.evidenceText = data.evidenceText ? `${data.evidenceText}\n\n${text}` : text;
        data.imageUrls = data.imageUrls.concat(extractImageUrls(content));
      } else if (marker.kind === 'record') {
        const link = content.split('\n')[0].trim();
        if (link) data.record = link;
      }
    }
  }

  // Backward compatibility: an AC with no Evidence marker at all (old-style
  // comments, or a stray block) falls back to treating its whole header-to-
  // next-header span as evidence, same as the original behaviour.
  for (const data of acData.values()) {
    if (!data.evidenceText && data.imageUrls.length === 0) {
      data.evidenceText = data._blockText.replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim();
      data.imageUrls = extractImageUrls(data._blockText);
    }
    delete data._blockText;
  }

  const acs = acHeaders.map((h) => acData.get(h.number));
  return { acs, firstIndex: acHeaders[0].index };
}

/**
 * Overall ticket status from the set of AC outcomes, same rule the production
 * Loop uses: Pass only if every AC is Pass, Fail only if every tested AC is
 * Fail, Partial if it's a mix, Not tested if nothing was parsed as Pass/Fail.
 */
function calcOverallStatus(acs) {
  const tested = acs.filter((ac) => ac.outcome === 'Pass' || ac.outcome === 'Fail' || ac.outcome === 'Partial');
  if (tested.length === 0) return 'Not tested';
  if (tested.every((ac) => ac.outcome === 'Pass')) return 'Pass';
  if (tested.every((ac) => ac.outcome === 'Fail')) return 'Fail';
  return 'Partial';
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// --- Small rich_text builders, so every outcome word gets the same treatment
// wherever it appears (Summary callout, AC Outcomes table, Evidence Log). ---

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
    return query.results[0].id;
  }

  const created = await notionFetch('/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Title: { title: [{ text: { content: `Image Upload Experiment: ${issue.title}` } }] },
        'Linear ID': { rich_text: [{ text: { content: issue.identifier } }] },
        'Linear ticket': { url: issue.url },
        'Test marker': { rich_text: [{ text: { content: MARKER } }] },
        'Last synced': { date: { start: new Date().toISOString() } },
      },
    }),
  });
  return created.id;
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

async function appendACOutcomesTable(pageId, acs) {
  const headerRow = {
    object: 'block',
    type: 'table_row',
    table_row: {
      cells: [[plainText('AC #')], [plainText('Description')], [plainText('Outcome')]],
    },
  };
  const rows = acs.map((ac) => ({
    object: 'block',
    type: 'table_row',
    table_row: {
      cells: [
        [plainText(`AC${ac.number}`)],
        [plainText(ac.description)],
        [outcomeText(ac.outcome)],
      ],
    },
  }));

  return appendBlocks(pageId, [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [plainText('AC Outcomes')] },
    },
    {
      object: 'block',
      type: 'table',
      table: {
        table_width: 3,
        has_column_header: true,
        has_row_header: false,
        children: [headerRow, ...rows],
      },
    },
  ]);
}

async function appendEvidenceLogHeader(pageId, comment) {
  const headerRow = {
    object: 'block',
    type: 'table_row',
    table_row: { cells: [[plainText('Date')], [plainText('Tester name')]] },
  };
  const dataRow = {
    object: 'block',
    type: 'table_row',
    table_row: {
      cells: [
        [plainText(formatDate(comment.createdAt))],
        [plainText(comment.user?.name || 'Unknown')],
      ],
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

  if (ac.evidenceText) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [plainText(ac.evidenceText)] },
    });
  }

  return appendBlocks(pageId, blocks);
}

// Regression comments (#regression-test-output) carry a "Scenario:" header
// field; render it as a heading_2, the same visual weight as Summary / AC
// Outcomes / Evidence Log, with the scenario's overall status colour+bold
// just like every other outcome word. Individual ACs underneath still render
// as heading_3 blocks via appendEvidenceLogACBlock, unchanged.
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
  console.log(`Syncing image for ${ISSUE_IDENTIFIER}...`);

  const issue = await getIssueWithComments(ISSUE_IDENTIFIER);
  const markedComments = issue.comments.nodes.filter(
    (c) => c.body.includes(MARKER) && !c.body.includes(DIAGNOSTIC_MARKER)
  );
  if (markedComments.length === 0) {
    throw new Error(`No comment containing ${MARKER} found on ${ISSUE_IDENTIFIER}`);
  }
  const comment = markedComments[markedComments.length - 1]; // most recent marked comment

  const { acs, firstIndex } = parseACBlocks(comment.body);
  if (acs.length === 0) {
    throw new Error(`Marked comment ${comment.id} contains no AC blocks (expected "AC1: ...", "Outcome: ...", "Evidence: ...")`);
  }
  const header = parseHeaderFields(comment.body, firstIndex);
  const isDev = (header.environment || '').trim().toUpperCase() === 'DEV';

  const totalImages = acs.reduce((n, ac) => n + ac.imageUrls.length, 0);
  if (totalImages === 0) {
    throw new Error(`Marked comment ${comment.id} has ${acs.length} AC block(s) but no embedded screenshots`);
  }

  const overallStatus = calcOverallStatus(acs);
  const pageId = await findOrCreateNotionPage(issue);

  await appendSummaryCallout(pageId, issue, header, overallStatus);
  await appendACOutcomesTable(pageId, acs);
  await appendEvidenceLogHeader(pageId, comment);

  // Regression-style comments set a Scenario field - give it its own heading,
  // same weight as Summary / AC Outcomes / Evidence Log, before the AC blocks.
  if (header.scenario) {
    await appendScenarioHeading(pageId, header.scenario, overallStatus);
  }

  // A tagged "Evidence (AC1, AC2): ..." marker can attach the same image URL
  // to more than one AC. Dedup uploads by source URL so we only download from
  // Linear and upload to Notion once per distinct image, reusing the same
  // file_upload id for every AC block that references it.
  const uploadCache = new Map(); // Linear url -> { filename, bytes, fileUploadId }
  const results = [];
  for (const ac of acs) {
    await appendEvidenceLogACBlock(pageId, ac, header, isDev);
    let i = 0;
    for (const url of ac.imageUrls) {
      let cached = uploadCache.get(url);
      if (!cached) {
        const filename = `${issue.identifier}-${comment.id}-AC${ac.number}-${i}.png`;
        const { buffer, contentType } = await downloadLinearAsset(url);
        const upload = await createFileUpload(filename, contentType);
        await sendFileUpload(upload.id, buffer, filename, contentType);
        cached = { filename, bytes: buffer.length, fileUploadId: upload.id };
        uploadCache.set(url, cached);
      }
      await appendImageBlock(pageId, cached.fileUploadId);
      results.push({ ac: ac.number, filename: cached.filename, bytes: cached.bytes, fileUploadId: cached.fileUploadId });
      i++;
    }
  }

  const summary = [
    'Image sync succeeded via the GitHub Actions bridge (this bypasses the Loop entirely).',
    `Issue: ${issue.identifier} - comment ${comment.id}`,
    `Overall status: ${overallStatus}`,
    `AC blocks parsed: ${acs.length}`,
    `Images synced: ${results.length}`,
    ...acs.map((ac) => `  - AC${ac.number} (${ac.outcome}): ${ac.imageUrls.length} image(s)`),
    ...results.map((r) => `    - ${r.filename} (${r.bytes} bytes) -> Notion file_upload ${r.fileUploadId}`),
    `Notion page id: ${pageId}`,
  ].join('\n');
  console.log(summary);

  await postLinearComment(issue.id, `${MARKER} ${DIAGNOSTIC_MARKER}\n\n${summary}`);
}

main().catch(async (err) => {
  console.error(err);
  try {
    if (LINEAR_API_KEY) {
      const issue = await getIssueWithComments(ISSUE_IDENTIFIER).catch(() => null);
      if (issue) {
        await postLinearComment(
          issue.id,
          `${MARKER} ${DIAGNOSTIC_MARKER}\n\nSync failed: ${err.message}`
        );
      }
    }
  } catch (reportErr) {
    console.error('Additionally failed to report the error back to Linear:', reportErr);
  }
  process.exit(1);
});
