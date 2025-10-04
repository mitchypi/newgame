// Copies web/dist/index.html to web/dist/404.html for GitHub Pages SPA routing
// Runs automatically via npm "postbuild".

const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const indexPath = path.join(distDir, 'index.html');
const fallbackPath = path.join(distDir, '404.html');

function ensureFallback() {
  if (!fs.existsSync(distDir)) {
    console.error(`[postbuild] Dist folder not found: ${distDir}`);
    process.exit(0); // do not fail the build
  }
  if (!fs.existsSync(indexPath)) {
    console.error(`[postbuild] index.html not found at: ${indexPath}`);
    process.exit(0);
  }
  try {
    fs.copyFileSync(indexPath, fallbackPath);
    console.log(`[postbuild] Created fallback: ${path.relative(process.cwd(), fallbackPath)}`);
  } catch (err) {
    console.error('[postbuild] Failed to create 404.html:', err);
    process.exit(0); // ignore failure to avoid breaking CI
  }
}

ensureFallback();

