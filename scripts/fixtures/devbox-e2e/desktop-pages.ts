import { inflateSync } from 'node:zlib';

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
addEventListener('keydown',(e)=>{if(!e.repeat)down=performance.now();});
addEventListener('keyup',(e)=>say('held '+e.key+' '+Math.round(performance.now()-down)));`);

/** A large count and a bar that change every 100 ms, so each frame of a watch shows something new. */
export const TICKER = PAGE('ready ticker', '<div id=n style="font:bold 200px sans-serif;padding:120px 300px"></div><div id=b style="position:absolute;top:600px;height:60px;background:#36c"></div>', `
let k=0;const n=document.getElementById('n'),b=document.getElementById('b');
setInterval(()=>{k+=1;n.textContent=String(k);b.style.width=(k*13%1280)+'px';},100);`);

/** A PNG an agent was answered, read: its size, and how many of its `cols`×`rows` tiles differ from every other. */
export interface Sheet {
  readonly size: [number, number];
  distinct(cols: number, rows: number): number;
}

export function sheet(url: string): Sheet {
  const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);

  return {
    size: [width, height],
    distinct(cols, rows) {
      // The box's own sheet: 8-bit RGB, no filter, one IDAT chunk; a screenshot (scrot's) is not read this way.
      const raw = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
      const stride = 1 + width * 3;
      const [tileW, tileH] = [width / cols, height / rows];

      const tiles = Array.from({ length: cols * rows }, (_, at) => {
        const [x, y] = [(at % cols) * tileW, Math.floor(at / cols) * tileH];

        return Array.from({ length: tileH }, (__, line) => raw.subarray((y + line) * stride + 1 + x * 3, (y + line) * stride + 1 + (x + tileW) * 3).toString('base64')).join('');
      });

      return new Set(tiles).size;
    },
  };
}

/** The grid's cells' centres on a 1280-wide screen, as points safe under a bar of up to 100 px above the page. */
export const GRID_POINTS: ReadonlyArray<readonly [number, number]> = [150, 395, 645].flatMap((y) => [213, 640, 1067].map((x) => [x, y] as const));
