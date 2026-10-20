/** Where an `<img>` reads a picture the app addresses by path: the path itself. The design gallery answers its
 *  fixtures' pictures from files of its own instead (gallery-pictures.ts, by alias in gallery.vite.config.ts). */
export function pictureSrc(path: string): string {
  return path;
}
