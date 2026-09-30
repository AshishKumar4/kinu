/** WCAG 2.x relative luminance, independent of the product theme registry. */
function luminance(hex: string): number {
  const channel = (index: number): number => {
    const value = Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;

    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);

  return (light + 0.05) / (dark + 0.05);
}

export function rgbHex(color: { toInts(): [number, number, number, number] }): string {
  const [red, green, blue] = color.toInts();

  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
