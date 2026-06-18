#!/bin/bash
# Mario Land Family Trip Video Bot
# Scans mario_land/Clips for videos and builds a highlight reel in mario_land/Output

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIPS_DIR="$SCRIPT_DIR/mario_land/Clips"
OUTPUT_DIR="$SCRIPT_DIR/mario_land/Output"
TMP_DIR="$(mktemp -d)"

# ── Settings ────────────────────────────────────────────────────────────────
TRIP_TITLE="Mario Land"
TRIP_SUBTITLE="Family Trip Highlights"
HIGHLIGHT_SECS=12        # seconds to use from each clip
HIGHLIGHT_MODE="best"    # best=middle-third | start | middle
WIDTH=1920
HEIGHT=1080
FPS=30
FONT="/System/Library/Fonts/Helvetica.ttc"
# ────────────────────────────────────────────────────────────────────────────

notify() {
    osascript -e "display notification \"$1\" with title \"Mario Land Bot\"" 2>/dev/null || true
}

if ! command -v ffmpeg &>/dev/null; then
    echo "ERROR: FFmpeg not found."
    echo "Install it by running:  brew install ffmpeg"
    notify "FFmpeg not found — see setup instructions"
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Collect clips (sorted by filename)
CLIPS=()
while IFS= read -r -d '' f; do
    CLIPS+=("$f")
done < <(find "$CLIPS_DIR" -maxdepth 1 \
    \( -iname "*.mp4" -o -iname "*.mov" -o -iname "*.avi" -o -iname "*.mkv" -o -iname "*.m4v" \) \
    -print0 | sort -z)

TOTAL=${#CLIPS[@]}
if [ "$TOTAL" -eq 0 ]; then
    echo "No clips found in mario_land/Clips/"
    exit 0
fi

echo "Found $TOTAL clip(s). Building highlight reel..."
notify "Processing $TOTAL clips..."

PARTS=()

# ── Intro title card ─────────────────────────────────────────────────────────
INTRO="$TMP_DIR/00_intro.mp4"
ffmpeg -y \
    -f lavfi -i "color=c=0x0A0A0A:size=${WIDTH}x${HEIGHT}:rate=$FPS:duration=4" \
    -vf "drawtext=fontfile='$FONT':text='$TRIP_TITLE':fontsize=96:fontcolor=white:x=(w-text_w)/2:y=h*0.32,
         drawtext=fontfile='$FONT':text='$TRIP_SUBTITLE':fontsize=46:fontcolor=#cccccc:x=(w-text_w)/2:y=h*0.54,
         fade=in:0:30,fade=out:st=3:d=1" \
    -c:v libx264 -preset fast -crf 23 -an "$INTRO" -loglevel quiet
PARTS+=("$INTRO")

# ── Process each clip ─────────────────────────────────────────────────────────
for i in "${!CLIPS[@]}"; do
    CLIP="${CLIPS[$i]}"
    NUM=$((i + 1))
    BASENAME=$(basename "$CLIP")
    NAME=$(basename "$CLIP" | sed 's/\.[^.]*$//' | tr '_-' '  ' | \
           awk '{for(i=1;i<=NF;i++){$i=toupper(substr($i,1,1)) substr($i,2)}; print}')
    SAFE_NAME=$(echo "$NAME" | sed "s/'/\\\\\\\\'/g" | sed 's/\[/\\[/g' | sed 's/\]/\\]/g' | sed 's/:/\\:/g')
    SCENE_TEXT="Scene $NUM of $TOTAL"

    echo "  [$NUM/$TOTAL] $BASENAME"

    # Get duration
    DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$CLIP" 2>/dev/null)
    if [ -z "$DURATION" ]; then
        echo "    WARNING: could not read duration, skipping"
        continue
    fi

    # Calculate start time based on highlight mode
    case "$HIGHLIGHT_MODE" in
        start)  START=0 ;;
        middle) START=$(awk "BEGIN {s=$DURATION/2 - $HIGHLIGHT_SECS/2; print (s<0)?0:s}") ;;
        best)   START=$(awk "BEGIN {print $DURATION/3}") ;;
    esac

    # Storyboard title card
    TITLE_OUT="$TMP_DIR/${NUM}_title.mp4"
    ffmpeg -y \
        -f lavfi -i "color=c=0x0F0F0F:size=${WIDTH}x${HEIGHT}:rate=$FPS:duration=2.5" \
        -vf "drawtext=fontfile='$FONT':text='$SAFE_NAME':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=h*0.38,
             drawtext=fontfile='$FONT':text='$SCENE_TEXT':fontsize=36:fontcolor=#888888:x=(w-text_w)/2:y=h*0.57,
             fade=in:0:8,fade=out:st=2:d=0.5" \
        -c:v libx264 -preset fast -crf 23 -an "$TITLE_OUT" -loglevel quiet
    PARTS+=("$TITLE_OUT")

    # Highlight segment with fade in/out
    CLIP_OUT="$TMP_DIR/${NUM}_clip.mp4"
    FADE_OUT_START=$(awk "BEGIN {t=$HIGHLIGHT_SECS-1; print (t<0)?0:t}")
    ffmpeg -y -ss "$START" -t "$HIGHLIGHT_SECS" -i "$CLIP" \
        -vf "scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},
             fade=in:0:9,fade=out:st=${FADE_OUT_START}:d=1" \
        -c:v libx264 -preset fast -crf 23 \
        -c:a aac -b:a 128k \
        "$CLIP_OUT" -loglevel quiet
    PARTS+=("$CLIP_OUT")
done

# ── Outro ─────────────────────────────────────────────────────────────────────
OUTRO="$TMP_DIR/99_outro.mp4"
ffmpeg -y \
    -f lavfi -i "color=c=0x0A0A0A:size=${WIDTH}x${HEIGHT}:rate=$FPS:duration=3" \
    -vf "drawtext=fontfile='$FONT':text='The End':fontsize=80:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2,
         fade=in:0:15" \
    -c:v libx264 -preset fast -crf 23 -an "$OUTRO" -loglevel quiet
PARTS+=("$OUTRO")

# ── Concatenate ───────────────────────────────────────────────────────────────
CONCAT_LIST="$TMP_DIR/concat.txt"
for f in "${PARTS[@]}"; do
    echo "file '$f'" >> "$CONCAT_LIST"
done

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT_FILE="$OUTPUT_DIR/mario_land_${TIMESTAMP}.mp4"

echo ""
echo "Rendering final video → $OUTPUT_FILE"
ffmpeg -y -f concat -safe 0 -i "$CONCAT_LIST" \
    -c:v libx264 -preset medium -crf 23 \
    -c:a aac -b:a 128k \
    "$OUTPUT_FILE" -loglevel quiet -stats

rm -rf "$TMP_DIR"

echo ""
echo "Done! Output saved to: mario_land/Output/"
notify "Highlight reel ready in mario_land/Output!"
