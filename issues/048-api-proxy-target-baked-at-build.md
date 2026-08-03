# [High] Split-process production deploy is dead on arrival: `API_PROXY_TARGET` is baked into the Next build, so the web container proxies /api to itself

**Labels:** bug, deployment
**Severity:** High (for the documented VPS/compose deployment path)
**Confidence:** likely (documented Next 15 semantics; not executed here)

## Summary

`next.config.mjs` resolves `API_PROXY_TARGET` when `rewrites()` is evaluated — which happens once during `next build` and is frozen into `.next/routes-manifest.json`; `next start` does not re-evaluate it. The Dockerfile runs `next build` with no such build arg, so the image permanently proxies `/api` to the default `http://127.0.0.1:8787`. `infra/docker-compose.prod.yml` sets `API_PROXY_TARGET: http://api:8787` only as a **runtime** env var on the prebuilt image — it has no effect.

## Locations

- `apps/web/next.config.mjs:2-8` — env read + rewrite destination.
- `Dockerfile:23` — `next build` without the arg.
- `infra/docker-compose.prod.yml:77-83` — runtime-only env.

## Failure scenario

`docker compose -f infra/docker-compose.prod.yml up -d --build` per the file's own usage note → dashboard loads, but every `/api/*` request proxies to 127.0.0.1:8787 **inside the web container**, where nothing listens. Login, cockpit, and the kill switch all fail. (Fly and `scripts/prod.mjs` work only coincidentally: api+web share one VM, so the baked default happens to be correct.)

## Impact

The split "production" deployment ships a fully non-functional dashboard, including the emergency-stop path.

## Suggested direction (not implemented)

Pass `API_PROXY_TARGET` as a Docker build ARG, or proxy at runtime (custom server/middleware), or serve web+api behind one reverse proxy.
