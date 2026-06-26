#!/usr/bin/env bash
set -e

echo "🪙  Gold Alert — Setup"
echo "========================"

# ── Install Node.js if missing ────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "→ Node.js not found. Installing via nvm…"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
  echo "✓ Node.js $(node --version) installed"
else
  echo "✓ Node.js $(node --version) found"
fi

# ── Install dependencies ──────────────────────────────────────────────────────
echo "→ Installing npm dependencies…"
npm install

# ── Install Playwright browser ────────────────────────────────────────────────
echo "→ Installing Playwright (Chromium)…"
npx playwright install chromium

# ── Generate VAPID keys & .env (first run only) ───────────────────────────────
if [ ! -f .env ]; then
  echo "→ Generating VAPID keys…"
  node server/index.js   # exits after writing .env on first run
fi

echo ""
echo "✅  Setup complete!"
echo ""
echo "To start the server:"
echo "   node server/index.js"
echo ""
echo "Then open http://localhost:3000 in Safari on your iPhone"
echo "(use ngrok for a public HTTPS URL if needed)"
