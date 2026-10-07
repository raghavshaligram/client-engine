#!/bin/sh
# Runs the Google Maps scraper on Mac or Linux with Docker.
# Put queries.txt (downloaded from Client Engine > Find) next to this file, then: sh run-scraper.sh
set -e
cd "$(dirname "$0")"
[ -f queries.txt ] || { echo "queries.txt not found"; exit 1; }
mkdir -p gmaps-output
stamp=$(date +%Y-%m-%d-%H%M)
docker run --rm \
  -v gmaps-playwright-cache:/opt \
  -v "$PWD/queries.txt:/queries.txt:ro" \
  -v "$PWD/gmaps-output:/out" \
  gosom/google-maps-scraper \
  -input /queries.txt -results "/out/results-$stamp.csv" -email -depth 3 -c 2 -lang en -exit-on-inactivity 3m
echo "Done: gmaps-output/results-$stamp.csv"
