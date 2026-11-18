// mcp.ts — the MCP adapter at /mcp: JSON-RPC 2.0 over streamable HTTP.
//
// Both protocol eras are served: the 2026-07-28 revision answers
// server/discover with its supported versions and needs no handshake;
// older revisions use initialize + notifications/initialized. The server
// is stateless — no session is issued and none is required. Tools are
// thin calls into the same core store REST and GraphQL use, so an object
// created here reads back identically there.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { Forge, ForgeError, type Repo } from './core.ts';
import { isRecord, readBody, sendJson, sendRaw } from './http.ts';
import { issueView, pullView, repoView } from './rest.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
}

/** The tool list: built once, so two tools/list answers are byte-identical. */
const TOOL_DEFS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed, or all.' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
  },
];

const TOOLS_LIST = {
  tools: TOOL_DEFS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: [] as string[] },
  })),
};

type RpcId = string | number | null;

interface RpcRequest {
  id?: RpcId;
  method: string;
  params: Record<string, unknown>;
}

function rpcResult(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: RpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** A tool result in the wire shape: text content plus structured content. */
function toolOk(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Read a string argument under any of its common spellings. */
function argString(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function requireRepo(forge: Forge, args: Record<string, unknown>): Repo {
  const owner = argString(args, 'owner', 'owner_login', 'org', 'user', 'login');
  const name = argString(args, 'repo', 'repository', 'repository_name', 'repo_name');
  if (name === '') throw new Error('a repo argument is required');
  const repo = forge.repoFor(owner === '' ? (forge.viewerLogin ?? '') : owner, name);
  if (repo === null) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

/** Execute one tool call against the core store. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name', 'repo', 'repository', 'repository_name');
      if (repoName === '') return toolError('a name argument is required');
      const repo = forge.createRepo({
        name: repoName,
        isPrivate: args.private === true,
        description: argString(args, 'description', 'about', 'summary'),
      });
      return toolOk(repoView(forge, repo));
    }
    case 'get_repo': {
      const repo = requireRepo(forge, args);
      return toolOk(repoView(forge, repo));
    }
    case 'create_issue': {
      const repo = requireRepo(forge, args);
      const title = argString(args, 'title', 'issue_title', 'subject');
      if (title === '') return toolError('a title argument is required');
      const issue = forge.createIssue(repo, { title, body: argString(args, 'body', 'issue_body', 'description', 'content') });
      return toolOk(issueView(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = requireRepo(forge, args);
      const state = argString(args, 'state', 'status') || 'open';
      const issues = forge.listIssues(repo, { state, direction: 'asc' });
      return toolOk({ issues: issues.map((issue) => issueView(forge, repo, issue)) });
    }
    case 'create_pull_request': {
      const repo = requireRepo(forge, args);
      const title = argString(args, 'title', 'pr_title', 'pull_request_title', 'subject');
      const head = argString(args, 'head', 'head_ref', 'head_branch', 'source', 'branch');
      const base = argString(args, 'base', 'base_ref', 'base_branch', 'target', 'into') || repo.defaultBranch;
      if (title === '' || head === '') return toolError('title and head arguments are required');
      const pull = forge.createPull(repo, {
        title,
        body: argString(args, 'body', 'description', 'content'),
        head,
        base,
      });
      return toolOk(pullView(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(forge, args);
      const raw = args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isInteger(number)) return toolError('a pull_number argument is required');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`pull request ${number} not found`);
      const result = forge.mergePull(repo, pull);
      return toolOk({ ...pullView(forge, repo, pull), sha: result.sha });
    }
    default:
      throw new UnknownTool(name);
  }
}

class UnknownTool extends Error {
  constructor(name: string) {
    super(`unknown tool ${name}`);
  }
}

/** Answer one JSON-RPC request object (null for notifications). */
function dispatch(forge: Forge, request: RpcRequest): Record<string, unknown> | null {
  const id = request.id ?? null;
  switch (request.method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof request.params.protocolVersion === 'string' ? request.params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST);
    case 'tools/call': {
      const name = typeof request.params.name === 'string' ? request.params.name : '';
      const args = isRecord(request.params.arguments) ? request.params.arguments : {};
      try {
        return rpcResult(id, callTool(forge, name, args));
      } catch (error) {
        if (error instanceof UnknownTool) return rpcError(id, -32602, error.message);
        if (error instanceof ForgeError) return rpcResult(id, toolError(error.message));
        return rpcResult(id, toolError(error instanceof Error ? error.message : String(error)));
      }
    }
    default:
      if (request.id === undefined) return null;
      return rpcError(id, -32601, `method not found: ${request.method}`);
  }
}

/** Handle one POST /mcp (authentication already enforced by the router). */
export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendRaw(res, 405, 'method not allowed', 'text/plain');
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed)) {
    const answers: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (!isRecord(entry) || typeof entry.method !== 'string') continue;
      const answer = dispatch(forge, { id: entry.id as RpcId, method: entry.method, params: isRecord(entry.params) ? entry.params : {} });
      if (answer !== null) answers.push(answer);
    }
    sendJson(res, 200, answers);
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const request: RpcRequest = {
    id: parsed.id as RpcId,
    method: parsed.method,
    params: isRecord(parsed.params) ? parsed.params : {},
  };
  if (request.id === undefined || parsed.method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }
  const answer = dispatch(forge, request);
  if (answer === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}
