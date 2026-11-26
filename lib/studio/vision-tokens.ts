import type { AgentImage } from "./types";

const patch = 14;
const cell = patch * 3;
const cap = 1024;
const pixelFloor = 544 * 544;
const cells = (length: number) => Math.ceil(length / cell);
const gridTokens = (width: number, height: number) => cells(height) * (cells(width) + 1) + 2;

/** Same image grid as the reference DeepSeek adapter, measured on the image we send. */
export function deepSeekVisionTokens({ width, height }: Pick<AgentImage, "width" | "height">): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return cap;
  for (let iteration = 0; iteration < 10; iteration++) {
    const scale = Math.sqrt(Math.max(1, pixelFloor / (width * height)));
    const scaledWidth = Math.trunc(width * scale), scaledHeight = Math.trunc(height * scale);
    let nextWidth = Math.ceil(scaledWidth / patch) * patch, nextHeight = Math.ceil(scaledHeight / patch) * patch;
    if (gridTokens(nextWidth, nextHeight) > cap) {
      const aspect = scaledHeight / scaledWidth;
      const idealWidth = Math.sqrt((cap - 2) / aspect + .25) - .5;
      const idealHeight = idealWidth * aspect;
      if (idealWidth < 1) { nextWidth = cell; nextHeight = Math.floor((cap - 2) / 2) * cell; }
      else if (idealHeight < 1) { nextWidth = (cap - 3) * cell; nextHeight = cell; }
      else {
        const fit = Math.min(Math.floor(idealWidth) * cell / scaledWidth, Math.floor(idealHeight) * cell / scaledHeight);
        nextWidth = Math.floor(scaledWidth * fit / patch) * patch;
        nextHeight = Math.floor(scaledHeight * fit / patch) * patch;
      }
    }
    if (nextWidth === width && nextHeight === height) return gridTokens(width, height);
    width = nextWidth;
    height = nextHeight;
  }
  return cap;
}

export type ImageTokenPrice = (image: AgentImage) => number;
export const conservativeImagePrice: ImageTokenPrice = () => cap;

export function requestImagePricing(baseUrl: string) {
  const official = new URL(baseUrl).origin === "https://api.deepseek.com";
  return official ? { key: "deepseek-grid-v1", price: deepSeekVisionTokens } : { key: "inline-1024-v1", price: conservativeImagePrice };
}
