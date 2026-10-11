#!/usr/bin/env bash
# About me: Release step of the GitHub workflow (.github/workflows/build.yml).
# Publishes the built .xpi as GitHub Release v<version>, unless that release
# already exists - existing releases are never changed or overwritten, so
# every published version stays available. A new release therefore needs a
# new version in manifest.json.
#
# Usage: publish-release.sh <version> <xpi-file>
# Needs the GitHub CLI `gh` with a token (GH_TOKEN) and GITHUB_SHA, the commit
# the release tag is created on.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <version> <xpi-file>" >&2
  exit 2
fi
version="$1"
xpi="$2"
tag="v${version}"

if [ ! -f "$xpi" ]; then
  echo "Package $xpi does not exist" >&2
  exit 1
fi

if gh release view "$tag" > /dev/null 2>&1; then
  echo "Release $tag already exists and is left untouched. Bump the version in manifest.json to publish a new release."
  exit 0
fi

gh release create "$tag" "$xpi" \
  --target "$GITHUB_SHA" \
  --title "Message Filter Exporter $version" \
  --generate-notes
