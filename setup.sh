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

# ── Step 3: Install Folder Action (auto-triggers on new files) ────────────────
echo "Setting up automatic trigger..."

FA_SCRIPT_NAME="MarioLandBot.scpt"
FA_DIR="$HOME/Library/Scripts/Folder Action Scripts"
mkdir -p "$FA_DIR"

# Write the AppleScript folder action
cat > "$FA_DIR/$FA_SCRIPT_NAME" << 'APPLESCRIPT'
on adding folder items to this_folder after receiving these_items
    set folderPath to POSIX path of this_folder
    set scriptPath to folderPath & "process_videos.sh"

    -- Wait a moment for iCloud to finish syncing the file
    delay 5

    -- Run the processing script in the background
    do shell script "bash '" & scriptPath & "' >> /tmp/mario_land_bot.log 2>&1 &"
end adding folder items to this_folder
APPLESCRIPT

# Compile the AppleScript
osacompile -o "$FA_DIR/${FA_SCRIPT_NAME%.scpt}.scpt" "$FA_DIR/$FA_SCRIPT_NAME" 2>/dev/null || true

# Attach the folder action to the Clips folder
CLIPS_FOLDER="$MARIO_LAND/Clips"
osascript << OSASCRIPT
tell application "Finder"
    set targetFolder to POSIX file "$CLIPS_FOLDER" as alias
    try
        set folder actions enabled to true
        make new folder action at targetFolder with properties {name:"MarioLandBot", script name:"MarioLandBot"}
    end try
end tell
OSASCRIPT

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
