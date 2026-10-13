/**
 * The desktop's wallpaper (D85): a Python program the desktop's start writes into the box and runs once per X server.
 * It paints the root at the server's own size, the ground at once and then the whole picture, and leaves a root that
 * already holds one alone. Python, because the image carries it and no image tool; Chromium draws the mark, from the
 * SVG its host passes, so any mark draws as a browser draws it.
 */
export const WALLPAPER_PY = String.raw`"""The desktop's wallpaper, painted once on the X server's root: the ground, the accent's glow from the foot, the mark.

'python3 wallpaper.py MARK_SVG GROUND_TOP GROUND_FOOT GLOW PANEL_HEIGHT' paints the root of $DISPLAY at its own size,
whatever geometry the server started at: the ground at once, then the whole picture with the mark, which Chromium draws
from its own SVG. A root that already holds a wallpaper is left as it is. '--preview OUT.png WIDTH HEIGHT' writes the
picture to a file instead, without a server.
"""
import os
import socket
import struct
import subprocess
import sys
import tempfile
import zlib

BAYER = (0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5)

# The glow: its strength at the centre, its centre below the foot, and its reach, as fractions of the screen.
GLOW = {'strength': 0.17, 'y': 1.12, 'reach_x': 0.70, 'reach_y': 0.55}

# The mark's height as a fraction of the screen's.
MARK = 0.15


def rgb(hex_colour):
    return tuple(int(hex_colour[at:at + 2], 16) for at in (1, 3, 5))


def recv(sock, size):
    data = bytearray()
    while len(data) < size:
        part = sock.recv(size - len(data))
        if not part:
            raise SystemExit('wallpaper: the X server closed the connection')
        data += part
    return bytes(data)


class Root:
    """The X server's root window, through the few requests a wallpaper needs, over the server's own socket."""

    def __init__(self, display):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/tmp/.X11-unix/X' + display)
        self.sock.sendall(struct.pack('<BxHHHH2x', ord('l'), 11, 0, 0, 0))
        head = recv(self.sock, 8)
        body = recv(self.sock, struct.unpack_from('<H', head, 6)[0] * 4)
        if head[0] != 1:
            raise SystemExit('wallpaper: X refused the connection: ' + body[:head[1]].decode(errors='replace'))
        self.id_base, self.id_mask = struct.unpack_from('<II', body, 4)
        vendor, self.max_request = struct.unpack_from('<HH', body, 16)
        formats, byte_order = body[21], body[22]
        at = 32 + (vendor + 3) // 4 * 4
        bits = {body[at + 8 * n]: body[at + 8 * n + 1] for n in range(formats)}
        at += 8 * formats
        self.window, _, _, _, _, self.width, self.height = struct.unpack_from('<IIIIIHH', body, at)
        visual, self.depth, depths = struct.unpack_from('<I', body, at + 32)[0], body[at + 38], body[at + 39]
        masks = None
        at += 40
        for _ in range(depths):
            visuals = struct.unpack_from('<H', body, at + 2)[0]
            at += 8
            for _ in range(visuals):
                vid, red, green, blue = struct.unpack_from('<I4xIII', body, at)
                masks = (red, green, blue) if vid == visual else masks
                at += 24
        # The layout every TrueColor server on x86 uses, and the only one drawn: a pixel's bytes are B, G, R, unused.
        if bits.get(self.depth) != 32 or masks != (0xFF0000, 0xFF00, 0xFF) or byte_order != 0:
            raise SystemExit('wallpaper: a root of depth %d, %s bits, masks %s is not drawn' % (self.depth, bits.get(self.depth), masks))
        self.next_id = 1

    def new_id(self):
        resource = self.id_base | (self.next_id & self.id_mask)
        self.next_id += 1
        return resource

    def request(self, opcode, data_byte, payload):
        self.sock.sendall(struct.pack('<BBH', opcode, data_byte, 1 + len(payload) // 4) + payload)

    def reply(self):
        """The next reply; an error ends the run with its code."""
        while True:
            head = recv(self.sock, 32)
            if head[0] == 0:
                raise SystemExit('wallpaper: X error %d on request %d' % (head[1], head[10]))
            if head[0] == 1:
                return head + recv(self.sock, struct.unpack_from('<I', head, 4)[0] * 4)

    def atom(self, name):
        raw = name.encode()
        self.request(16, 0, struct.pack('<H2x', len(raw)) + raw + b'\0' * (-len(raw) % 4))
        return struct.unpack_from('<I', self.reply(), 8)[0]

    def holds(self, atom):
        """Whether the root names a wallpaper pixmap already."""
        self.request(20, 0, struct.pack('<IIIII', self.window, atom, 0, 0, 1))
        return struct.unpack_from('<I', self.reply(), 16)[0] == 1

    def sync(self):
        self.request(43, 0, b'')
        self.reply()

    def ground(self, colour):
        """The root's background as one colour, at once."""
        red, green, blue = colour
        self.request(2, 0, struct.pack('<III', self.window, 0x2, red << 16 | green << 8 | blue))
        self.request(61, 0, struct.pack('<IhhHH', self.window, 0, 0, 0, 0))
        self.sync()

    def paint(self, rows, atoms):
        """'rows' as the root's background pixmap, which the server keeps after this client leaves."""
        pixmap, gc = self.new_id(), self.new_id()
        self.request(53, self.depth, struct.pack('<IIHH', pixmap, self.window, self.width, self.height))
        self.request(55, 0, struct.pack('<III', gc, pixmap, 0))
        per_request = max(1, (self.max_request * 4 - 24) // (self.width * 4))
        for top in range(0, self.height, per_request):
            band = b''.join(rows[top:top + per_request])
            count = len(band) // (self.width * 4)
            self.request(72, 2, struct.pack('<IIHHhhBB2x', pixmap, gc, self.width, count, 0, top, 0, self.depth) + band)
        self.request(2, 0, struct.pack('<III', self.window, 0x1, pixmap))
        self.request(61, 0, struct.pack('<IhhHH', self.window, 0, 0, 0, 0))
        for atom in atoms:
            self.request(18, 0, struct.pack('<IIIB3xI', self.window, atom, 20, 32, 1) + struct.pack('<I', pixmap))
        # RetainPermanent: the pixmap outlives this connection.
        self.request(112, 1, b'')
        self.sync()


def png_rows(path):
    """An 8-bit RGB or RGBA PNG's pixels: its width, height and rows of RGBA bytes."""
    data, at, idat = open(path, 'rb').read(), 8, b''
    while at < len(data):
        length, kind = struct.unpack_from('>I4s', data, at)
        chunk = data[at + 8:at + 8 + length]
        if kind == b'IHDR':
            width, height, depth, colour, _, _, interlace = struct.unpack('>IIBBBBB', chunk)
            if depth != 8 or colour not in (2, 6) or interlace:
                raise SystemExit('wallpaper: Chromium wrote a PNG of depth %d, colour type %d' % (depth, colour))
        elif kind == b'IDAT':
            idat += chunk
        at += 12 + length
    raw, step = zlib.decompress(idat), 4 if colour == 6 else 3
    stride, rows, prior = width * step, [], bytearray(width * step)
    for y in range(height):
        kind, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for x in range(stride):
            left = line[x - step] if x >= step else 0
            up, corner = prior[x], prior[x - step] if x >= step else 0
            if kind == 1:
                line[x] = (line[x] + left) & 255
            elif kind == 2:
                line[x] = (line[x] + up) & 255
            elif kind == 3:
                line[x] = (line[x] + (left + up) // 2) & 255
            elif kind == 4:
                guess = left + up - corner
                near = min((abs(guess - left), 0, left), (abs(guess - up), 1, up), (abs(guess - corner), 2, corner))
                line[x] = (line[x] + near[2]) & 255
        prior = line
        rows.append(bytes(line) if step == 4 else b''.join(bytes(line[x:x + 3]) + b'\xff' for x in range(0, stride, 3)))
    return width, height, rows


def mark_rows(svg, size):
    """The mark at 'size' pixels square, drawn by Chromium on a transparent page: rows of RGBA."""
    body = svg.replace('<svg ', '<svg width="%d" height="%d" ' % (size, size), 1)
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR', '/var/tmp')) as scratch:
        # A profile of its own: a person's Chromium on the desktop holds the default one.
        page, shot = os.path.join(scratch, 'mark.html'), os.path.join(scratch, 'mark.png')
        with open(page, 'w') as out:
            out.write('<!doctype html><html><body style="margin:0;background:transparent">' + body + '</body></html>')
        side = max(size, 200)
        subprocess.run(['timeout', '60', 'chromium', '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
                        '--force-device-scale-factor=1', '--default-background-color=00000000',
                        '--user-data-dir=' + os.path.join(scratch, 'profile'),
                        '--window-size=%d,%d' % (side, side), '--screenshot=' + shot, 'file://' + page],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        width, height, rows = png_rows(shot)
    if width < size or height < size:
        raise SystemExit('wallpaper: Chromium drew the mark at %dx%d, not %d square' % (width, height, size))
    return [row[:size * 4] for row in rows[:size]]


def picture(width, height, top, foot, glow, panel, mark):
    """Rows of B, G, R, unused bytes: the ground falling from top to foot, the glow, dithered, and the mark centred
    above the panel."""
    centre, reach_x = width / 2, width * GLOW['reach_x']
    dx2 = [((x + 0.5 - centre) / reach_x) ** 2 for x in range(width)]
    rows = []
    for y in range(height):
        fall = y / max(1, height - 1)
        base = [a + (b - a) * fall for a, b in zip(top, foot)]
        dy2 = ((y + 0.5 - height * GLOW['y']) / (height * GLOW['reach_y'])) ** 2
        bayer = [(BAYER[(y & 3) * 4 + k] + 0.5) / 16 for k in range(4)]
        if dy2 >= 1:
            # No glow on this row: four dithered pixels, repeated.
            tile = bytes(v for k in range(4) for v in (int(base[2] + bayer[k]), int(base[1] + bayer[k]), int(base[0] + bayer[k]), 0))
            rows.append(bytearray((tile * (width // 4 + 1))[:width * 4]))
            continue
        line = bytearray(width * 4)
        for x in range(width):
            d2 = dx2[x] + dy2
            s = GLOW['strength'] * (1 - d2 ** 0.5) if d2 < 1 else 0.0
            n = bayer[x & 3]
            line[x * 4] = int(base[2] + (glow[2] - base[2]) * s + n)
            line[x * 4 + 1] = int(base[1] + (glow[1] - base[1]) * s + n)
            line[x * 4 + 2] = int(base[0] + (glow[0] - base[0]) * s + n)
        rows.append(line)
    if mark:
        size = len(mark)
        left, top_row = (width - size) // 2, (height - panel - size) // 2
        for row, pixels in enumerate(mark):
            line = rows[top_row + row]
            for column in range(size):
                alpha = pixels[column * 4 + 3]
                if alpha:
                    at = (left + column) * 4
                    for channel in range(3):
                        under, over = line[at + 2 - channel], pixels[column * 4 + channel]
                        line[at + 2 - channel] = (over * alpha + under * (255 - alpha)) // 255
    return [bytes(row) for row in rows]


def write_png(path, rows, width, height):
    raw = b''.join(b'\0' + bytes(v for x in range(width) for v in (row[x * 4 + 2], row[x * 4 + 1], row[x * 4])) for row in rows)
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)
    with open(path, 'wb') as out:
        out.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
                  + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


def main():
    svg_path, top, foot, glow, panel = sys.argv[1:6]
    top, foot, glow, panel = rgb(top), rgb(foot), rgb(glow), int(panel)
    svg = open(svg_path).read() if os.path.getsize(svg_path) else ''
    if '--preview' in sys.argv:
        at = sys.argv.index('--preview')
        out, width, height = sys.argv[at + 1], int(sys.argv[at + 2]), int(sys.argv[at + 3])
        write_png(out, picture(width, height, top, foot, glow, panel, mark_rows(svg, round(height * MARK)) if svg else None), width, height)
        return
    root = Root(os.environ.get('DISPLAY', ':0').lstrip(':').split('.')[0])
    atoms = [root.atom('_XROOTPMAP_ID'), root.atom('ESETROOT_PMAP_ID')]
    if root.holds(atoms[0]):
        return
    root.ground(top)
    mark = mark_rows(svg, round(root.height * MARK)) if svg else None
    root.paint(picture(root.width, root.height, top, foot, glow, panel, mark), atoms)


if __name__ == '__main__':
    main()
`;
