// app.ts — the HTTP server: routing and authentication over the adapters.
//
// One bearer token (MAKEFUN_SHOP_TOKEN) guards every surface except
// /healthz. A missing or wrong token is a 401 with a JSON message; an
// unknown route is a 404 with a JSON message; nothing here ever answers
// HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Forge, ForgeError } from './core.ts';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { readJsonBody, sendError, sendJson, sendRaw } from './http.ts';
import { handleRest } from './rest.ts';

/** Whether the request carries the shop token. */
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (token === '') return header !== undefined;
  return header === `Bearer ${token}`;
}

/** Split a URL path into decoded segments. */
function segmentsOf(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (path === '/healthz') {
          sendRaw(res, 200, '{"ok":true}', 'application/json');
          return;
        }

        if (!authorized(req, token)) {
          throw new ForgeError(401, 'Bad credentials');
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = segmentsOf(path.slice('/api/v3'.length));
          await handleRest(forge, req, res, url, segments);
          return;
        }

        if (path === '/api/graphql') {
          if (req.method !== 'POST') throw new ForgeError(404, 'Not Found');
          const body = await readJsonBody(req);
          const answers = await handleGraphql(forge, body);
          sendJson(res, 200, answers);
          return;
        }

        if (path === '/mcp') {
          await handleMcp(forge, req, res);
          return;
        }

        // Git smart HTTP lives at /<owner>/<repo>.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const name = decodeURIComponent(gitMatch[2] as string);
          await handleGit(forge, req, res, url, owner, name, gitMatch[3] as string);
          return;
        }

        throw new ForgeError(404, 'Not Found');
      } catch (error) {
        if (!res.headersSent) sendError(res, error);
        else res.end();
      }
    })();
  });

  server.maxRequestsPerSocket = 0;
  return server;
}
