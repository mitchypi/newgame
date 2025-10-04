# Agents Guide: Stock Market Time Machine

This repository contains a Flask web app that lets users "time travel" through historical market data and trade along the timeline using locally cached datasets. Agents should use this guide for quick orientation, conventions, and safe changes.

## Project Layout

- `app.py` â€” Flask app, routes, portfolio logic, and UI glue.
- `market_data.py` â€” Local data access: symbol manifests, history loading, market cap lookups.
- `scripts/build_market_data.py` â€” Offline pipeline to generate/refresh `data/` using Yahoo Finance and Wikipedia.
- `data/` â€” Local datasets (Parquet/CSV) and manifests used at runtime; no network access in the app.
  - `data/stocks/*.parquet`, `data/crypto/*.parquet`, `data/*/manifest.json`
  - `data/sources/` â€” inputs used by the pipeline (e.g., candidate lists, cached S&P 500 table).
- `templates/` â€” Jinja2 HTML templates.
- `static/style.css` â€” App stylesheet.
- `test_catalog.py` â€” Simple sanity check for `MarketDataCatalog` path resolution and dates.
- `web/` â€” Client-first TypeScript app (Vite + IndexedDB) that runs entirely from static assets.

## Quick Start

- Python: 3.10+ recommended (repo currently runs with 3.11 in cache paths).
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

- Edit `data/sources/non_sp500_candidates.csv` to tune nonâ€‘S&P candidates (autoâ€‘generated on first run).
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
- `StockMarket` caches perâ€‘symbol frames in memory; avoid loading entire universes within a single request.

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
- Run `python scripts/build_market_data.py --emit-static` whenever you need to refresh `web/public/data/` after updating the datasets.

### UI Parity with Flask
- The client reuses the Flask prototype’s CSS (`web/public/style.css`).
- Layout and components mirror `templates/portfolio.html` (rendered via TypeScript in `web/src/main.ts`).
- Search, pinned stocks, buy/sell actions, time controls, crypto visibility, transactions table, and the portfolio chart are implemented client-side.

### Static Data Assets
- `web/public/data/manifest.json` — generated via the pipeline (tickers and metadata).
- `web/public/data/history/*.json` — per-symbol daily `{date, price}` arrays.
- These files are lazily fetched and cached in IndexedDB; no Flask APIs are required at runtime.

### Production Hosting
- Build the client: `npm run build` creates `web/dist/`.
- Serve `web/dist/` (plus the generated `web/public/data/` if your host requires it) from any static host or CDN.
- Optionally keep Flask around only to serve the static bundle; otherwise the SPA runs standalone.

### IndexedDB Stores
- `system` — key: `system`; fields: `currentDate`, `timeOfDay`, `cash`.
- `holdings` — key: `symbol`; fields: `shares`, `avgCost`.
- `transactions` — auto-increment `id`; fields: `date`, `time`, `type`, `symbol`, `shares`, `price`, `total`.
- `prices` — key: `${symbol}:${date}`; index `bySymbol`; fields: `symbol`, `date`, `price`.
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
  - Add a corresponding template in `templates/` and link it from the main page (`portfolio.html` served at `/`) where relevant.
- Extend available symbols/metadata
  - Update the pipeline (`scripts/build_market_data.py`) or manifests, then rebuild data.
- Add computed metrics (e.g., returns)
  - Add helpers in `app.py` or a small module; reuse cached frames from `StockMarket`.
 - Client features (TS app)
   - Implement views under `web/src/` and load data from `/data/\*` JSON.
   - Persist user state in IndexedDB; keep server sessions minimal.

## Testing & Verification

- Quick check that data resolution works:
  ```bash
  python test_catalog.py
  ```
- Manual smoke test
  - Start the app, load a wellâ€‘known ticker (e.g., `AAPL`, `MSFT`), and verify price chart and buy/sell actions.
  - Try crypto symbols (`BTC-USD`, `ETH-USD`) to confirm preloading.
 - Client smoke test
   - Run `npm run dev` in `web/` and use the search to fetch and cache monthly history for a ticker.

## Guardrails for Agents

- Keep edits surgical; do not reformat unrelated files.
- Do not commit large binary/data changes as part of code fixes.
- Avoid adding new runtime dependencies unless necessary; prefer the existing stack.
- If you touch routes or templates, ensure the app still starts and the index loads without errors.
- Update this `AGENTS.md` if you introduce new conventions or flows.
 - Keep `web/public/data/` outputs in sync with the pipeline and avoid manual edits to generated JSON.

## Troubleshooting

- Parquet read errors: ensure `pyarrow` or `fastparquet` is installed.
- Missing data files: run the data pipeline or limit testing to symbols present under `data/`.
- Slow first page load for crypto: `app.py` preloads `BTC-USD` and `ETH-USD` at startup; keep it that way to avoid UI stalls.

---
Scope: This file applies to the entire repository. When more specific conventions are required, add an `AGENTS.md` in the relevant subdirectory; deeper files take precedence.



