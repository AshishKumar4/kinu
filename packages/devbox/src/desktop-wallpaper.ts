/**
 * The desktop's wallpaper (D88, D96): a Python program the desktop's start writes into the box and runs once per X
 * server. Pillow composes the picture at the screen's own size, rsvg-convert draws the mark from the SVG the box's
 * class passes, and xwallpaper sets it on the root, where the server keeps it. KasmVNC has RandR and no Xinerama:
 * hsetroot, which finds the screen through Xinerama, painted black.
 */
export const WALLPAPER_PY = String.raw`"""The desktop's wallpaper: the ground, the accent's glow from the foot, the mark.

'python3 wallpaper.py MARK_SVG GROUND_TOP GROUND_FOOT GLOW PANEL_HEIGHT' sets the root of $DISPLAY at its own size.
'--preview OUT.png WIDTH HEIGHT' writes the picture to a file instead, without a server.
"""
import os
import subprocess
import sys
import tempfile

from PIL import Image

# The glow: its strength at the centre, its centre below the foot, and its reach, as fractions of the screen.
GLOW = {'strength': 0.17, 'y': 1.12, 'reach_x': 0.70, 'reach_y': 0.55}

# The mark's height as a fraction of the screen's.
MARK = 0.15


def rgb(hex_colour):
    return tuple(int(hex_colour[at:at + 2], 16) for at in (1, 3, 5))


def picture(width, height, top, foot, glow, panel, svg):
    """The ground falling from top to foot, the glow rising from below the foot, and the mark centred above the panel."""
    fall = Image.linear_gradient('L').resize((width, height))
    ground = Image.composite(Image.new('RGB', (width, height), foot), Image.new('RGB', (width, height), top), fall)
    # radial_gradient is 0 at its centre and 255 at its corners, so 255 / sqrt(2) at its edges' midpoints (measured,
    # Pillow 12): the glow fades from its centre to nothing at its reach.
    reach = (round(width * GLOW['reach_x'] * 2), round(height * GLOW['reach_y'] * 2))
    edge = 255 / 2 ** 0.5
    fade = Image.radial_gradient('L').point(lambda d: round(255 * GLOW['strength'] * max(0, 1 - d / edge))).resize(reach)
    layer = Image.new('L', (width, height), 0)
    layer.paste(fade, (round(width / 2 - reach[0] / 2), round(height * GLOW['y'] - reach[1] / 2)))
    picture = Image.composite(Image.new('RGB', (width, height), glow), ground, layer)
    if svg:
        size = round(height * MARK)
        with tempfile.TemporaryDirectory() as scratch:
            drawn = os.path.join(scratch, 'mark.png')
            subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), '-o', drawn, svg], check=True)
            mark = Image.open(drawn).convert('RGBA')
            picture.paste(mark, ((width - size) // 2, (height - panel - size) // 2), mark)
    return picture


def main():
    svg, top, foot, glow, panel = sys.argv[1:6]
    top, foot, glow, panel = rgb(top), rgb(foot), rgb(glow), int(panel)
    svg = svg if os.path.getsize(svg) else None
    if '--preview' in sys.argv:
        at = sys.argv.index('--preview')
        picture(int(sys.argv[at + 2]), int(sys.argv[at + 3]), top, foot, glow, panel, svg).save(sys.argv[at + 1])
        return
    width, height = (int(n) for n in subprocess.run(['xdotool', 'getdisplaygeometry'], check=True, capture_output=True, text=True).stdout.split())
    out = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'wallpaper.png')
    picture(width, height, top, foot, glow, panel, svg).save(out)
    subprocess.run(['xwallpaper', '--zoom', out], check=True)


if __name__ == '__main__':
    main()
`;
