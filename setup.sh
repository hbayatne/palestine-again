#!/bin/bash
# One-time setup: copies Mario Land bot to your iCloud Drive and configures
# it to run automatically whenever you drop videos into the Clips folder.
# Run this once on your Mac: bash setup.sh

set -e

ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
MARIO_LAND="$ICLOUD/Mario Land"
SCRIPT_SRC="$(cd "$(dirname "$0")" && pwd)/process_videos.sh"

echo "==================================="
echo "  Mario Land Bot Setup"
echo "==================================="
echo ""

# ── Step 1: FFmpeg ────────────────────────────────────────────────────────────
if ! command -v ffmpeg &>/dev/null; then
    echo "Installing FFmpeg (this takes a minute)..."
    # Add Homebrew to PATH for this session (Apple Silicon: /opt/homebrew, Intel: /usr/local)
    eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null || true
    if ! command -v brew &>/dev/null; then
        echo "Installing Homebrew first..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null || true
    fi
    brew install ffmpeg
    echo "FFmpeg installed."
else
    echo "FFmpeg already installed."
fi

# ── Step 2: Create iCloud folder structure ────────────────────────────────────
echo ""
echo "Creating Mario Land folder in iCloud Drive..."
mkdir -p "$MARIO_LAND/Clips"
mkdir -p "$MARIO_LAND/Output"

# Copy the processing script into the iCloud folder
cp "$SCRIPT_SRC" "$MARIO_LAND/process_videos.sh"
chmod +x "$MARIO_LAND/process_videos.sh"

# ── Step 3: Install LaunchAgent (auto-triggers on new files in Clips folder) ──
echo "Setting up automatic trigger..."

PLIST="$HOME/Library/LaunchAgents/com.mariolandbot.plist"

# Remove any old version
launchctl unload "$PLIST" 2>/dev/null || true

cat > "$PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.mariolandbot</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$MARIO_LAND/process_videos.sh</string>
    </array>
    <key>WatchPaths</key>
    <array>
        <string>$MARIO_LAND/Clips</string>
    </array>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/mario_land_bot.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/mario_land_bot.log</string>
</dict>
</plist>
PLIST

launchctl load "$PLIST"

echo ""
echo "==================================="
echo "  Setup Complete!"
echo "==================================="
echo ""
echo "Your Mario Land folder is ready in iCloud Drive."
echo ""
echo "  Drop clips into:  iCloud Drive → Mario Land → Clips"
echo "  Output appears in: iCloud Drive → Mario Land → Output"
echo ""
echo "The bot runs automatically when you add videos."
echo "You can also run it manually: bash '$MARIO_LAND/process_videos.sh'"
echo ""
