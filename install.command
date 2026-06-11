#!/bin/bash
#
# Caster Companion — one-step installer.
#
# Double-click this file in Finder (or run it from a terminal). It builds the
# app and installs it to /Applications. After this you never need the terminal
# again — just launch Caster Companion like any other app.
#
set -e
cd "$(dirname "$0")"

APP_NAME="Caster Companion"
BUILT="dist/${APP_NAME}-darwin-arm64/${APP_NAME}.app"
DEST="/Applications/${APP_NAME}.app"

echo ""
echo "=== Building ${APP_NAME} ==="
echo ""

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is required to build the app, and it wasn't found."
  echo "Install it from https://nodejs.org (the LTS version), then run this again."
  echo ""
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

echo "Installing dependencies (first run only, may take a minute)..."
npm install --silent

echo "Building the app..."
npm run package --silent

echo "Installing to Applications..."
rm -rf "$DEST"
cp -R "$BUILT" "$DEST"

echo ""
echo "Done. \"${APP_NAME}\" is now in your Applications folder."
echo "Opening Applications so you can drag it to your Dock..."
open /Applications

# Launch it once so it's ready to use.
open "$DEST" || true

echo ""
read -n 1 -s -r -p "Press any key to close this window."
echo ""
