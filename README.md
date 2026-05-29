# VibePins

A duckpin bowling game.

Three.js + Rapier (WASM physics) + Vite + TypeScript, deployed static to Vercel.

## Development

```bash
npm install      # install dependencies
npm run dev      # start the Vite dev server
npm run build    # production build into dist/
npm run preview  # preview the production build
npm run typecheck # tsc --noEmit
npm run test     # run the Vitest suite
```

Open the dev-server URL and you should see the dark, fogged lane scene with the camera framed behind the foul line.

## Environment variables

None yet. The serverless backend for async multiplayer and the leaderboard (planned, see `docs/gdd/05-async-multiplayer.html` and `docs/gdd/07-leaderboard.html`) will use Upstash Redis. Those vars will be documented here and set in the Vercel dashboard when that work lands, never committed to the repo.

## Project docs

The design and process live under `docs/` (HTML-first spiral scaffold). Start with `AGENTS.md`, then `docs/IMPLEMENTATION_PLAN.html` and `docs/gdd/index.html`.
