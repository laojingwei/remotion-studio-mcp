#!/usr/bin/env bash
# 生成外部配音验证用的音频样本（mp3 / wav / 一个假 flac）
# 用法：bash scripts/make-audio-samples.sh [输出目录]
set -euo pipefail
D="${1:-/tmp/extaudio2}"
FF="node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe"
[ -x "$FF" ] || FF="$(command -v ffmpeg || true)"
[ -n "$FF" ] || { echo "找不到 ffmpeg，跳过"; exit 0; }

mkdir -p "$D"
for i in 1 2 3; do
  "$FF" -y -v error -f lavfi -i "sine=frequency=$((300 + i * 100)):duration=$((2 + i))" \
    -c:a libmp3lame -b:a 128k "$D/vo-0$i.mp3"
done
"$FF" -y -v error -f lavfi -i "sine=frequency=400:duration=12" "$D/full-track.wav"
# flac 只是要测"读不出时长"的拒绝路径，扩展名对即可
cp "$D/full-track.wav" "$D/vo-flac.flac"
echo "已生成到 $D:"; ls -1 "$D"
