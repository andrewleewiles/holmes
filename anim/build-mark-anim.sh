#!/usr/bin/env bash
#
# Builds the animated Holmes mark used for the assistant's thinking/talking
# states from the After Effects PNG exports in talking/ and thinking/.
#
# The exports are flat-colour logo-on-black RGB frames. Three things have to be
# fixed before they can be used as UI assets:
#
#   1. Extract the logo.   The black is both the backdrop *and* the negative
#      space inside the mark (the smoke gaps), so coverage is recovered from the
#      green channel: alpha = G / G_of_the_solid_colour. Edge pixels are a
#      black-to-colour blend, so that ratio is exactly the anti-aliased alpha.
#
#   2. Unify colour.       talking rendered at #47A08F (brand primary), thinking
#      at #31786B (primary-dark). Rather than baking either in, the frames ship
#      as alpha masks and the renderer paints them with --color-holmes-primary,
#      so #47a08f lives in exactly one place (styles/index.css).
#
#   3. Unify sizing.       thinking was composed ~7% smaller and slightly offset.
#      The transform below was solved by matching the nose/brow profile, which is
#      the one feature static in *both* clips (talking articulates the jaw and
#      pipe; thinking churns the whole smoke interior).
#
# Output: horizontal sprite strips + a first-frame still, for CSS steps().
#
set -euo pipefail
cd "$(dirname "$0")"

OUT=../assets/anim
# Per-frame box. The strips are inlined as data: URLs (see AnimatedMark), so
# this trades bundle bytes against sharpness; 96 is still crisp at 2x DPR for
# every place the mark is drawn today (largest is the 28 px message avatar).
FRAME=96

# --- geometry solved against the talking clip's coordinate frame ---------------
CROP=828x828+530+120      # square box enclosing both clips' full extent
T_CENTER="943,535"        # talking logo centre, the scaling origin
K_SCALE=1.07              # thinking -> talking scale
K_CENTER="933,523"        # == T_CENTER translated by (-10,-12)

# --- per-clip solid-colour green level, as a % of full scale -------------------
# talking #47A08F -> G=0xA0=160 -> 62.745%   thinking #31786B -> G=0x78=120 -> 47.059%
# (case, not an assoc array -- macOS ships bash 3.2)
green_level() {
  case "$1" in
    talking)  echo 62.745 ;;
    thinking) echo 47.059 ;;
  esac
}

mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

for CLIP in talking thinking; do
  echo "building $CLIP ..."
  mkdir -p "$WORK/$CLIP"
  LEVEL=$(green_level "$CLIP")
  n=0
  for f in "$CLIP"/*.png; do
    # thinking needs the normalising transform; talking is already the reference
    if [ "$CLIP" = thinking ]; then
      XFORM=(-virtual-pixel black -distort SRT "$T_CENTER $K_SCALE 0 $K_CENTER")
    else
      XFORM=()
    fi
    magick "$f" \
      -channel G -separate +channel \
      -level "0,${LEVEL}%" \
      ${XFORM[@]+"${XFORM[@]}"} +repage \
      -crop "$CROP" +repage \
      -resize "${FRAME}x${FRAME}" \
      -alpha off \
      "$WORK/$CLIP/$(printf '%04d' $n).png"
    n=$((n + 1))
  done

  # -alpha copy pushes the coverage into alpha while leaving it in RGB too, so
  # the strip reads correctly as a CSS mask under both alpha and luminance modes
  magick "$WORK/$CLIP"/*.png +append -alpha copy -strip "$OUT/holmes-$CLIP.png"
  magick "$WORK/$CLIP/0000.png" -alpha copy -strip "$OUT/holmes-$CLIP-still.png"
  echo "  $CLIP: $n frames -> $(identify -format '%wx%h' "$OUT/holmes-$CLIP.png")"
done

echo
echo "frame counts (keep MARK_ANIM in src/renderer/components/AnimatedMark.tsx in sync):"
for CLIP in talking thinking; do
  w=$(identify -format '%w' "$OUT/holmes-$CLIP.png")
  echo "  $CLIP = $((w / FRAME)) frames"
done
