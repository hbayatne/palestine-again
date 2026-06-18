#!/usr/bin/env python3
"""
Mario Land Family Trip Video Bot
Drop clips into mario_land/, run: python bot.py
Add --preview flag to do a quick 3-clip test run.
"""

import argparse
import sys
from pathlib import Path

import yaml
from moviepy.editor import (
    AudioFileClip,
    ColorClip,
    CompositeVideoClip,
    TextClip,
    VideoFileClip,
    concatenate_videoclips,
)

DEFAULTS = {
    "input_dir": "mario_land",
    "output_dir": "output",
    "output_filename": "mario_land_highlights.mp4",
    "highlight_seconds_per_clip": 12,
    "highlight_mode": "best",       # "start" | "middle" | "best" (middle-third)
    "title_card_duration": 2.5,
    "intro_duration": 4.0,
    "outro_duration": 3.0,
    "transition_seconds": 0.6,
    "background_music": None,
    "music_volume": 0.25,
    "output_width": 1920,
    "output_height": 1080,
    "fps": 30,
    "trip_title": "Mario Land",
    "trip_subtitle": "Family Trip Highlights",
    "render_quality": "medium",     # ultrafast | fast | medium | slow
    "crf": 23,                      # 18=high quality, 28=smaller file
}

VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".m4v", ".webm",
                    ".MP4", ".MOV", ".AVI", ".MKV", ".M4V", ".WEBM"}


def load_config(path: Path) -> dict:
    cfg = DEFAULTS.copy()
    if path.exists():
        with open(path) as f:
            overrides = yaml.safe_load(f) or {}
        cfg.update(overrides)
    return cfg


def get_video_files(input_dir: Path) -> list:
    return sorted([f for f in input_dir.iterdir() if f.suffix in VIDEO_EXTENSIONS])


def resize_and_crop(clip, width: int, height: int):
    target_ratio = width / height
    if (clip.w / clip.h) > target_ratio:
        clip = clip.resize(height=height)
        clip = clip.crop(x_center=clip.w / 2, width=width)
    else:
        clip = clip.resize(width=width)
        clip = clip.crop(y_center=clip.h / 2, height=height)
    return clip


def trim_highlight(clip, duration: float, mode: str):
    if clip.duration <= duration:
        return clip
    if mode == "start":
        return clip.subclip(0, duration)
    elif mode == "middle":
        mid = clip.duration / 2
        return clip.subclip(max(0, mid - duration / 2), min(clip.duration, mid + duration / 2))
    else:  # "best" — middle third tends to have the most action
        start = clip.duration / 3
        return clip.subclip(start, min(start + duration, clip.duration - 0.1))


def text_clip(text: str, fontsize: int, color: str, width: int, duration: float, y_pos):
    return (
        TextClip(text, fontsize=fontsize, color=color,
                 size=(width, None), method="caption")
        .set_duration(duration)
        .set_position(("center", y_pos), relative=True)
    )


def make_title_card(label: str, sublabel: str, duration: float, size: tuple) -> CompositeVideoClip:
    w, h = size
    bg = ColorClip(size=size, color=(15, 15, 15), duration=duration)
    main = text_clip(label, 64, "white", w - 120, duration, 0.38)
    sub = text_clip(sublabel, 36, "#999999", w - 200, duration, 0.58)
    return CompositeVideoClip([bg, main, sub]).fadein(0.25).fadeout(0.25)


def make_intro(title: str, subtitle: str, duration: float, size: tuple) -> CompositeVideoClip:
    w, h = size
    bg = ColorClip(size=size, color=(10, 10, 10), duration=duration)
    t = text_clip(title, 100, "white", w - 100, duration, 0.32)
    s = text_clip(subtitle, 48, "#cccccc", w - 150, duration, 0.54)
    return CompositeVideoClip([bg, t, s]).fadein(0.5).fadeout(0.5)


def make_outro(duration: float, size: tuple) -> CompositeVideoClip:
    w, h = size
    bg = ColorClip(size=size, color=(10, 10, 10), duration=duration)
    t = text_clip("The End", 80, "white", w - 100, duration, 0.42)
    return CompositeVideoClip([bg, t]).fadein(0.5)


def build_reel(cfg: dict, preview: bool = False):
    input_dir = Path(cfg["input_dir"])
    output_dir = Path(cfg["output_dir"])
    size = (cfg["output_width"], cfg["output_height"])

    if not input_dir.exists():
        input_dir.mkdir(parents=True)
        print(f"Created '{input_dir}/' — add your video clips there and run again.")
        return

    video_files = get_video_files(input_dir)
    if not video_files:
        print(f"No video files found in '{input_dir}/'")
        print(f"Supported formats: {', '.join(sorted(VIDEO_EXTENSIONS))}")
        return

    if preview:
        video_files = video_files[:3]
        print(f"Preview mode: processing {len(video_files)} clip(s)\n")
    else:
        print(f"Found {len(video_files)} clip(s). Building highlight reel...\n")

    all_clips = [make_intro(cfg["trip_title"], cfg["trip_subtitle"], cfg["intro_duration"], size)]

    for i, vf in enumerate(video_files, 1):
        print(f"  [{i}/{len(video_files)}] {vf.name}")
        try:
            raw = VideoFileClip(str(vf))
        except Exception as e:
            print(f"    WARNING: skipping {vf.name} — {e}")
            continue

        clip = resize_and_crop(raw, *size)
        clip = trim_highlight(clip, cfg["highlight_seconds_per_clip"], cfg["highlight_mode"])
        clip = clip.fadein(0.3).fadeout(0.3)

        scene_name = vf.stem.replace("_", " ").replace("-", " ").title()
        scene_label = f"Scene {i} of {len(video_files)}"
        title_card = make_title_card(scene_name, scene_label, cfg["title_card_duration"], size)

        all_clips.append(title_card)
        all_clips.append(clip)

    all_clips.append(make_outro(cfg["outro_duration"], size))

    print("\nConcatenating...")
    final = concatenate_videoclips(all_clips, method="compose", padding=-cfg["transition_seconds"])

    if cfg.get("background_music"):
        music_path = Path(cfg["background_music"])
        if music_path.exists():
            print(f"Adding music: {music_path.name}")
            music = AudioFileClip(str(music_path)).volumex(cfg["music_volume"])
            if music.duration < final.duration:
                from moviepy.audio.fx.audio_loop import audio_loop
                music = audio_loop(music, nloops=int(final.duration / music.duration) + 1)
            music = music.subclip(0, final.duration)
            if final.audio:
                from moviepy.audio.AudioClip import CompositeAudioClip
                final = final.set_audio(CompositeAudioClip([final.audio, music]))
            else:
                final = final.set_audio(music)

    output_dir.mkdir(parents=True, exist_ok=True)
    fname = cfg["output_filename"]
    if preview:
        fname = fname.replace(".mp4", "_preview.mp4")
    out_path = output_dir / fname

    print(f"\nRendering → {out_path}  ({final.duration:.0f}s total)\n")
    final.write_videofile(
        str(out_path),
        fps=cfg["fps"],
        codec="libx264",
        audio_codec="aac",
        temp_audiofile="_tmp_audio.m4a",
        remove_temp=True,
        threads=4,
        preset=cfg["render_quality"],
        ffmpeg_params=["-crf", str(cfg["crf"])],
        logger="bar",
    )
    print(f"\nDone! → {out_path}")


def main():
    parser = argparse.ArgumentParser(description="Mario Land Family Trip Video Bot")
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--preview", action="store_true",
                        help="Quick test: process first 3 clips only")
    args = parser.parse_args()
    build_reel(load_config(Path(args.config)), preview=args.preview)


if __name__ == "__main__":
    main()
