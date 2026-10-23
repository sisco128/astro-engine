/**
 * POST /mcp and POST /mcp/:token — the engine as a remote MCP server.
 *
 * Outside /v1 on purpose: this is not part of the HTTP contract, the OpenAPI
 * document does not describe it, and the route-coverage test that scans /v1
 * correctly ignores it. See docs/adr/0006-mcp-connector.md.
 *
 * Streamable HTTP, stateless, plain JSON responses. Nothing here streams and
 * nothing needs a session, so every POST is answered whole by a server built
 * for that request alone. The web-standard transport is used rather than the
 * Node one so that the answer goes back through `reply` like any other route
 * — with this app's headers and hooks — instead of being written to the raw
 * socket behind Fastify's back.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';

import { createMcpServer } from '../../mcp/server.js';
import type { EngineCall } from '../../mcp/tools.js';
import { matches } from '../credentials.js';

/** For Claude Code and the Messages API: authenticated by header. */
export const MCP_ROUTE = '/mcp';

/** For claude.ai custom connectors, which cannot send a header. */
export const MCP_TOKEN_ROUTE = '/mcp/:token';

/**
 * A request line with any token in it replaced by the route pattern.
 *
 * Fastify's request serializer logs `req.url`, which would write the token
 * into the logs on every call — and a token in a log is a token anyone with
 * the logs can use. app.ts routes every logged URL through this.
 */
export function redactMcpToken(url: string): string {
  return url.replace(/^\/mcp\/[^/?#]+/, MCP_TOKEN_ROUTE);
}

/**
 * The headers the transport reads, and no others. Copying the request's whole
 * header set into a web `Request` would carry hop-by-hop headers and a
 * `content-length` for a body that is passed already parsed.
 */
const TRANSPORT_HEADERS = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id'];

function webRequestOf(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const name of TRANSPORT_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  // A fixed URL rather than the real one: the transport never routes on it,
  // and the real one may carry a token.
  return new Request('http://astro-engine.internal/mcp', { method: request.method, headers });
}

export interface McpRouteOptions {
  /** Digests of MCP_URL_TOKENS. Empty means /mcp/:token is not mounted. */
  readonly urlTokenDigests: readonly Buffer[];
  /** /v1, run in process on behalf of whoever sent this request. */
  readonly engineFor: (request: FastifyRequest) => EngineCall;
}

export function registerMcpRoutes(app: FastifyInstance, options: McpRouteOptions): void {
  async function answer(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const server = createMcpServer(options.engineFor(request));
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(webRequestOf(request), {
        parsedBody: request.body,
      });
      reply.status(response.status);
      response.headers.forEach((value, name) => {
        reply.header(name, value);
      });
      return await reply.send(await response.text());
    } finally {
      // Closes the transport with it.
      await server.close();
    }
  }

  // GET would open a server-to-client event stream and DELETE would end a
  // session; a stateless server that never streams offers neither.
  function notAllowed(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
    return reply
      .status(405)
      .header('Allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: this server answers POST only.' },
        id: null,
      });
  }

  app.post(MCP_ROUTE, answer);
  app.get(MCP_ROUTE, notAllowed);
  app.delete(MCP_ROUTE, notAllowed);

  if (options.urlTokenDigests.length === 0) return;

  /**
   * The token check, on this route alone and whatever else is configured.
   *
   * The app-wide key hook skips this route, because what it carries is not an
   * API key and must not be one: a leaked connector URL may not open /v1.
   * Registered here rather than in that hook so that the route cannot exist
   * without its check — in development with no API keys too, where the hook
   * is not installed at all.
   */
  const requireToken: onRequestHookHandler = (request, reply, done) => {
    const { token } = request.params as { token: string };
    if (matches(token, options.urlTokenDigests)) {
      done();
      return;
    }
    request.log.warn({ route: MCP_TOKEN_ROUTE }, 'rejected: no valid MCP URL token');
    // The envelope every other refusal uses, and nothing from the URL in it.
    reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'This endpoint requires a valid token in its path.',
        requestId: request.id,
      },
    });
  };

  app.post(MCP_TOKEN_ROUTE, { onRequest: requireToken }, answer);
  app.get(MCP_TOKEN_ROUTE, { onRequest: requireToken }, notAllowed);
  app.delete(MCP_TOKEN_ROUTE, { onRequest: requireToken }, notAllowed);
}
