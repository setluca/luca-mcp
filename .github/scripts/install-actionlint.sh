#!/usr/bin/env bash
# Installs actionlint, checksum verified, into the working directory.
set -euo pipefail

version="1.7.12"
sha256="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
archive="actionlint_${version}_linux_amd64.tar.gz"

curl -fsSL -o "$archive" \
  "https://github.com/rhysd/actionlint/releases/download/v${version}/${archive}"
echo "${sha256}  ${archive}" | sha256sum --check --strict
tar xzf "$archive" actionlint
rm "$archive"
