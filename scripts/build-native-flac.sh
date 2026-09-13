#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
archive="$root/vendor/libflac-1.5.0/flac-1.5.0.tar.xz"
expected=f2c1c76592a82ffff8413ba3c4a1299b6c7ab06c734dee03fd88630485c2b920
actual=$(sha256sum "$archive" | cut -d ' ' -f 1)
test "$actual" = "$expected"
work=$(mktemp -d "${TMPDIR:-/tmp}/codec-native-flac.XXXXXX")
# Leave successful builds available to the caller; failed builds retain logs.
tar -xf "$archive" -C "$work"
mkdir "$work/build"
cd "$work/build"
if ! "$work/flac-1.5.0/configure" --disable-shared --enable-static \
  --disable-ogg --disable-cpplibs --disable-examples --disable-doxygen-docs \
  --disable-multithreading > configure.log 2>&1; then
  cat configure.log >&2
  exit 1
fi
if ! make -j2 > build.log 2>&1; then
  cat build.log >&2
  exit 1
fi
printf '%s\n' "$work/build/src/flac/flac"
