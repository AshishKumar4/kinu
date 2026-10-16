/**
 * Pages an agent drives on a real box's desktop (D89), each naming what it saw in its title, which the window manager
 * shows and `xdotool getwindowname` reads back. Each fills the screen, so a point lands on its target whatever bar the
 * browser draws above it.
 */

const PAGE = (title: string, body: string, script: string) => `<!doctype html><meta charset=utf-8><title>${title}</title>
<style>html,body{margin:0;height:100%;overflow:hidden;font:16px sans-serif}</style>${body}<script>const say=(t)=>{document.title=t;};${script}</script>`;

/** A 3×3 grid: each cell names the click, right-click, double-click, shift-click or hover it took. */
export const GRID = PAGE('ready grid', '<div id=g style="display:grid;grid-template:repeat(3,1fr)/repeat(3,1fr);height:100vh"></div>', `
const g=document.getElementById('g');
for(let i=0;i<9;i++){const d=document.createElement('div');d.id='c'+i;d.style.border='1px solid #888';g.append(d);}
g.addEventListener('mouseover',e=>say('over '+e.target.id));
g.addEventListener('click',e=>say(['click',e.target.id,e.detail,e.shiftKey?'shift':''].join(' ').trim()));
g.addEventListener('contextmenu',e=>{e.preventDefault();say('right '+e.target.id);});
g.addEventListener('dblclick',e=>say('double '+e.target.id));`);

/** A textarea filling the screen: its value, as JSON. */
export const TEXT = PAGE('ready text', '<textarea id=t autofocus style="box-sizing:border-box;width:100vw;height:100vh"></textarea>',
  `const t=document.getElementById('t');t.addEventListener('input',()=>say('text '+JSON.stringify(t.value)));`);

/** Content larger than the screen both ways, scrolled by the window itself: how far it scrolled. */
export const SCROLL = `<!doctype html><meta charset=utf-8><title>ready scroll</title><style>body{margin:0}</style>
<div style="width:5000px;height:5000px"></div><script>addEventListener('scroll',()=>{document.title='scroll '+scrollX+' '+scrollY;});</script>`;

/** A range control across the whole screen's width, tall enough to take a point near its top: its value. */
export const RANGE = PAGE('ready range', '<input id=r type=range min=0 max=100 value=0 style="display:block;width:100vw;height:300px;margin:0">',
  `const r=document.getElementById('r');r.addEventListener('input',()=>say('range '+r.value));`);

/** How long a key was held: from its first press to its release, as the page saw them. */
export const HOLD = PAGE('ready hold', '<p>hold</p>', `let down=0;
addEventListener('keydown',(e)=>{if(!e.repeat){down=performance.now();say('down '+e.key);}});
addEventListener('keyup',(e)=>say('held '+e.key+' '+Math.round(performance.now()-down)));`);

/** The keys held down, by where they are on the keyboard, as the page sees them; `released` once all are up. */
export const CHORD = PAGE('ready chord', '<p>chord</p>', `const held=new Set();
addEventListener('keydown',(e)=>{e.preventDefault();held.add(e.code);say('held '+[...held].sort().join(' '));});
addEventListener('keyup',(e)=>{e.preventDefault();held.delete(e.code);if(held.size===0)say('released');});`);

/** A large count and a bar that change every 100 ms, so each frame of a watch shows something new. */
export const TICKER = PAGE('ready ticker', '<div id=n style="font:bold 200px sans-serif;padding:120px 300px"></div><div id=b style="position:absolute;top:600px;height:60px;background:#36c"></div>', `
let k=0;const n=document.getElementById('n'),b=document.getElementById('b');
setInterval(()=>{k+=1;n.textContent=String(k);b.style.width=(k*13%1280)+'px';},100);`);

/** A PNG data URL's size, from its header. */
export function sizeOf(url: string): [number, number] {
  const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');

  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

/** On the box, with the image's own Pillow: how many of a PNG's `cols`×`rows` tiles differ from every other. */
export const DISTINCT_PY = `import sys
from PIL import Image
image, cols, rows = Image.open(sys.argv[1]).convert('RGB'), int(sys.argv[2]), int(sys.argv[3])
w, h = image.width // cols, image.height // rows
print(len({image.crop((c * w, r * h, (c + 1) * w, (r + 1) * h)).tobytes() for r in range(rows) for c in range(cols)}))
`;

/** On the box, a ring of X's bell, as a program on the desktop rings it (an xterm's BEL, a capture by scrot without
 *  -z), waited on until the server has it. */
export const RING_PY = `import ctypes
x = ctypes.cdll.LoadLibrary('libX11.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
display = ctypes.c_void_p(x.XOpenDisplay(b':0'))
x.XBell(display, 0)
x.XSync(display, 0)`;

/** On the box, the X server's own answer to what is down: its keys' keycodes (XQueryKeymap) and its pointer's buttons
 *  (XQueryPointer's mask), as `keys … buttons …`; read only. */
export const DOWN_PY = `import ctypes
x = ctypes.cdll.LoadLibrary('libX11.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XDefaultRootWindow.restype = ctypes.c_ulong
display = ctypes.c_void_p(x.XOpenDisplay(b':0'))
keymap = ctypes.create_string_buffer(32)
x.XQueryKeymap(display, keymap)
keys = [at * 8 + bit for at, byte in enumerate(keymap.raw) for bit in range(8) if byte >> bit & 1]
root, child, mask = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_uint()
where = [ctypes.c_int() for _ in range(4)]
x.XQueryPointer(display, ctypes.c_ulong(x.XDefaultRootWindow(display)), ctypes.byref(root), ctypes.byref(child), *[ctypes.byref(c) for c in where], ctypes.byref(mask))
print('keys', *keys, 'buttons', *[button for button in range(1, 6) if mask.value >> (7 + button) & 1])
`;

/** The grid's cells' centres on a 1280-wide screen, as points safe under a bar of up to 100 px above the page. */
export const GRID_POINTS: ReadonlyArray<readonly [number, number]> = [150, 395, 645].flatMap((y) => [213, 640, 1067].map((x) => [x, y] as const));
