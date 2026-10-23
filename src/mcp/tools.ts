/**
 * The five MCP tools, each a thin wrapper over a /v1 route.
 *
 * Every tool runs its route in process, through the `EngineCall` it is given,
 * so the route stays the authority: it validates, resolves the local time,
 * checks the span, keys the cache, runs the pool and assembles the answer
 * exactly as it does for a frontend. Nothing here recalculates anything, so
 * nothing here can drift — and the contract and golden suites that pin the
 * routes keep covering what Claude receives.
 *
 * Input schemas are derived from the /v1 request schemas rather than written
 * again, so a field added there reaches the tools in the same commit. They are
 * narrower in three places, each for the size budget in ADR 0006: spans of five
 * years for key dates, presets only for the funnel, and at most twenty story
 * windows.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { env } from '../config/env.js';
import { FUNNEL_PRESETS } from '../domain/timescales.js';
import { HOUSE_SYSTEMS, LATITUDE_SAFE_SYSTEMS } from '../ephemeris/swe.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../geo/search.js';
import { isoToJd } from '../http/routes/v1/key-dates.js';
import {
  FunnelPresetSchema,
  KeyDatesRequestSchema,
  StoryWindowsRequestSchema,
} from '../http/schemas/funnel.js';
import { GeoSearchQuerySchema } from '../http/schemas/geo.js';
import { ReturnsRequestSchema } from '../http/schemas/returns.js';
import { ChartRequestSchema, HouseSystemSchema } from '../http/schemas/v1.js';
import { WhenSchema } from '../http/schemas/when.js';
import {
  annotateChart,
  annotateKeyDates,
  annotateStoryWindows,
  type ChartBody,
  type KeyDatesBody,
  type StoryWindowsBody,
} from './zodiac.js';

/** One /v1 request, run in process. */
export interface EngineRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: unknown;
  readonly query?: Readonly<Record<string, string>>;
}

/** Its status and parsed body. */
export interface EngineResponse {
  readonly status: number;
  readonly body: unknown;
}

export type EngineCall = (request: EngineRequest) => Promise<EngineResponse>;

/**
 * The longest key-dates span one tool call may ask for. Measured on the
 * reference chart: five years is about 13,000 tokens of answer, fifteen —
 * what /v1 allows — about 51,000, which is twice what one tool result can
 * carry in Claude Code.
 */
export const MCP_MAX_WINDOW_DAYS = 365 * 5;

/** The most story windows one call returns. /v1 allows 120. */
export const MCP_MAX_STORY_WINDOWS = 20;

/**
 * The AGPL-3.0 §13 source offer, on every result the engine produces.
 *
 * A person in claude.ai never sees the server instructions, so an offer made
 * only there is one a client can summarise away. About twenty tokens a call
 * buys an offer that is in the evidence of every answer.
 */
const LICENSE = { id: 'AGPL-3.0-or-later', source: env.sourceUrl } as const;

/** Every tool reads and computes; none of them changes anything. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const HOUSE_SYSTEM_LIST = Object.entries(HOUSE_SYSTEMS)
  .map(([letter, name]) => `${letter} ${name}`)
  .join(', ');

const LATITUDE_SAFE_LIST = LATITUDE_SAFE_SYSTEMS.map(
  (letter) => `${letter} (${HOUSE_SYSTEMS[letter]})`,
).join(', ');

const when = WhenSchema.describe(
  'The birth moment, in exactly one of three forms. `local`: the wall-clock time where the ' +
    'birth happened, with its IANA zone from search_place; the usual case. `utc`: only when ' +
    'the UTC instant is already known. `localDate`: date and zone with no hour, when the birth ' +
    'time is unknown; the engine then assumes 03:00 local time and says so in `birthTime`.',
);

const geo = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  })
  .describe('Birthplace in decimal degrees, north and east positive, from search_place.');

const houseSystem = HouseSystemSchema.default('P').describe(
  `House system, by letter: ${HOUSE_SYSTEM_LIST}.`,
);

const funnel = FunnelPresetSchema.default('funnel.default').describe(
  'Which transits count. funnel.default is the one to use unless asked otherwise; ' +
    'funnel.strict admits all four personal planets on the fast tier but requires the three ' +
    'transits to meet on the same natal point; funnel.prototype reproduces older results.',
);

// `limit` is redeclared because the query-string version coerces from a
// string, and a tool argument arrives as the number it is.
const SearchPlaceInput = GeoSearchQuerySchema.extend({
  q: GeoSearchQuerySchema.shape.q.describe('A place name, as specific as possible: "Rome, Italy".'),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const NatalChartInput = ChartRequestSchema.extend({ when, geo, houseSystem });

const KeyDatesInput = KeyDatesRequestSchema.omit({ scoring: true }).extend({
  when,
  geo,
  houseSystem,
  funnel,
  from: KeyDatesRequestSchema.shape.from.describe('First day of the span, YYYY-MM-DD.'),
  to: KeyDatesRequestSchema.shape.to.describe(
    'Last day of the span, YYYY-MM-DD. At most five years after `from`.',
  ),
});

const StoryWindowsInput = StoryWindowsRequestSchema.omit({ scoring: true }).extend({
  when,
  geo,
  houseSystem,
  funnel,
  signature: StoryWindowsRequestSchema.shape.signature.describe(
    'The story, by the `signature` key_dates returned for it on this same chart.',
  ),
  limit: z.number().int().min(1).max(MCP_MAX_STORY_WINDOWS).default(3),
});

const PlanetaryReturnsInput = ReturnsRequestSchema.extend({ when });

/** The tiers of the default preset, named from the preset itself. */
function defaultTiers(): string {
  const preset = FUNNEL_PRESETS['funnel.default'];
  return (['slow', 'social', 'fast'] as const)
    .map((tier) => `${tier}: ${preset[tier].bodies.join(', ')}`)
    .join('; ');
}

function text(body: unknown, isError: boolean): CallToolResult {
  const withLicense =
    typeof body === 'object' && body !== null ? { ...body, license: LICENSE } : body;
  return {
    content: [{ type: 'text', text: JSON.stringify(withLicense) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * A route's answer as a tool result.
 *
 * A non-2xx envelope is an answer too — `isError` with the engine's own
 * `{ code, message, details }`, so Claude can branch on the code exactly as a
 * frontend does. JSON-RPC errors are left for malformed protocol messages.
 */
async function run<T>(
  call: EngineCall,
  request: EngineRequest,
  annotate?: (body: T) => T,
): Promise<CallToolResult> {
  const { status, body } = await call(request);
  if (status >= 400) return text(body, true);
  // A 2xx body is the route's own response, and each annotator names only
  // fields that response is known to carry.
  return text(annotate === undefined ? body : annotate(body as T), false);
}

export function registerTools(server: McpServer, call: EngineCall): void {
  server.registerTool(
    'search_place',
    {
      title: 'Search place',
      description:
        'Find a place by name and get its coordinates and IANA time zone, which every chart ' +
        'tool needs. Call it whenever the person names a place rather than giving coordinates, ' +
        'and confirm the match with them when several places share the name. Results come ' +
        'from OpenStreetMap.',
      inputSchema: SearchPlaceInput,
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    (args) =>
      run(call, {
        method: 'GET',
        url: '/v1/geo/search',
        query: { q: args.q, limit: String(args.limit) },
      }),
  );

  server.registerTool(
    'natal_chart',
    {
      title: 'Natal chart',
      description:
        'Calculate a natal chart: positions of the bodies with speed and retrograde state, ' +
        'the angles, the twelve house cusps and the natal aspects with their orbs. Every ' +
        'ecliptic longitude comes with a `zodiac` label such as "19°09′ Leo"; quote those ' +
        'rather than converting degrees yourself. A `birthTime` block means the hour was ' +
        'unknown, and the angles and houses are then an estimate the person must be told about. ' +
        'Errors: NONEXISTENT_LOCAL_TIME or AMBIGUOUS_LOCAL_TIME mean the time falls in a ' +
        'daylight-saving change; ask which was meant, or use `utc`. ' +
        'HOUSE_SYSTEM_UNDEFINED_AT_LATITUDE means the house system breaks down that far from ' +
        `the equator; retry with ${LATITUDE_SAFE_LIST} and say which you used.`,
      inputSchema: NatalChartInput,
      annotations: READ_ONLY,
    },
    (args) =>
      run<ChartBody>(call, { method: 'POST', url: '/v1/charts', payload: args }, annotateChart),
  );

  server.registerTool(
    'key_dates',
    {
      title: 'Key transit dates',
      description:
        'Find the key transit dates in a span for a natal chart. The engine reduces the chart ' +
        'to stories (scored groups of natal aspects), then finds the moments when a slow, a ' +
        `social and a fast transit (${defaultTiers()}) all activate the same story at once. ` +
        'Expect one or two key dates per quarter. Each one carries its whole path, slow to ' +
        'fast, with exact dates, orbs, and where each transiting body stood (`zodiacAtKey`). ' +
        'Spans are limited to five years per call: for longer stretches, call once per period. ' +
        "Each story's `signature` can be passed to story_windows.",
      inputSchema: KeyDatesInput,
      annotations: READ_ONLY,
    },
    async (args) => {
      const requestedDays = Math.round(isoToJd(args.to) - isoToJd(args.from));
      if (requestedDays > MCP_MAX_WINDOW_DAYS) {
        // The /v1 code, with the MCP bound in its details, so a caller handles
        // both surfaces the same way. Refused before any work is queued.
        return text(
          {
            error: {
              code: 'WINDOW_TOO_LARGE',
              message: `The requested span is ${String(requestedDays)} days; one key_dates call covers at most ${String(MCP_MAX_WINDOW_DAYS)}. Split it into shorter periods.`,
              details: { requestedDays, maxDays: MCP_MAX_WINDOW_DAYS },
            },
          },
          true,
        );
      }
      return run<KeyDatesBody>(
        call,
        { method: 'POST', url: '/v1/transits/key-dates', payload: args },
        annotateKeyDates,
      );
    },
  );

  server.registerTool(
    'story_windows',
    {
      title: 'Story windows',
      description:
        'List the past windows in which one story of a natal chart was activated, strongest ' +
        'first: for asking a person whether they remember those periods, or for seeing how a ' +
        'theme has recurred. Name the story by the `signature` key_dates returned for it. ' +
        `Defaults to the ten years up to today and the top 3 windows (at most ${String(MCP_MAX_STORY_WINDOWS)}). ` +
        'STORY_NOT_IN_CHART means the signature belongs to a different chart.',
      inputSchema: StoryWindowsInput,
      annotations: READ_ONLY,
    },
    (args) =>
      run<StoryWindowsBody>(
        call,
        { method: 'POST', url: '/v1/transits/story-windows', payload: args },
        annotateStoryWindows,
      ),
  );

  server.registerTool(
    'planetary_returns',
    {
      title: 'Planetary returns',
      description:
        'Find the planetary returns and half-returns of a life, counted from birth: Saturn, ' +
        'Uranus, Chiron and Pluto by default, each with the age, the exact passes and a ' +
        'life-phase label where one exists (the first Saturn return, for instance). Ages are ' +
        'found against the ephemeris, not read from a table. The place of birth is not needed.',
      inputSchema: PlanetaryReturnsInput,
      annotations: READ_ONLY,
    },
    (args) => run(call, { method: 'POST', url: '/v1/transits/returns', payload: args }),
  );
}
