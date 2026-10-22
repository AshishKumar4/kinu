/**
 * Where an `<img>` reads a picture the app addresses by path: the path itself. A page that holds its pictures as files
 * of its own (the design gallery, `gallery-pictures.ts`) says so once at start, and its files are read for the paths
 * it holds.
 */
const answerers: ((path: string) => string | null)[] = [];

export function pictureSrc(path: string): string {
  return answerers.map((answer) => answer(path)).find((src) => src !== null) ?? path;
}

export function answerPictures(answer: (path: string) => string | null): void {
  answerers.push(answer);
}
