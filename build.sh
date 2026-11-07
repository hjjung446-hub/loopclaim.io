#!/bin/sh
# wraps the single-file game into public/index.html for the server
cd "$(dirname "$0")"
{ printf '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'; cat src/ttang.html; printf '\n</body></html>\n'; } > public/index.html
echo "built public/index.html"
