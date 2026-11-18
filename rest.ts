// rest.ts — the REST v3 adapter: a thin translation layer between the wire
// contract under /api/v3 and the core store. Every answer is JSON, carries
// an X-GitHub-Request-Id, and error bodies always carry a string message.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { Forge, ForgeError, packCacheClear, type Issue, type Pull, type Repo } from './core.ts';
import { isRecord, nextRequestId, readJsonBody, sendJson, strField } from './http.ts';

/** Serialize a repository the way the REST surface presents it. */
export function repoView(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = forge.viewerLogin ?? 'forge';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: owner, id: forge.viewerId },
  };
}

/** Serialize an issue. */
export function issueView(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    comments: issue.comments.length,
    user: { login: forge.viewerLogin ?? 'forge', id: forge.viewerId },
    created_at: forge.isoOf(issue.seq),
    updated_at: forge.isoOf(issue.seq),
  };
}

/** Serialize a comment. */
export function commentView(forge: Forge, comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: forge.viewerLogin ?? 'forge', id: forge.viewerId },
    created_at: forge.isoOf(comment.seq),
    updated_at: forge.isoOf(comment.seq),
  };
}

/** Serialize a pull request; head/base shas resolve against current tips. */
export function pullView(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = forge.viewerLogin ?? 'forge';
  const headSha = forge.branchTip(repo, pull.headRef) ?? '';
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedSeq !== null ? forge.isoOf(pull.mergedSeq) : null,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: owner, id: forge.viewerId },
    created_at: forge.isoOf(pull.seq),
    updated_at: forge.isoOf(pull.mergedSeq ?? pull.seq),
  };
}

function notFound(): ForgeError {
  return new ForgeError(404, 'Not Found');
}

/** Parse an issue/pull number path segment. */
function numberOf(segment: string): number {
  const value = Number(segment);
  if (!Number.isInteger(value) || value < 1) throw notFound();
  return value;
}

/** Pagination parameters with the contract's defaults. */
function paging(url: URL): { perPage: number; page: number } {
  const perRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isInteger(perRaw) && perRaw > 0 ? Math.min(perRaw, 100) : 30;
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

/** Slice a list by page and build the Link header for rel="next". */
function paginate<T>(req: IncomingMessage, url: URL, items: T[]): { page: T[]; headers: Record<string, string> } {
  const { perPage, page } = paging(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const next = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    const lastPage = Math.ceil(items.length / perPage);
    const last = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) last.searchParams.set(key, value);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(lastPage));
    headers.link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { page: slice, headers };
}

/** Handle one REST request. `segments` is the path after /api/v3. */
export async function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  segments: string[],
): Promise<void> {
  const method = req.method ?? 'GET';

  // API root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') throw notFound();
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') throw notFound();
    sendJson(res, 200, { installed_version: '1.0.0', github_developer_program_url: '' });
    return;
  }

  // The token's own user.
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') throw notFound();
    sendJson(res, 200, { login: forge.viewerLogin ?? 'forge', id: forge.viewerId, type: 'User' });
    return;
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const { page, headers } = paginate(req, url, forge.viewerRepos());
      sendJson(res, 200, page.map((repo) => repoView(forge, repo)), headers);
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!isRecord(body)) throw new ForgeError(422, 'Repository creation failed: invalid body');
      const repo = forge.createRepo({
        name: strField(body, 'name'),
        isPrivate: body.private === true,
        description: strField(body, 'description'),
      });
      sendJson(res, 201, repoView(forge, repo));
      return;
    }
    throw notFound();
  }

  if (segments[0] !== 'repos' || segments.length < 3) throw notFound();
  const owner = segments[1] as string;
  const repoName = segments[2] as string;
  const repo = forge.repoFor(owner, repoName);
  if (repo === null) throw notFound();
  const rest = segments.slice(3);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoView(forge, repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      if (isRecord(body)) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        forge.tick();
      }
      sendJson(res, 200, repoView(forge, repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    throw notFound();
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = forge.branchNames(repo).map((name) => ({
        name,
        commit: { sha: forge.branchTip(repo, name) ?? '' },
      }));
      sendJson(res, 200, branches);
      return;
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const tip = forge.branchTip(repo, branch);
      if (tip === null) throw notFound();
      sendJson(res, 200, { name: branch, commit: { sha: tip } });
      return;
    }
    throw notFound();
  }

  // Git data refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const body = await readJsonBody(req);
      if (!isRecord(body)) throw new ForgeError(422, 'Invalid body');
      const ref = strField(body, 'ref');
      const sha = strField(body, 'sha');
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
        throw new ForgeError(422, `Invalid ref ${ref}`);
      }
      const target = forge.object(repo, sha);
      if (target === null) throw new ForgeError(422, `Invalid sha ${sha}`);
      if (repo.refs.has(ref)) throw new ForgeError(422, `Reference ${ref} already exists`);
      repo.refs.set(ref, sha);
      packCacheClear(repo);
      forge.tick();
      sendJson(res, 201, { ref, object: { sha, type: target.type } });
      return;
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) throw notFound();
      const target = forge.object(repo, sha);
      sendJson(res, 200, { ref, object: { sha, type: target?.type ?? 'commit' } });
      return;
    }
    throw notFound();
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = url.searchParams.get('sha');
    const commits = forge.listCommits(repo, ref);
    const { perPage } = paging(url);
    const limited = url.searchParams.has('per_page') ? commits.slice(0, perPage) : commits;
    sendJson(res, 200, limited.map(({ sha, info }) => ({
      sha,
      commit: {
        message: info.message,
        author: { name: info.authorName, email: info.authorEmail, date: new Date(info.authorUnix * 1000).toISOString() },
        committer: { name: info.committerName, email: info.committerEmail, date: new Date(info.committerUnix * 1000).toISOString() },
        tree: { sha: info.tree },
      },
      parents: info.parents.map((parent) => ({ sha: parent })),
    })));
    return;
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const found = forge.readContent(repo, path, url.searchParams.get('ref'));
      if (found === null) throw notFound();
      if (found.kind === 'file') {
        const name = path.split('/').pop() as string;
        sendJson(res, 200, {
          type: 'file',
          name,
          path,
          sha: found.oid,
          size: found.data.length,
          encoding: 'base64',
          content: found.data.toString('base64'),
        });
        return;
      }
      sendJson(res, 200, found.entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: found.prefix === '' ? entry.name : `${found.prefix}/${entry.name}`,
        sha: entry.oid,
      })));
      return;
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      if (!isRecord(body)) throw new ForgeError(422, 'Invalid body');
      const data = Buffer.from(strField(body, 'content').replace(/\s+/g, ''), 'base64');
      const result = forge.putContent(repo, {
        path,
        data,
        message: strField(body, 'message', 'Update file'),
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      const name = path.split('/').pop() as string;
      sendJson(res, result.created ? 201 : 200, {
        content: { name, path, sha: result.blobOid, size: data.length, encoding: 'base64' },
        commit: { sha: result.commitOid },
      });
      return;
    }
    if (method === 'DELETE') {
      const body = await readJsonBody(req);
      if (!isRecord(body)) throw new ForgeError(422, 'Invalid body');
      const result = forge.deleteContent(repo, {
        path,
        message: strField(body, 'message', 'Delete file'),
        sha: typeof body.sha === 'string' ? body.sha : undefined,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
      });
      sendJson(res, 200, { content: null, commit: { sha: result.commitOid } });
      return;
    }
    throw notFound();
  }

  // Labels.
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!isRecord(body)) throw new ForgeError(422, 'Invalid body');
      const label = forge.createLabel(repo, { name: strField(body, 'name'), color: strField(body, 'color', '000000') });
      sendJson(res, 201, { name: label.name, color: label.color });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      return;
    }
    throw notFound();
  }

  // Issues and their comments.
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!isRecord(body)) throw new ForgeError(422, 'Invalid body');
        const labels = Array.isArray(body.labels)
          ? body.labels.filter((l): l is string => typeof l === 'string')
          : undefined;
        const issue = forge.createIssue(repo, {
          title: strField(body, 'title'),
          body: strField(body, 'body'),
          labels,
        });
        sendJson(res, 201, issueView(forge, repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'asc';
        const issues = forge.listIssues(repo, { state, direction });
        const { page, headers } = paginate(req, url, issues);
        sendJson(res, 200, page.map((issue) => issueView(forge, repo, issue)), headers);
        return;
      }
      throw notFound();
    }
    const number = numberOf(rest[1] as string);
    const issue = repo.issues.get(number);
    if (issue === undefined) throw notFound();
    if (rest.length === 2) {
      if (method === 'GET') {
        sendJson(res, 200, issueView(forge, repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        if (isRecord(body)) {
          if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          forge.tick();
        }
        sendJson(res, 200, issueView(forge, repo, issue));
        return;
      }
      throw notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!isRecord(body)) throw new ForgeError(422, 'Invalid body');
        const comment = forge.addComment(repo, issue, strField(body, 'body'));
        sendJson(res, 201, commentView(forge, comment));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => commentView(forge, comment)));
        return;
      }
      throw notFound();
    }
    throw notFound();
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!isRecord(body)) throw new ForgeError(422, 'Invalid body');
        const pull = forge.createPull(repo, {
          title: strField(body, 'title'),
          body: strField(body, 'body'),
          head: strField(body, 'head'),
          base: strField(body, 'base', repo.defaultBranch),
        });
        sendJson(res, 201, pullView(forge, repo, pull));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const pulls = forge.listPulls(repo, state);
        const { page, headers } = paginate(req, url, pulls);
        sendJson(res, 200, page.map((pull) => pullView(forge, repo, pull)), headers);
        return;
      }
      throw notFound();
    }
    const number = numberOf(rest[1] as string);
    const pull = repo.pulls.get(number);
    if (pull === undefined) throw notFound();
    if (rest.length === 2 && method === 'GET') {
      sendJson(res, 200, pullView(forge, repo, pull));
      return;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      sendJson(res, 200, forge.pullFiles(repo, pull));
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      await readJsonBody(req).catch(() => ({}));
      const result = forge.mergePull(repo, pull);
      sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    throw notFound();
  }

  throw notFound();
}
