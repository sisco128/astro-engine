# The engine, containerised. Four stages, each keyed on exactly the files
# that determine its output:
#
#   deps       prod node_modules  — keyed on the lockfile
#   build      dist/              — keyed on the lockfile + tsconfigs + src
#   ephemeris  103 MB of .se1     — keyed on the manifest + the fetch script
#   runtime    the three above on a bare node:22-slim, non-root
#
# The ephemeris stage is the one that earns the layering. See its comment.

# ---------------------------------------------------------------- deps ------
# Production node_modules only. sweph is a native N-API module that ships
# prebuilds for linux-x64 and linux-arm64, so no compiler or python ever
# enters the image. (CI's "Assert the binding identity" step exists to notice
# if that ever stops being true.)
#
# pnpm 10 does not run dependency lifecycle scripts unless they are
# allowlisted, so sweph's `install` hook (node-gyp-build) is skipped here and
# prints a warning. That is correct and must stay that way: node-gyp-build
# also runs at require() time, where it resolves prebuilds/<platform>-<arch>
# and never reaches for node-gyp. Allowlisting the hook to silence the warning
# would drag a toolchain into the build for nothing.
FROM node:22-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------- build -----
# A separate full install because compiling needs devDependencies (typescript)
# that must never reach the runtime image.
FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---------------------------------------------------------------- ephemeris -
# The 103 MB layer, and the real design problem of this Dockerfile.
#
# The data is immutable — Swiss Ephemeris files for a fixed version, pinned by
# SHA-256 in ephemeris.manifest.json — but downloading it takes far longer
# than compiling the entire engine. If this stage saw the source tree, every
# code change would invalidate it and every deploy would re-download 103 MB
# that cannot have changed. So the stage copies ONLY the manifest and the
# fetch script: its cache key is effectively the manifest hash, and the layer
# survives every code, dependency and config change. It re-runs exactly when
# the manifest is re-seeded — which is when it should.
#
# The fetch script needs nothing beyond node builtins, and Node 22 can strip
# its type annotations natively — which keeps node_modules (and therefore the
# lockfile) out of this stage's inputs entirely. No package.json is copied
# either: without one Node decides the module system by looking at the syntax,
# and the script's imports and top-level await make that ESM. Verified by
# running it in an empty directory, since a wrong guess here fails only at
# build time, in the one stage nobody wants to re-run.
FROM node:22-slim AS ephemeris
WORKDIR /app
COPY ephemeris.manifest.json ./
COPY scripts/fetch-ephemeris.ts scripts/
ENV EPHEMERIS_PROFILE=full \
    SE_EPHE_PATH=/app/ephem
RUN node --experimental-strip-types scripts/fetch-ephemeris.ts

# ---------------------------------------------------------------- runtime ---
FROM node:22-slim AS runtime
# EPHEMERIS_PROFILE is what the ephemeris stage installed, restated so the
# image describes itself: it is the profile /v1/ready reports and the one
# `pnpm ephem:verify` would check. Overriding it at runtime changes the claim,
# not the data on disk.
ENV NODE_ENV=production \
    SE_EPHE_PATH=/app/ephem \
    EPHEMERIS_PROFILE=full \
    PORT=3000
WORKDIR /app
# package.json carries "type": "module" — without it node would read dist/ as
# CommonJS. ephemeris.manifest.json is hashed from the cwd at startup to key
# the result cache, so a re-seeded manifest invalidates cached results on its
# own; without it the cache silently keys on "no-manifest" and survives a data
# change it should not survive. LICENSE travels with the binaries because both
# this engine and Swiss Ephemeris itself are AGPL — /v1/meta/license points a
# network user at the source, and this is the text that offer refers to.
COPY --chown=node:node package.json ephemeris.manifest.json LICENSE ./
# pnpm's node_modules is a tree of relative symlinks into node_modules/.pnpm.
# COPY preserves them, and they stay resolvable only because the directory
# lands at the same path it had in the deps stage. Moving it elsewhere in the
# image would leave every one of them dangling.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=ephemeris --chown=node:node /app/ephem ./ephem
USER node
EXPOSE 3000
# /v1/ready, not /v1/health: ready is the endpoint that proves calculations
# can actually succeed — ephemeris loaded, probe passed, a compute worker up.
# node:22-slim ships no curl, and installing one for a probe would be the tail
# wagging the dog; global fetch does the same job.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/ready').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
