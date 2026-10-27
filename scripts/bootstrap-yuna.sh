#!/bin/sh
# Run on yuna-mbp (macOS 14): minimal local runtime, independent of unsupported Homebrew bottles.
set -eu
export PATH=/opt/homebrew/bin:$PATH
uptime
df -h "$HOME"
RUNTIME="$HOME/.local/share/keel-trailer-runtime"
BUILD=$(mktemp -d /tmp/keel-trailer-runtime.XXXXXX)
trap 'rm -rf "$BUILD"' EXIT HUP INT TERM
mkdir -p "$RUNTIME/bin" "$RUNTIME/lib" "$RUNTIME/include"
/usr/bin/python3 -m uv python install 3.13
PYTHON=$(/usr/bin/python3 -m uv python find 3.13)
ln -sf "$PYTHON" "$RUNTIME/bin/python3"
cd "$BUILD"
curl -fLsS https://code.videolan.org/videolan/x264/-/archive/stable/x264-stable.tar.gz -o x264.tar.gz
curl -fLsS https://ffmpeg.org/releases/ffmpeg-8.0.3.tar.xz -o ffmpeg.tar.xz
shasum -a 256 x264.tar.gz ffmpeg.tar.xz > "$RUNTIME/source-sha256.txt"
tar -xf x264.tar.gz
cd x264-stable
./configure --prefix="$RUNTIME" --enable-static --disable-cli --disable-asm > "$BUILD/x264-configure.log"
make -j4 > "$BUILD/x264-make.log" 2>&1
make install > "$BUILD/x264-install.log"
cat > "$BUILD/pkg-config" <<'SHIM'
#!/bin/sh
case "$*" in
  *--version*) echo 1.0 ;;
  *--modversion*) echo 0.165 ;;
  *--cflags*) echo "-I$TRAILER_BUILD_PREFIX/include" ;;
  *--libs*) echo "-L$TRAILER_BUILD_PREFIX/lib -lx264 -lm -lpthread" ;;
  *x264*) exit 0 ;;
  *) exit 1 ;;
esac
SHIM
chmod +x "$BUILD/pkg-config"
export TRAILER_BUILD_PREFIX="$RUNTIME"
cd "$BUILD"
tar -xf ffmpeg.tar.xz
cd ffmpeg-8.0.3
./configure --prefix="$RUNTIME" --pkg-config="$BUILD/pkg-config" --disable-autodetect --disable-doc --disable-debug \
  --disable-ffplay --disable-network --disable-avdevice --disable-videotoolbox --enable-gpl --enable-libx264 \
  --enable-static --disable-shared > "$BUILD/ffmpeg-configure.log" 2>&1
make -j4 > "$BUILD/ffmpeg-make.log" 2>&1
make install > "$BUILD/ffmpeg-install.log" 2>&1
"$RUNTIME/bin/ffmpeg" -version
"$RUNTIME/bin/python3" --version
