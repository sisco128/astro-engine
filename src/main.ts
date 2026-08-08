/**
 * The only file that calls listen(). Everything else builds, nothing else runs.
 */

import closeWithGrace from 'close-with-grace';

import { env } from './config/env.js';
import { closeEphemeris } from './ephemeris/swe.js';
import { buildApp } from './http/app.js';

const app = await buildApp();

closeWithGrace({ delay: 10_000 }, async ({ signal, err }) => {
  if (err !== undefined) {
    app.log.error({ err }, 'shutting down after an error');
  } else {
    app.log.info({ signal }, 'shutting down');
  }
  await app.close();
  closeEphemeris();
});

await app.listen({ port: env.port, host: env.host });
