#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# Download BareKit.xcframework if not present
if [ ! -d Frameworks/BareKit.xcframework ]; then
  echo "=== Downloading BareKit prebuilds ==="
  gh release download --repo holepunchto/bare-kit --pattern 'prebuilds.zip' -D /tmp
  unzip -o /tmp/prebuilds.zip -d /tmp/bare-prebuilds
  mkdir -p Frameworks
  cp -r /tmp/bare-prebuilds/ios/BareKit.xcframework Frameworks/
  echo "BareKit.xcframework installed"
fi

echo "=== Installing worklet dependencies ==="
npm install

echo "=== Linking native addons for iOS ==="
npx bare-link --preset ios --out addons

echo "=== Packing worklet bundle ==="
npx bare-pack --preset ios --linked --out Resources/client.bundle worklet/client.js

echo "=== Generating Xcode project ==="
xcodegen generate

echo "=== Done ==="
echo "Open nospoon.xcodeproj in Xcode to build and run."
