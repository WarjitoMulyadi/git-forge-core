// graphql.ts — the GraphQL v4 adapter: a small hand-written parser,
// validator and executor for exactly the document shapes gh and
// github-mcp-server send, executed against the core store so GraphQL,
// REST, MCP and git all read the same objects.
//
// Global ids are opaque base64 encodings of typed keys (never the bare
// database id or number), stable across reads. Unknown fields answer
// HTTP 200 with an errors array naming the field; an unknown repository
// is data.repository = null with no errors.

import { Forge, ForgeError, type Issue, type Pull, type Repo } from './core.ts';

// ---------------------------------------------------------------- tokenizer

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expect(kind: Token['kind'], value?: string): Token {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? kind}, got ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token ${token.value}`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) this.skipParens();
        this.skipDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        this.expect('name', 'on');
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unbalanced parentheses');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    } while (depth > 0);
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expect('name');
      if (this.atPunct('(')) this.skipParens();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('punct', '{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expect('name').value;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.expect('name').value });
        }
        continue;
      }
      const first = this.expect('name').value;
      let alias: string | null = null;
      let name = first;
      if (this.atPunct(':')) {
        this.next();
        alias = first;
        name = this.expect('name').value;
      }
      const args = new Map<string, Value>();
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          const argName = this.expect('name').value;
          this.expect('punct', ':');
          args.set(argName, this.parseValue());
        }
        this.next();
      }
      this.skipDirectives();
      const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.next();
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expect('name').value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.atPunct('}')) {
        const key = this.expect('name').value;
        this.expect('punct', ':');
        fields.set(key, this.parseValue());
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

/** Evaluate a Value AST against the operation's variables. */
function valueOf(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = valueOf(entry, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- global ids

function encodeId(...parts: Array<string | number>): string {
  return Buffer.from(parts.join(':'), 'utf8').toString('base64');
}

function decodeId(id: string): string[] {
  try {
    return Buffer.from(id, 'base64').toString('utf8').split(':');
  } catch {
    return [];
  }
}

const repoGlobalId = (repo: Repo): string => encodeId('Repository', repo.id);
const issueGlobalId = (repo: Repo, issue: Issue): string => encodeId('Issue', repo.id, issue.number);
const pullGlobalId = (repo: Repo, pull: Pull): string => encodeId('PullRequest', repo.id, pull.number);
const commentGlobalId = (repo: Repo, issue: Issue, commentId: number): string =>
  encodeId('IssueComment', repo.id, issue.number, commentId);

// ---------------------------------------------------------------- schema

type Source = Record<string, unknown> & { __typename: string };
type Args = Record<string, unknown>;
interface FieldDef {
  type: string;
  resolve?: (forge: Forge, source: Source, args: Args) => unknown;
}

const scalar = (type: string): FieldDef => ({ type });

function userSource(forge: Forge): Source {
  const login = forge.viewerLogin ?? 'forge';
  return { __typename: 'User', id: encodeId('User', login), login, name: login };
}

function repoSource(repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: Repo, issue: Issue): Source {
  return {
    __typename: 'Issue',
    repo,
    issue,
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
  };
}

function pullSource(forge: Forge, repo: Repo, pull: Pull): Source {
  return {
    __typename: 'PullRequest',
    repo,
    pull,
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeableState: forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
  };
}

/** Cursor for the node at a list index (opaque, deterministic). */
const cursorOf = (index: number): string => Buffer.from(`cursor:${index}`, 'utf8').toString('base64');

function indexOfCursor(after: unknown): number {
  if (typeof after !== 'string') return -1;
  const match = /^cursor:(\d+)$/.exec(Buffer.from(after, 'base64').toString('utf8'));
  return match === null ? -1 : Number(match[1]);
}

/** Slice a list into a connection page. */
function connection<T>(
  typename: string,
  items: T[],
  args: Args,
  toSource: (item: T) => Source,
): Source {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const start = indexOfCursor(args.after) + 1;
  const page = items.slice(start, start + first);
  const nodes = page.map(toSource);
  return {
    __typename: typename,
    nodes,
    totalCount: items.length,
    edges: page.map((item, i) => ({
      __typename: `${typename.replace('Connection', '')}Edge`,
      node: toSource(item),
      cursor: cursorOf(start + i),
    })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorOf(start) : null,
      endCursor: page.length > 0 ? cursorOf(start + page.length - 1) : null,
    },
  };
}

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User', resolve: (forge) => userSource(forge) },
    repository: {
      type: 'Repository',
      resolve: (forge, _source, args) => {
        const repo = forge.repoFor(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : repoSource(repo);
      },
    },
    node: {
      type: 'Node',
      resolve: (forge, _source, args) => nodeById(forge, String(args.id ?? '')),
    },
    __type: {
      type: '__Type',
      resolve: (_forge, _source, args) => typeSource(String(args.name ?? '')),
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (forge, _source, args) => {
        const input = (args.input ?? {}) as Args;
        const repo = repoByGlobalId(forge, String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('repository not found');
        const issue = forge.createIssue(repo, {
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
        });
        return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue) };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (forge, _source, args) => {
        const input = (args.input ?? {}) as Args;
        const found = issueByGlobalId(forge, String(input.issueId ?? ''));
        if (found === null) throw new Error('issue not found');
        found.issue.state = 'closed';
        forge.tick();
        return { __typename: 'CloseIssuePayload', issue: issueSource(found.repo, found.issue) };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (forge, _source, args) => {
        const input = (args.input ?? {}) as Args;
        const repo = repoByGlobalId(forge, String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('repository not found');
        const pull = forge.createPull(repo, {
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
        });
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(forge, repo, pull) };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (forge, _source, args) => {
        const input = (args.input ?? {}) as Args;
        const found = pullByGlobalId(forge, String(input.pullRequestId ?? ''));
        if (found === null) throw new Error('pull request not found');
        forge.mergePull(found.repo, found.pull);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(forge, found.repo, found.pull) };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (forge, _source, args) => {
        const input = (args.input ?? {}) as Args;
        const found = issueByGlobalId(forge, String(input.subjectId ?? ''));
        if (found === null) throw new Error('subject not found');
        const comment = forge.addComment(found.repo, found.issue, String(input.body ?? ''));
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: {
              __typename: 'IssueComment',
              id: commentGlobalId(found.repo, found.issue, comment.id),
              body: comment.body,
            },
          },
        };
      },
    },
  },
  User: {
    id: scalar('ID'),
    login: scalar('String'),
    name: scalar('String'),
  },
  Repository: {
    id: { type: 'ID', resolve: (_f, s) => repoGlobalId(s.repo as Repo) },
    databaseId: { type: 'Int', resolve: (_f, s) => (s.repo as Repo).id },
    name: { type: 'String', resolve: (_f, s) => (s.repo as Repo).name },
    nameWithOwner: {
      type: 'String',
      resolve: (forge, s) => `${forge.viewerLogin ?? 'forge'}/${(s.repo as Repo).name}`,
    },
    owner: { type: 'User', resolve: (forge) => userSource(forge) },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (_f, s) => ({ __typename: 'Ref', name: (s.repo as Repo).defaultBranch }),
    },
    viewerPermission: scalar('String'),
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    isPrivate: { type: 'Boolean', resolve: (_f, s) => (s.repo as Repo).isPrivate },
    description: { type: 'String', resolve: (_f, s) => (s.repo as Repo).description },
    issue: {
      type: 'Issue',
      resolve: (_f, s, args) => {
        const repo = s.repo as Repo;
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : issueSource(repo, issue);
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (_f, s, args) => {
        const repo = s.repo as Repo;
        let issues = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states !== null) {
          const wanted = new Set(states.map((state) => state.toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = (args.orderBy ?? null) as { direction?: string } | null;
        issues.sort((a, b) => a.number - b.number);
        if (orderBy !== null && orderBy.direction === 'DESC') issues.reverse();
        return connection('IssueConnection', issues, args, (issue) => issueSource(repo, issue));
      },
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (forge, s, args) => {
        const repo = s.repo as Repo;
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : pullSource(forge, repo, pull);
      },
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (forge, s, args) => {
        const repo = s.repo as Repo;
        const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
        return connection('PullRequestConnection', pulls, args, (pull) => pullSource(forge, repo, pull));
      },
    },
  },
  Issue: {
    id: scalar('ID'),
    number: scalar('Int'),
    title: scalar('String'),
    state: scalar('String'),
    body: scalar('String'),
  },
  PullRequest: {
    id: scalar('ID'),
    number: scalar('Int'),
    title: scalar('String'),
    body: scalar('String'),
    state: scalar('String'),
    merged: scalar('Boolean'),
    headRefName: scalar('String'),
    baseRefName: scalar('String'),
    mergeable: { type: 'String', resolve: (_f, s) => s.mergeableState },
    files: {
      type: 'PullRequestFileConnection',
      resolve: (forge, s, args) => {
        const repo = s.repo as Repo;
        const pull = s.pull as Pull;
        const files = forge.pullFiles(repo, pull).map((file) => ({
          __typename: 'PullRequestFile',
          path: file.filename,
        }));
        return connection('PullRequestFileConnection', files, args, (file) => file);
      },
    },
  },
  PullRequestFile: { path: scalar('String') },
  Ref: { name: scalar('String') },
  Node: { id: scalar('ID') },
  IssueConnection: {
    nodes: { type: '[Issue]' },
    edges: { type: '[IssueEdge]' },
    pageInfo: { type: 'PageInfo' },
    totalCount: scalar('Int'),
  },
  IssueEdge: { node: { type: 'Issue' }, cursor: scalar('String') },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]' },
    edges: { type: '[PullRequestEdge]' },
    pageInfo: { type: 'PageInfo' },
    totalCount: scalar('Int'),
  },
  PullRequestEdge: { node: { type: 'PullRequest' }, cursor: scalar('String') },
  PullRequestFileConnection: {
    nodes: { type: '[PullRequestFile]' },
    edges: { type: '[PullRequestFileEdge]' },
    pageInfo: { type: 'PageInfo' },
    totalCount: scalar('Int'),
  },
  PullRequestFileEdge: { node: { type: 'PullRequestFile' }, cursor: scalar('String') },
  PageInfo: {
    hasNextPage: scalar('Boolean'),
    hasPreviousPage: scalar('Boolean'),
    startCursor: scalar('String'),
    endCursor: scalar('String'),
  },
  CreateIssuePayload: { issue: { type: 'Issue' } },
  CloseIssuePayload: { issue: { type: 'Issue' } },
  CreatePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  MergePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  AddCommentPayload: { commentEdge: { type: 'IssueCommentEdge' } },
  IssueCommentEdge: { node: { type: 'IssueComment' } },
  IssueComment: { id: scalar('ID'), body: scalar('String') },
  __Type: {
    name: scalar('String'),
    kind: scalar('String'),
    fields: { type: '[__Field]' },
    enumValues: { type: '[__EnumValue]' },
  },
  __Field: { name: scalar('String') },
  __EnumValue: { name: scalar('String') },
};

// viewerPermission is a constant of the token's own repositories.
SCHEMA.Repository.viewerPermission = { type: 'String', resolve: () => 'ADMIN' };

/** Introspection data: the field and enum surface the probes read. */
const TYPE_INFO: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'author', 'repository', 'comments', 'labels', 'createdAt', 'updatedAt', 'url'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'repository', 'commits', 'additions', 'deletions', 'changedFiles', 'createdAt', 'mergedAt', 'url'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'description', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'url'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
};

function typeSource(name: string): Source | null {
  const info = TYPE_INFO[name];
  if (info === undefined) {
    const fields = SCHEMA[name];
    if (fields === undefined) return null;
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      fields: Object.keys(fields).map((field) => ({ __typename: '__Field', name: field })),
      enumValues: null,
    };
  }
  return {
    __typename: '__Type',
    name,
    kind: info.kind,
    fields: info.fields?.map((field) => ({ __typename: '__Field', name: field })) ?? null,
    enumValues: info.enumValues?.map((value) => ({ __typename: '__EnumValue', name: value })) ?? null,
  };
}

function repoByGlobalId(forge: Forge, id: string): Repo | null {
  const parts = decodeId(id);
  if (parts[0] !== 'Repository') return null;
  const dbId = Number(parts[1]);
  return forge.viewerRepos().find((repo) => repo.id === dbId) ?? null;
}

function issueByGlobalId(forge: Forge, id: string): { repo: Repo; issue: Issue } | null {
  const parts = decodeId(id);
  if (parts[0] !== 'Issue') return null;
  const repo = forge.viewerRepos().find((r) => r.id === Number(parts[1]));
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(parts[2]));
  return issue === undefined ? null : { repo, issue };
}

function pullByGlobalId(forge: Forge, id: string): { repo: Repo; pull: Pull } | null {
  const parts = decodeId(id);
  if (parts[0] !== 'PullRequest') return null;
  const repo = forge.viewerRepos().find((r) => r.id === Number(parts[1]));
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number(parts[2]));
  return pull === undefined ? null : { repo, pull };
}

function nodeById(forge: Forge, id: string): Source | null {
  const parts = decodeId(id);
  if (parts[0] === 'Repository') {
    const repo = repoByGlobalId(forge, id);
    return repo === null ? null : { ...repoSource(repo), id: repoGlobalId(repo) };
  }
  if (parts[0] === 'Issue') {
    const found = issueByGlobalId(forge, id);
    return found === null ? null : issueSource(found.repo, found.issue);
  }
  if (parts[0] === 'PullRequest') {
    const found = pullByGlobalId(forge, id);
    return found === null ? null : pullSource(forge, found.repo, found.pull);
  }
  if (parts[0] === 'User') {
    return userSource(forge);
  }
  return null;
}

// ---------------------------------------------------------------- validation

function unwrap(type: string): string {
  return type.replace(/[[\]!]/g, '');
}

/** Validate a selection set against the schema, collecting field errors. */
function validate(
  doc: Document,
  selections: SelectionNode[],
  typeName: string,
  errors: string[],
): void {
  const fields = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      const def = fields?.[selection.name];
      if (def === undefined) {
        errors.push(`Field '${selection.name}' doesn't exist on type '${typeName}'`);
        continue;
      }
      if (selection.selectionSet !== null) {
        validate(doc, selection.selectionSet, unwrap(def.type), errors);
      }
      continue;
    }
    if (selection.kind === 'inline') {
      validate(doc, selection.selectionSet, selection.typeCondition ?? typeName, errors);
      continue;
    }
    const fragment = doc.fragments.get(selection.name);
    if (fragment !== undefined) validate(doc, fragment.selectionSet, fragment.typeCondition, errors);
  }
}

// ---------------------------------------------------------------- execution

interface Ctx {
  forge: Forge;
  doc: Document;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

/** Expand fragments and merge fields by response key for one object. */
function collectFields(
  ctx: Ctx,
  selections: SelectionNode[],
  typeName: string,
): Map<string, FieldNode> {
  const out = new Map<string, FieldNode>();
  const visit = (nodes: SelectionNode[], currentType: string): void => {
    for (const node of nodes) {
      if (node.kind === 'field') {
        const key = node.alias ?? node.name;
        const existing = out.get(key);
        if (existing === undefined) {
          out.set(key, { ...node, selectionSet: node.selectionSet === null ? null : [...node.selectionSet] });
        } else if (node.selectionSet !== null) {
          existing.selectionSet = [...(existing.selectionSet ?? []), ...node.selectionSet];
        }
        continue;
      }
      if (node.kind === 'inline') {
        if (node.typeCondition === null || node.typeCondition === currentType) visit(node.selectionSet, currentType);
        continue;
      }
      const fragment = ctx.doc.fragments.get(node.name);
      if (fragment !== undefined) visit(fragment.selectionSet, fragment.typeCondition);
    }
  };
  visit(selections, typeName);
  return out;
}

function executeSelectionSet(ctx: Ctx, selections: SelectionNode[], typeName: string, source: Source): Record<string, unknown> {
  const fields = collectFields(ctx, selections, typeName);
  const out: Record<string, unknown> = {};
  for (const [key, field] of fields) {
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const def = SCHEMA[typeName]?.[field.name];
    if (def === undefined) {
      out[key] = null;
      continue;
    }
    const args: Args = {};
    for (const [argName, argValue] of field.args) args[argName] = valueOf(argValue, ctx.variables);
    let value: unknown;
    try {
      value = def.resolve !== undefined ? def.resolve(ctx.forge, source, args) : source[field.name];
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, def.type, value, field.selectionSet);
  }
  return out;
}

function completeValue(ctx: Ctx, type: string, value: unknown, selectionSet: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (type.startsWith('[')) {
    const inner = type.slice(1, -1);
    if (!Array.isArray(value)) return null;
    return value.map((item) => completeValue(ctx, inner, item, selectionSet));
  }
  if (selectionSet !== null && typeof value === 'object') {
    const source = value as Source;
    return executeSelectionSet(ctx, selectionSet, source.__typename ?? unwrap(type), source);
  }
  return value;
}

function runOperation(forge: Forge, doc: Document, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: string[] = [];
  validate(doc, operation.selectionSet, rootType, validationErrors);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  const ctx: Ctx = { forge, doc, variables, errors: [] };
  const data = executeSelectionSet(ctx, operation.selectionSet, rootType, { __typename: rootType });
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

/**
 * Answer one GraphQL request body: a single operation object, or an array
 * of them answered in order.
 */
export async function handleGraphql(forge: Forge, body: unknown): Promise<unknown> {
  if (Array.isArray(body)) {
    const answers: unknown[] = [];
    for (const entry of body) answers.push(await handleGraphql(forge, entry));
    return answers;
  }
  if (body === null || typeof body !== 'object') {
    return { data: null, errors: [{ message: 'GraphQL request body must be an object' }] };
  }
  const record = body as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let doc: Document;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: `Parse error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found' }] };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  const operation = operationName !== null
    ? doc.operations.find((op) => op.name === operationName) ?? doc.operations[0]
    : doc.operations[0];
  try {
    return runOperation(forge, doc, operation as Operation, variables);
  } catch (error) {
    if (error instanceof ForgeError) return { data: null, errors: [{ message: error.message }] };
    throw error;
  }
}
