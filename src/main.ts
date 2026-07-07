/** Demo app — dogfoods the library exactly as a consumer would. */
import rgui, { demoGraph } from "./index";

const canvas = document.querySelector<HTMLCanvasElement>("#viewer")!;
const debug = document.querySelector<HTMLDivElement>("#debug")!;

rgui(canvas, { graph: demoGraph(), debug });
