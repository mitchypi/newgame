# Agents Guide: Stock Market Time Machine

This repository contains a Flask prototype and a full client‑side web app that lets users “time travel” through historical market data and trade along the timeline using locally cached datasets. Use this guide for quick orientation, conventions, and safe changes.

## Project Layout

- `app.py` — Flask app, routes, portfolio logic, and UI glue.
- `market_data.py` — Local data access: symbol manifests, history loading, market cap lookups.
- `scripts/build_market_data.py` — Offline pipeline to generate/refresh `data/` using Yahoo Finance and Wikipedia.
- `data/` — Local datasets (Parquet/CSV) and manifests used at runtime; no network access in the app.
  - `data/stocks/*.parquet`, `data/crypto/*.parquet`, `data/*/manifest.json`
  - `data/sources/` — inputs used by the pipeline (e.g., candidate lists, cached S&P 500 table).
- `templates/` — Jinja2 HTML templates (prototype).
- `static/style.css` — Prototype stylesheet.
- `web/` — Client‑first TypeScript app (Vite + IndexedDB) that runs entirely from static assets.

## Quick Start

- Python: 3.10+ recommended (repo runs with 3.11 in cache paths).
- Create a virtual environment and install dependencies:

  Windows (PowerShell)
  ```powershell
  python -m venv .venv
  .\.venv\Scripts\Activate.ps1
  python -m pip install -U pip
  pip install flask pandas requests yfinance tqdm pyarrow fastparquet
  ```

  macOS/Linux (bash)
  ```bash
  python3 -m venv .venv
  source .venv/bin/activate
  python -m pip install -U pip
  pip install flask pandas requests yfinance tqdm pyarrow fastparquet
  ```

- Run the app (uses local data; no network):
  ```bash
  python app.py
  # visit http://localhost:5001
  ```

## Data Pipeline (optional during dev)

The app is designed to run fully offline against `data/`. To refresh or expand datasets:

- Edit `data/sources/non_sp500_candidates.csv` to tune non‑S&P candidates (auto‑generated on first run).
- Build/refresh data and emit static client assets:
  ```bash
  python scripts/build_market_data.py \
    --start 2000-01-03 \
    --end   $(date +%F)      # omit on Windows or supply a date \
    --emit-static
  ```
  Tips:
  - First run can take hours. Use `--start 2015-01-01` while iterating.
  - Add `--throttle 0.2` to reduce API pressure; the script uses `yfinance` and Wikipedia.
  - Outputs land in `data/stocks/`, `data/crypto/`, update `manifest.json`, and write JSON files under `web/public/data/` for the SPA.

## Runtime Notes

- App port: `5001` (see `app.py: app.run(..., port=5001)`).
- Secret key in `app.py` is a dev placeholder. Do not ship real secrets; prefer `FLASK_SECRET_KEY` env in production.
- Prices are read from local Parquet/CSV; do not add live API calls to request handlers.
- `StockMarket` caches per‑symbol frames in memory; avoid loading entire universes within a single request.

## Client App (TypeScript)

- Location: `web/` (Vite + TypeScript + IndexedDB via `idb`).
- Dev server:
  ```bash
  cd web
  npm install
  npm run dev
  # open http://localhost:5173
  ```
- Build static assets (ready to host anywhere):
  ```bash
  npm run build
  npm run preview
  ```
- The SPA reads ticker and history JSON from `web/public/data/` and uses `web/public/style.css` (copied from `static/style.css`).
- Static hosting: Vite `base` is set to `./` in `web/vite.config.ts`, and client fetches use `import.meta.env.BASE_URL` (see `web/src/api.ts`). This makes the bundle portable from any subpath or CDN.
- Run `python scripts/build_market_data.py --emit-static` whenever you need to refresh `web/public/data/` after updating the datasets.

### UI parity
- The client mirrors the prototype’s layout.
- Features: search, pinned stocks, buy/sell, time controls, crypto visibility, transactions, and portfolio chart.

### Static Data Assets
- `web/public/data/manifest.json` — generated via the pipeline (tickers and metadata).
- `web/public/data/history/*.json` — per‑symbol daily `{date, price}` arrays.
- These files are lazily fetched and cached in IndexedDB; no Flask APIs are required at runtime.

### Production Hosting
- Build the client: `npm run build` creates `web/dist/`.
- Serve the contents of `web/dist/` from any static host (GitHub Pages, Netlify, Cloudflare Pages, S3/CloudFront, Nginx/Apache). The build includes `data/` under `web/dist/data/`.
- Because asset and data URLs are relative, you can host at a subpath without extra config.
- Optionally keep Flask around only to serve the static bundle; otherwise the SPA runs standalone.

### IndexedDB Stores
- `system` – key: `system`; fields: `currentDate`, `timeOfDay`, `cash`.
- `holdings` – key: `symbol`; fields: `shares`, `avgCost`.
- `transactions` – auto‑increment `id`; fields: `date`, `time`, `type`, `symbol`, `shares`, `price`, `total`.
- `prices` – key: `${symbol}:${date}`; index `bySymbol`; fields: `symbol`, `date`, `price`.

Schema/versioning
- Current client DB version is `2` (see `web/src/db.ts`). Upgrades create any missing stores automatically when the app loads.
- If a user opened an older build and state looks off, clear the “time‑machine” DB in browser devtools or click “Start Over”.

### Weekend Trading Behavior
- Stocks: trading is disabled on weekends. The UI hides Sell/Sell All in holdings and the Buy forms in the search card, and shows a note instead.
- Crypto (BTC‑USD, ETH‑USD): trading remains available 7 days a week, visible only after their invention dates.

### Portfolio Chart & History
- The client maintains monthly portfolio history and backfills one point per month even when the user jumps across years.
- Backfill replays transactions month‑by‑month to compute accurate cash/holdings values at each month‑end (see `computeFilledMonthlyHistory` in `web/src/main.ts`).
- Axis label thinning avoids crowding for long ranges (see `buildMonthlyLabels` in `web/src/main.ts`).

### Client Fetch Paths
- Tickers: `data/manifest.json`
- History: `data/history/<SYMBOL>.json`
- Fetches are resolved relative to the deployed base URL. Avoid introducing absolute `/...` URLs in new code.

## Conventions

- Python
  - Follow PEP 8 and use type hints where practical.
  - Keep changes minimal and focused; avoid large refactors unless requested.
  - Prefer pure functions for portfolio/math helpers; keep I/O at the edges.
  - Do not rename public functions/classes without updating all call sites.
- Templates/CSS
  - Keep Jinja2 templates simple; push logic into view functions.
  - Keep CSS in `static/style.css`; avoid inline styles.
- Data
  - Treat `MarketDataCatalog` as the single source for history and metadata.
  - Never mutate files in `data/` from request handlers; use the pipeline.
  - APIs should be stateless; the client maintains its own state in IndexedDB.

## Common Tasks

- Add a new page/route
  - Implement the view in `app.py` near related routes.
  - Add a corresponding template in `templates/` and link it from the main page where relevant.
- Extend available symbols/metadata
  - Update the pipeline (`scripts/build_market_data.py`) or manifests, then rebuild data.
- Add computed metrics (e.g., returns)
  - Add helpers in `app.py` or a small module; reuse cached frames from `StockMarket`.
- Client features (TS app)
  - Implement views under `web/src/` and load data from `/data/*` JSON.
  - Persist user state in IndexedDB; keep server sessions minimal.

## Testing & Verification

- Quick check that data resolution works:
  ```bash
  python test_catalog.py
  ```
- Manual smoke test
  - Start the app, load a well‑known ticker (e.g., `AAPL`, `MSFT`), and verify price chart and buy/sell actions.
  - Try crypto symbols (`BTC‑USD`, `ETH‑USD`) to confirm preloading.
- Client smoke test
  - Run `npm run dev` in `web/` and use the search to fetch and cache history for a ticker. Confirm monthly charting and weekend rules.

## Guardrails for Agents

- Keep edits surgical; do not reformat unrelated files.
- Do not commit large binary/data changes as part of code fixes.
- Avoid adding new runtime dependencies unless necessary; prefer the existing stack.
- If you touch routes or templates, ensure the app still starts and the index loads without errors.
- Update this `AGENTS.md` if you introduce new conventions or flows.
- Keep `web/public/data/` outputs in sync with the pipeline and avoid manual edits to generated JSON.
- Keep monthly chart granularity intact; do not bucket or downsample unless requested. Coordinate changes to `computeFilledMonthlyHistory` and `buildMonthlyLabels`.
- Maintain relative URLs in the web client (Vite `base: './'`) to preserve portability for static hosting.

## Troubleshooting

- Parquet read errors: ensure `pyarrow` or `fastparquet` is installed.
- Missing data files: run the data pipeline or limit testing to symbols present under `data/`.
- If the SPA shows stale data or no transactions, hard reload and/or click “Start Over” to reset IndexedDB (version 2).
- Slow first page load for crypto: keep preloading `BTC‑USD` and `ETH‑USD` at startup.

---
Scope: This file applies to the entire repository. When more specific conventions are required, add an `AGENTS.md` in the relevant subdirectory; deeper files take precedence.

