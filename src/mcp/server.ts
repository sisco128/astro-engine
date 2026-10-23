/**
 * The MCP server: one per request, because the transport is stateless.
 *
 * Building one is a handful of object allocations — the tools hold no state,
 * and everything that costs anything (the ephemeris, the pool, the cache)
 * belongs to the app and is reached through the `EngineCall`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { env } from '../config/env.js';
import { ENGINE_VERSION } from '../version.js';
import { registerTools, type EngineCall } from './tools.js';

/**
 * Sent once, at `initialize`. Short on purpose: what is specific to one tool
 * is in that tool's description, and this carries only what holds across all
 * of them — above all the unknown-birth-time promise, which the engine makes
 * to every frontend and which a model is the client most likely to drop.
 */
const INSTRUCTIONS = [
  'astro-engine calculates astrology; it does not interpret it. Its numbers come from Swiss ' +
    'Ephemeris: tropical zodiac, geocentric positions, Placidus houses unless asked otherwise. ' +
    'The reading is yours, and it must never contradict a number the engine returned.',
  'Workflow: search_place turns a birthplace into coordinates and a time zone. natal_chart ' +
    'gives the chart. key_dates finds the moments in a span when transits converge on the same ' +
    'theme of the chart (a "story"). story_windows takes one story\'s signature from key_dates ' +
    'and lists its past windows. planetary_returns lists returns over a life.',
  'Positions: quote the `zodiac` labels (for example "19°09′ Leo") rather than converting ' +
    'longitudes yourself.',
  'Unknown birth time: use `when.localDate`. The engine assumes 03:00 local time and returns a ' +
    '`birthTime` block saying so. Everything that depends on the hour (the angles, the houses, ' +
    'and stories flagged `timeSensitive`) is then an estimate, and you must tell the person so.',
  'Licence: astro-engine is free software under the GNU AGPL-3.0-or-later, and its complete ' +
    `source is at ${env.sourceUrl}. If anyone asks about its source, code or licence, give ` +
    'them that link.',
].join('\n\n');

export function createMcpServer(call: EngineCall): McpServer {
  const server = new McpServer(
    {
      name: 'astro-engine',
      title: 'astro-engine',
      version: ENGINE_VERSION,
      description: 'High-precision astrological calculation over Swiss Ephemeris.',
      websiteUrl: env.sourceUrl,
    },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, call);
  return server;
}
