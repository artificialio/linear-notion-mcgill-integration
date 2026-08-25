#!/usr/bin/env node
/**
 * Sync a screenshot embedded in a Linear comment (marked with #img-upload-experiment)
 * into the "McGill Test Evidence" Notion database as a genuine embedded image.
 *
 * Why this script exists: Linear Loops can only call structured MCP connector actions,
 * not arbitrary HTTP requests. That blocks two things a real image sync needs:
 *   (a) an authenticated GET of the screenshot bytes from Linear's uploads.linear.app
 *   (b) the raw multipart POST that Notion's file-upload API requires
 * This script has a real HTTP client (Node's built-in fetch) and does both directly.
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
  const query = `
    query IssueComments($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        url
        comments {
          nodes {
            id
            body
            createdAt
          }
        }
      }
    }
  `;
  const data = await linearGraphQL(query, { id: identifier });
  if (!data.issue) throw new Error(`Linear issue "${identifier}" not found`);
  return data.issue;
}

function extractImageUrls(markdownBody) {
  // Linear embeds pasted screenshots as markdown image syntax pointing at
  // uploads.linear.app. Authenticated download only - see downloadLinearAsset.
  const urls = [];
  const re = /!\[[^\]]*\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(markdownBody)) !== null) {
    urls.push(m[1]);
  }
  return urls;
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

async function appendImageBlock(pageId, fileUploadId, caption) {
  return notionFetch(`/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      children: [
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
          paragraph: { rich_text: [{ text: { content: caption } }] },
        },
        {
          object: 'block',
          type: 'image',
          image: { type: 'file_upload', file_upload: { id: fileUploadId } },
        },
      ],
    }),
  });
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
  const markedComments = issue.comments.nodes.filter((c) => c.body.includes(MARKER));
  if (markedComments.length === 0) {
    throw new Error(`No comment containing ${MARKER} found on ${ISSUE_IDENTIFIER}`);
  }
  const comment = markedComments[markedComments.length - 1]; // most recent marked comment

  const imageUrls = extractImageUrls(comment.body);
  if (imageUrls.length === 0) {
    throw new Error(`Marked comment ${comment.id} contains no embedded image`);
  }

  const pageId = await findOrCreateNotionPage(issue);

  const results = [];
  for (const [i, url] of imageUrls.entries()) {
    const filename = `${issue.identifier}-${comment.id}-${i}.png`;
    const { buffer, contentType } = await downloadLinearAsset(url);
    const upload = await createFileUpload(filename, contentType);
    await sendFileUpload(upload.id, buffer, filename, contentType);
    await appendImageBlock(
      pageId,
      upload.id,
      `Synced from Linear comment ${comment.id} via the GitHub Actions bridge.`
    );
    results.push({ filename, bytes: buffer.length, fileUploadId: upload.id });
  }

  const summary = [
    'Image sync succeeded via the GitHub Actions bridge (this bypasses the Loop entirely).',
    `Issue: ${issue.identifier} - comment ${comment.id}`,
    `Images synced: ${results.length}`,
    ...results.map((r) => `  - ${r.filename} (${r.bytes} bytes) -> Notion file_upload ${r.fileUploadId}`),
    `Notion page id: ${pageId}`,
  ].join('\n');
  console.log(summary);

  await postLinearComment(issue.id, `${MARKER} diagnostic (GitHub Actions bridge)\n\n${summary}`);
}

main().catch(async (err) => {
  console.error(err);
  try {
    if (LINEAR_API_KEY) {
      const issue = await getIssueWithComments(ISSUE_IDENTIFIER).catch(() => null);
      if (issue) {
        await postLinearComment(
          issue.id,
          `${MARKER} diagnostic (GitHub Actions bridge)\n\nSync failed: ${err.message}`
        );
      }
    }
  } catch (reportErr) {
    console.error('Additionally failed to report the error back to Linear:', reportErr);
  }
  process.exit(1);
});
