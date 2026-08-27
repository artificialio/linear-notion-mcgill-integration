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
          nodes { id url body createdAt }
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
 * Parse every "AC<n>: <description> / Outcome: <Pass|Fail> / Evidence: ..."
 * block out of a #test-output or #regression-test-output style comment body.
 * Each block runs from its "AC<n>:" header line up to (but not including) the
 * next "AC<n>:" header line, or the end of the comment - so evidence images
 * pasted anywhere within that span belong to that AC and stay in paste order,
 * however many there are.
 */
function parseACBlocks(body) {
  const acHeaderRe = /^AC(\d+):\s*(.*)$/gm;
  const starts = [];
  let m;
  while ((m = acHeaderRe.exec(body)) !== null) {
    starts.push({ index: m.index, number: m[1], description: m[2].trim() });
  }

  const acs = [];
  for (let i = 0; i < starts.length; i++) {
    const blockStart = starts[i].index;
    const blockEnd = i + 1 < starts.length ? starts[i + 1].index : body.length;
    const blockText = body.slice(blockStart, blockEnd);

    const outcomeMatch = blockText.match(/Outcome:\s*(Pass|Fail)/i);
    const evidenceMatch = blockText.match(/Evidence:\s*([\s\S]*)$/i);
    const evidenceRaw = evidenceMatch ? evidenceMatch[1] : blockText;

    acs.push({
      number: starts[i].number,
      description: starts[i].description,
      outcome: outcomeMatch ? outcomeMatch[1] : 'Not specified',
      evidenceText: evidenceRaw.replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim(),
      imageUrls: extractImageUrls(evidenceRaw),
    });
  }
  return { acs, firstIndex: starts.length ? starts[0].index : body.length };
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

async function appendRunHeading(pageId, issue, comment, header) {
  const metaLine = [
    header.scenario ? `Scenario: ${header.scenario}` : null,
    header.environment ? `Environment: ${header.environment}` : null,
    header.product ? `Product: ${header.product}` : null,
    header.iteration ? `Iteration/Sprint: ${header.iteration}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  return appendBlocks(pageId, [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [{ text: { content: 'Image Upload Experiment (GitHub Actions bridge)' } }],
      },
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            text: {
              content: `Synced from Linear comment ${comment.id} via the GitHub Actions bridge.${
                metaLine ? ` ${metaLine}` : ''
              }`,
            },
          },
        ],
      },
    },
  ]);
}

async function appendACSection(pageId, ac) {
  return appendBlocks(pageId, [
    {
      object: 'block',
      type: 'heading_3',
      heading_3: {
        rich_text: [{ text: { content: `AC${ac.number}: ${ac.description} — ${ac.outcome}` } }],
      },
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ text: { content: ac.evidenceText ? `Evidence: ${ac.evidenceText}` : 'Evidence:' } }],
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

  const totalImages = acs.reduce((n, ac) => n + ac.imageUrls.length, 0);
  if (totalImages === 0) {
    throw new Error(`Marked comment ${comment.id} has ${acs.length} AC block(s) but no embedded screenshots`);
  }

  const pageId = await findOrCreateNotionPage(issue);
  await appendRunHeading(pageId, issue, comment, header);

  const results = [];
  for (const ac of acs) {
    await appendACSection(pageId, ac);
    let i = 0;
    for (const url of ac.imageUrls) {
      const filename = `${issue.identifier}-${comment.id}-AC${ac.number}-${i}.png`;
      const { buffer, contentType } = await downloadLinearAsset(url);
      const upload = await createFileUpload(filename, contentType);
      await sendFileUpload(upload.id, buffer, filename, contentType);
      await appendImageBlock(pageId, upload.id);
      results.push({ ac: ac.number, filename, bytes: buffer.length, fileUploadId: upload.id });
      i++;
    }
  }

  const summary = [
    'Image sync succeeded via the GitHub Actions bridge (this bypasses the Loop entirely).',
    `Issue: ${issue.identifier} - comment ${comment.id}`,
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
