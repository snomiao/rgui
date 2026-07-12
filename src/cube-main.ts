import * as THREE from "three";
import "./cube.css";
import {
  CUBE_SIZE,
  createCubePuzzle,
  shuffled,
  type CubePuzzle,
} from "./cube/puzzle.js";
import {
  buildCubeRepresentation,
  type CubeRepresentation,
  type MergeMethod,
  type RgCell,
  type RgLevel,
  type ValueReducer,
} from "./cube/merge.js";
import {
  labelPresentation,
  type LabelEncoding,
} from "./cube/labelEncoding.js";
import {
  createNativeTranslator,
  getNativeTranslatorApi,
  preferredTargetLanguage,
  type NativeTextTranslator,
} from "./i18n/browserTranslator.js";
import { stereoPanelCameras, updateStereoCameras } from "./stereo/rig.js";
import { depthPlanePanScale, directionalFocusTarget, type FocusDirection } from "./cube/navigation.js";
import {
  createSpatialCursorChannel,
  createSpatialCursorState,
  reduceSpatialCursor,
  type SpatialCursorIntent,
} from "./cube/spatialCursor.js";

type Theme = "dark" | "light";
type ThemeChoice = Theme | "auto";
type StereoMode = "parallel" | "cross";

interface LayerVisual {
  depth: number;
  fill: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
}

interface CellVisual {
  fills: Array<{
    fill: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
    instanceIndex: number;
  }>;
  wireMaterials: THREE.LineBasicMaterial[];
  supportMaterials: THREE.LineBasicMaterial[];
  digitSprites: Array<{
    digit: "tens" | "ones";
    eye: "left" | "right";
    sprite: THREE.Sprite;
  }>;
  digitMaterials: THREE.SpriteMaterial[];
}

interface StereoChromePair {
  source: HTMLElement;
  mirror: HTMLElement;
  sourceElements: HTMLElement[];
  mirrorElements: HTMLElement[];
}

interface DragState {
  pointerId: number;
  button: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  mode: "orbit" | "depth-pan";
  depth: number;
}

const required = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
};

const canvas = required<HTMLCanvasElement>("#stereo-canvas");
const cubeApp = required<HTMLElement>("#cube-app");
const leftStereoCursor = required<HTMLElement>(".stereo-cursor-left");
const rightStereoCursor = required<HTMLElement>(".stereo-cursor-right");
const targetNumber = required<HTMLElement>("#target-number");
const progress = required<HTMLElement>("#progress");
const toast = required<HTMLElement>("#result-toast");
const layerRange = required<HTMLInputElement>("#layer-range");
const layerOutput = required<HTMLOutputElement>("#layer-output");
const stereoRange = required<HTMLInputElement>("#stereo-range");
const stereoOutput = required<HTMLOutputElement>("#stereo-output");
const opacityRange = required<HTMLInputElement>("#opacity-range");
const opacityOutput = required<HTMLOutputElement>("#opacity-output");
const labelEncodingSelect = required<HTMLSelectElement>("#label-encoding");
const mergeMethodSelect = required<HTMLSelectElement>("#merge-method");
const valueReducerSelect = required<HTMLSelectElement>("#value-reducer");
const rgLevelRange = required<HTMLInputElement>("#rg-level");
const rgLevelOutput = required<HTMLOutputElement>("#rg-level-output");
const rgReadout = required<HTMLOutputElement>("#rg-readout");
const resetViewButton = required<HTMLButtonElement>("#reset-view");
const newPuzzleButton = required<HTMLButtonElement>("#new-puzzle");
const peekButton = required<HTMLButtonElement>("#peek");
const themeButton = required<HTMLButtonElement>("#theme-toggle");
const translateButton = required<HTMLButtonElement>("#translate-toggle");
const helpButton = required<HTMLButtonElement>("#help-toggle");
const helpDialog = required<HTMLDialogElement>("#help-dialog");
const helpPanel = required<HTMLElement>(".help-panel");
const helpCloseButton = required<HTMLButtonElement>("#help-close");
const helpStartButton = required<HTMLButtonElement>("#help-start");
const missionLabel = required<HTMLElement>(".mission-label");
const leftEyeLabel = required<HTMLElement>("#left-eye-label");
const rightEyeLabel = required<HTMLElement>("#right-eye-label");
const topbar = required<HTMLElement>(".topbar");
const rgbar = required<HTMLElement>(".rgbar");
const controlbar = required<HTMLElement>(".controlbar");
const fingerStatus = required<HTMLOutputElement>("#finger-status");
const stereoModeButtons = [...document.querySelectorAll<HTMLButtonElement>(
  "[data-stereo-mode]",
)];

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.autoClear = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
const stereoCamera = new THREE.StereoCamera();
stereoCamera.aspect = 0.5;

const cubeRoot = new THREE.Group();
scene.add(cubeRoot);

const hemisphereLight = new THREE.HemisphereLight(0xe8ffff, 0x283038, 2.15);
scene.add(hemisphereLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 3.4);
keyLight.position.set(5, 7, 8);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xff9b7d, 1.65);
rimLight.position.set(-6, 2, -5);
scene.add(rimLight);

const CELL_SIZE = 0.86;
const CELL_SPACING = 1.04;
const CUBE_EXTENT = CELL_SPACING * (CUBE_SIZE - 1) + CELL_SIZE;
const boxGeometry = new THREE.BoxGeometry(CELL_SIZE, CELL_SIZE, CELL_SIZE);
const cellEdgesGeometry = new THREE.EdgesGeometry(boxGeometry);
const digitTextures = new Map<string, THREE.CanvasTexture>();
const layerVisuals: LayerVisual[] = [];
const cellVisuals = new Map<number, CellVisual>();
const raycastMeshes: THREE.InstancedMesh[] = [];

const outerMaterial = new THREE.LineBasicMaterial({
  color: 0x95a8af,
  transparent: true,
  opacity: 0.24,
});
const outerBounds = new THREE.LineSegments(
  new THREE.EdgesGeometry(
    new THREE.BoxGeometry(CUBE_EXTENT + 0.18, CUBE_EXTENT + 0.18, CUBE_EXTENT + 0.18),
  ),
  outerMaterial,
);
cubeRoot.add(outerBounds);

const floorGrid = new THREE.GridHelper(13, 13, 0x526168, 0x2b3439);
floorGrid.position.y = -CUBE_EXTENT / 2 - 0.42;
const floorMaterials = Array.isArray(floorGrid.material)
  ? floorGrid.material
  : [floorGrid.material];
for (const material of floorMaterials) {
  material.transparent = true;
  material.opacity = 0.22;
  material.depthWrite = false;
}
scene.add(floorGrid);

const hoverMaterial = new THREE.LineBasicMaterial({
  color: 0xffd447,
  transparent: true,
  opacity: 0.95,
});
const hoverOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(
    new THREE.BoxGeometry(CELL_SIZE + 0.08, CELL_SIZE + 0.08, CELL_SIZE + 0.08),
  ),
  hoverMaterial,
);
hoverOutline.visible = false;
hoverOutline.renderOrder = 20;
scene.add(hoverOutline);

const palettes = {
  dark: {
    background: 0x080a0c,
    layers: [0x39bdb2, 0xf1c84b, 0xf06f5e, 0x9b6bd3],
    solved: 0x65d77a,
    digit: 0xf7fbfc,
    outer: 0x95a8af,
    grid: 0x4f5c62,
  },
  light: {
    background: 0xdfe6e9,
    layers: [0x168f89, 0xb78305, 0xc64e42, 0x7546a8],
    solved: 0x258b43,
    digit: 0x253138,
    outer: 0x667981,
    grid: 0x86969d,
  },
} as const;

let currentTheme: Theme =
  document.documentElement.dataset.theme === "light" ? "light" : "dark";
let stereoMode: StereoMode =
  localStorage.getItem("rgui-stereo-mode") === "cross" ? "cross" : "parallel";
let mergeMethod: MergeMethod =
  localStorage.getItem("rgui-cube-merge") === "gaussian"
    ? "gaussian"
    : localStorage.getItem("rgui-cube-merge") === "graph"
      ? "graph"
      : "block";
let valueReducer: ValueReducer =
  localStorage.getItem("rgui-cube-reducer") === "sum"
    ? "sum"
    : localStorage.getItem("rgui-cube-reducer") === "median"
      ? "median"
      : "mean";
let labelEncoding: LabelEncoding =
  localStorage.getItem("rgui-cube-label-encoding") === "shared"
    ? "shared"
    : localStorage.getItem("rgui-cube-label-encoding") === "split"
      ? "split"
      : "matched";
let rgLevel: RgLevel = 0;
let ghostOpacity = Number(opacityRange.value) / 100;
let focusDepth: number | undefined;
let yaw = Math.PI / 4;
let pitch = 0.34;
let cameraDistance = 9.6;
const cameraTarget = new THREE.Vector3();
let frameMultiplier = 1;
let currentPuzzle: CubePuzzle;
let currentRepresentation: CubeRepresentation;
let targetCellIds: number[] = [];
let targetIndex = 0;
let solvedCellIds = new Set<number>();
let contentGroup: THREE.Group | undefined;
let hoveredCellId: number | undefined;
let toastTimer: number | undefined;
let wrongResetTimer: number | undefined;
let helpAnimationTimer: number | undefined;
let helpClosing = false;
let peekLocked = false;
let peekActive = false;
let peekPressStarted: number | undefined;
let activeTranslator: NativeTextTranslator | undefined;
let representationTransitionStart = 0;
let drag: DragState | undefined;
let pinchDistance: number | undefined;
let toastMirror: HTMLElement | undefined;
let stereoChromeSyncFrame: number | undefined;
let syncingChromeScroll = false;
let lastRenderTime = performance.now();
let spatialCursorState = createSpatialCursorState();
let spatialPinch: { startX: number; startY: number; lastX: number; lastY: number; moved: boolean; cellId?: number } | undefined;
const pointers = new Map<number, THREE.Vector2>();
const cellViewDepths = new Map<number, number>();
const stereoChromePairs: StereoChromePair[] = [];
const mirrorToSource = new WeakMap<HTMLElement, HTMLElement>();
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

function updateStereoCursors(clientX: number, clientY: number) {
  if (cubeApp.classList.contains("spatial-tracking")) return;
  const rect = cubeApp.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
    cubeApp.classList.remove("cursor-paired");
    return;
  }
  const halfWidth = rect.width / 2;
  const eyeX = x < halfWidth ? x : x - halfWidth;
  leftStereoCursor.style.transform = `translate3d(${eyeX - 9}px, ${y - 9}px, 0)`;
  rightStereoCursor.style.transform = `translate3d(${halfWidth + eyeX - 9}px, ${y - 9}px, 0)`;
  cubeApp.classList.add("cursor-paired");
}

function positionStereoCursor(element: HTMLElement, x: number, y: number) {
  element.style.transform = `translate3d(${x - 9}px, ${y - 9}px, 0)`;
}

function cellDistanceRange() {
  camera.updateMatrixWorld(true);
  cubeRoot.updateMatrixWorld(true);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const distances = currentRepresentation.cells.map((cell) =>
    latticePosition(cell.center).applyMatrix4(cubeRoot.matrixWorld).sub(camera.position).dot(forward),
  );
  return { near: Math.min(...distances), far: Math.max(...distances) };
}

function spatialCursorWorldPoint(x: number, y: number, depth: number) {
  updateCamera();
  pointerNdc.set(x * 2 - 1, 1 - y * 2);
  raycaster.setFromCamera(pointerNdc, camera);
  const range = cellDistanceRange();
  const planeDistance = THREE.MathUtils.lerp(range.near, range.far, depth);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const denominator = Math.max(0.05, raycaster.ray.direction.dot(forward));
  return raycaster.ray.at(planeDistance / denominator, new THREE.Vector3());
}

function updateSpatialStereoCursor(x: number, y: number, depth: number) {
  const point = spatialCursorWorldPoint(x, y, depth);
  updateStereoCameras(stereoCamera, camera);
  const [leftCamera, rightCamera] = stereoPanelCameras(stereoCamera, stereoMode);
  const rect = cubeApp.getBoundingClientRect();
  const halfWidth = rect.width / 2;
  const project = (eye: THREE.Camera, offset: number, element: HTMLElement) => {
    const ndc = point.clone().project(eye);
    positionStereoCursor(element, offset + (ndc.x * 0.5 + 0.5) * halfWidth, (-ndc.y * 0.5 + 0.5) * rect.height);
  };
  project(leftCamera, 0, leftStereoCursor);
  project(rightCamera, halfWidth, rightStereoCursor);
  cubeApp.classList.add("cursor-paired", "spatial-tracking");
  setFocusDepth(depth);
  updateHover(rect.left + x * halfWidth, rect.top + y * rect.height);
}

function setFingerStatus(state: "waiting" | "tracking" | "pinch") {
  fingerStatus.dataset.state = state === "waiting" ? "" : "tracking";
  fingerStatus.value = state === "waiting" ? "HAND · WAITING" : state === "pinch" ? "HAND · PINCH" : "HAND · TRACKING";
  scheduleStereoChromeSync();
}

function applySpatialIntent(intent: SpatialCursorIntent) {
  if (intent.kind === "rest") {
    spatialPinch = undefined;
    cubeApp.classList.remove("spatial-tracking", "cursor-pressed");
    setFingerStatus("waiting");
    return;
  }
  updateSpatialStereoCursor(intent.x, intent.y, intent.depth);
  if (intent.kind === "engage") setFingerStatus("tracking");
  if (intent.kind === "pinch-start") {
    spatialPinch = {
      startX: intent.x,
      startY: intent.y,
      lastX: intent.x,
      lastY: intent.y,
      moved: false,
      cellId: hoveredCellId,
    };
    cubeApp.classList.add("cursor-pressed");
    setFingerStatus("pinch");
    return;
  }
  if (intent.kind === "move" && spatialPinch) {
    const width = canvas.clientWidth / 2;
    const dx = (intent.x - spatialPinch.lastX) * width;
    const dy = (intent.y - spatialPinch.lastY) * canvas.clientHeight;
    spatialPinch.lastX = intent.x;
    spatialPinch.lastY = intent.y;
    if (Math.hypot((intent.x - spatialPinch.startX) * width, (intent.y - spatialPinch.startY) * canvas.clientHeight) > 24) spatialPinch.moved = true;
    const range = cellDistanceRange();
    const distance = THREE.MathUtils.lerp(range.near, range.far, intent.depth);
    const scale = depthPlanePanScale(distance, THREE.MathUtils.degToRad(camera.fov), canvas.clientHeight);
    cameraTarget.addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), -dx * scale);
    cameraTarget.addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion), dy * scale);
    updateCamera();
  }
  if (intent.kind === "pinch-end") {
    if (spatialPinch && !spatialPinch.moved && intent.durationMs <= 250 && spatialPinch.cellId !== undefined) {
      selectCell(spatialPinch.cellId);
    }
    spatialPinch = undefined;
    cubeApp.classList.remove("cursor-pressed");
    setFingerStatus("tracking");
  }
}

cubeApp.addEventListener("pointermove", (event) => {
  updateStereoCursors(event.clientX, event.clientY);
});
cubeApp.addEventListener("pointerdown", (event) => {
  updateStereoCursors(event.clientX, event.clientY);
  cubeApp.classList.add("cursor-pressed");
});
window.addEventListener("pointerup", () => {
  cubeApp.classList.remove("cursor-pressed");
});
cubeApp.addEventListener("pointerleave", () => {
  if (pointers.size === 0) cubeApp.classList.remove("cursor-paired");
});
const translatableElements = [
  ...document.querySelectorAll<HTMLElement>("[data-i18n]"),
];

for (const element of translatableElements) {
  element.dataset.i18nSource = element.textContent?.trim().replace(/\s+/g, " ") ?? "";
}

function copyChromeElement(
  source: HTMLElement,
  mirror: HTMLElement,
  isRoot: boolean,
) {
  mirror.className = isRoot
    ? source.className.replace(/\bstereo-left\b/g, "stereo-right")
    : source.className;
  mirror.hidden = source.hidden;

  for (const attribute of [
    "aria-label",
    "aria-pressed",
    "aria-busy",
    "title",
  ]) {
    const value = source.getAttribute(attribute);
    if (value === null) mirror.removeAttribute(attribute);
    else mirror.setAttribute(attribute, value);
  }

  if (source instanceof HTMLInputElement && mirror instanceof HTMLInputElement) {
    mirror.value = source.value;
    mirror.min = source.min;
    mirror.max = source.max;
    mirror.checked = source.checked;
  } else if (
    source instanceof HTMLSelectElement &&
    mirror instanceof HTMLSelectElement
  ) {
    mirror.value = source.value;
  } else if (
    source instanceof HTMLOutputElement &&
    mirror instanceof HTMLOutputElement
  ) {
    mirror.value = source.value;
  }

  if (source instanceof HTMLButtonElement && mirror instanceof HTMLButtonElement) {
    mirror.disabled = source.disabled;
  }
  if (!source.firstElementChild) mirror.textContent = source.textContent;
}

function syncStereoChrome() {
  stereoChromeSyncFrame = undefined;
  for (const pair of stereoChromePairs) {
    for (let index = 0; index < pair.sourceElements.length; index++) {
      const source = pair.sourceElements[index];
      const mirror = pair.mirrorElements[index];
      if (source && mirror) copyChromeElement(source, mirror, index === 0);
    }
  }
}

function scheduleStereoChromeSync() {
  if (stereoChromePairs.length === 0 || stereoChromeSyncFrame !== undefined) return;
  stereoChromeSyncFrame = requestAnimationFrame(syncStereoChrome);
}

function sourceForMirrorTarget(target: EventTarget | null) {
  const element = target instanceof Element ? target.closest<HTMLElement>("*") : null;
  return element ? mirrorToSource.get(element) : undefined;
}

function setupStereoChrome() {
  for (const source of [topbar, rgbar, controlbar]) {
    source.classList.add("stereo-chrome", "stereo-left");
    const mirror = source.cloneNode(true) as HTMLElement;
    mirror.classList.remove("stereo-left");
    mirror.classList.add("stereo-right");
    mirror.dataset.stereoCopy = "right";
    mirror.setAttribute("aria-hidden", "true");

    const sourceElements = [source, ...source.querySelectorAll<HTMLElement>("*")];
    const mirrorElements = [mirror, ...mirror.querySelectorAll<HTMLElement>("*")];
    for (let index = 0; index < sourceElements.length; index++) {
      const sourceElement = sourceElements[index];
      const mirrorElement = mirrorElements[index];
      if (!sourceElement || !mirrorElement) continue;
      mirrorToSource.set(mirrorElement, sourceElement);
      if (sourceElement.id) {
        mirrorElement.dataset.stereoSource = sourceElement.id;
        mirrorElement.removeAttribute("id");
      }
      mirrorElement.removeAttribute("for");
      mirrorElement.removeAttribute("aria-live");
      if (mirrorElement.matches("a, button, input, select")) {
        mirrorElement.tabIndex = -1;
      }
    }

    const proxyValue = (event: Event) => {
      const mirrorElement = event.target;
      const sourceElement = sourceForMirrorTarget(mirrorElement);
      if (
        mirrorElement instanceof HTMLInputElement &&
        sourceElement instanceof HTMLInputElement
      ) {
        sourceElement.value = mirrorElement.value;
        sourceElement.checked = mirrorElement.checked;
      } else if (
        mirrorElement instanceof HTMLSelectElement &&
        sourceElement instanceof HTMLSelectElement
      ) {
        sourceElement.value = mirrorElement.value;
      } else {
        return;
      }
      sourceElement.dispatchEvent(new Event(event.type, { bubbles: true }));
    };
    mirror.addEventListener("input", proxyValue);
    mirror.addEventListener("change", proxyValue);
    mirror.addEventListener("click", (event) => {
      const interactive =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("button, a")
          : null;
      const sourceElement = interactive
        ? mirrorToSource.get(interactive)
        : undefined;
      if (
        sourceElement instanceof HTMLButtonElement ||
        sourceElement instanceof HTMLAnchorElement
      ) {
        event.preventDefault();
        sourceElement.click();
      }
    });
    mirror.addEventListener("pointerdown", (event) => {
      const sourceElement = sourceForMirrorTarget(event.target);
      if (sourceElement === peekButton) beginPeekPress();
    });
    mirror.addEventListener("pointerup", (event) => {
      const sourceElement = sourceForMirrorTarget(event.target);
      if (sourceElement === peekButton) finishPeekPress(false);
    });
    for (const eventName of ["pointercancel", "pointerleave"] as const) {
      mirror.addEventListener(eventName, (event) => {
        const sourceElement = sourceForMirrorTarget(event.target);
        if (sourceElement === peekButton || peekPressStarted !== undefined) {
          finishPeekPress(true);
        }
      });
    }

    const mirrorScroll = (from: HTMLElement, to: HTMLElement) => {
      if (syncingChromeScroll) return;
      syncingChromeScroll = true;
      to.scrollLeft = from.scrollLeft;
      syncingChromeScroll = false;
    };
    source.addEventListener("scroll", () => mirrorScroll(source, mirror), {
      passive: true,
    });
    mirror.addEventListener("scroll", () => mirrorScroll(mirror, source), {
      passive: true,
    });

    source.after(mirror);
    stereoChromePairs.push({ source, mirror, sourceElements, mirrorElements });
    new MutationObserver(scheduleStereoChromeSync).observe(source, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    source.addEventListener("input", scheduleStereoChromeSync, true);
    source.addEventListener("change", scheduleStereoChromeSync, true);
  }

  toast.classList.add("stereo-toast-left");
  toastMirror = toast.cloneNode(true) as HTMLElement;
  toastMirror.removeAttribute("id");
  toastMirror.removeAttribute("aria-live");
  toastMirror.setAttribute("aria-hidden", "true");
  toastMirror.classList.remove("stereo-toast-left");
  toastMirror.classList.add("stereo-toast-right");
  toast.after(toastMirror);
  setupStereoHelp();
  syncStereoChrome();
}

function setupStereoHelp() {
  const source = helpPanel;
  const mirror = source.cloneNode(true) as HTMLElement;
  mirror.classList.remove("stereo-left");
  mirror.classList.add("stereo-right");
  mirror.setAttribute("aria-hidden", "true");

  const sourceElements = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const mirrorElements = [mirror, ...mirror.querySelectorAll<HTMLElement>("*")];
  for (let index = 0; index < sourceElements.length; index++) {
    const sourceElement = sourceElements[index];
    const mirrorElement = mirrorElements[index];
    if (!sourceElement || !mirrorElement) continue;
    mirrorToSource.set(mirrorElement, sourceElement);
    if (sourceElement.id) {
      mirrorElement.dataset.stereoSource = sourceElement.id;
      mirrorElement.removeAttribute("id");
    }
    mirrorElement.removeAttribute("for");
    mirrorElement.removeAttribute("aria-live");
    if (mirrorElement.matches("a, button, input, select")) {
      mirrorElement.tabIndex = -1;
    }
  }

  mirror.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button")
        : null;
    const sourceButton = button ? mirrorToSource.get(button) : undefined;
    if (sourceButton instanceof HTMLButtonElement) {
      event.preventDefault();
      sourceButton.click();
    }
  });

  const sourceContent = source.querySelector<HTMLElement>(".help-content");
  const mirrorContent = mirror.querySelector<HTMLElement>(".help-content");
  if (sourceContent && mirrorContent) {
    const syncHelpScroll = (from: HTMLElement, to: HTMLElement) => {
      if (syncingChromeScroll) return;
      syncingChromeScroll = true;
      to.scrollTop = from.scrollTop;
      syncingChromeScroll = false;
    };
    sourceContent.addEventListener(
      "scroll",
      () => syncHelpScroll(sourceContent, mirrorContent),
      { passive: true },
    );
    mirrorContent.addEventListener(
      "scroll",
      () => syncHelpScroll(mirrorContent, sourceContent),
      { passive: true },
    );
  }

  source.after(mirror);
  stereoChromePairs.push({ source, mirror, sourceElements, mirrorElements });
  new MutationObserver(scheduleStereoChromeSync).observe(source, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
}

function setLocalizedCopy(element: HTMLElement, english: string) {
  element.dataset.i18nSource = english;
  if (!activeTranslator) {
    element.textContent = english;
    scheduleStereoChromeSync();
    return;
  }

  const translator = activeTranslator;
  void translator
    .translate(english)
    .then((translated) => {
      if (
        activeTranslator === translator &&
        element.dataset.i18nSource === english
      ) {
        element.textContent = translated;
        scheduleStereoChromeSync();
      }
    })
    .catch(() => {
      if (element.dataset.i18nSource === english) element.textContent = english;
      scheduleStereoChromeSync();
    });
}

function latticePosition(center: readonly [number, number, number]): THREE.Vector3 {
  const latticeCenter = (CUBE_SIZE - 1) / 2;
  return new THREE.Vector3(
    (center[0] - latticeCenter) * CELL_SPACING,
    (latticeCenter - center[1]) * CELL_SPACING,
    (center[2] - latticeCenter) * CELL_SPACING,
  );
}

function partSize(span: number) {
  return CELL_SIZE + (span - 1) * CELL_SPACING;
}

function cellBounds(cell: RgCell) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const part of cell.parts) {
    const position = latticePosition(part.center);
    const half = partSize(part.span) / 2;
    min.min(position.clone().addScalar(-half));
    max.max(position.clone().addScalar(half));
  }
  return { min, max };
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

const wireDigitSegments: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5],
  [1, 2],
  [0, 1, 6, 4, 3],
  [0, 1, 2, 3, 6],
  [5, 6, 1, 2],
  [0, 5, 6, 2, 3],
  [0, 5, 6, 4, 2, 3],
  [0, 1, 2],
  [0, 1, 2, 3, 4, 5, 6],
  [0, 1, 2, 3, 5, 6],
];

function drawWireDigit(
  context: CanvasRenderingContext2D,
  digit: number,
  centerX: number,
) {
  const left = centerX - 23;
  const right = centerX + 23;
  const top = 30;
  const middle = 64;
  const bottom = 99;
  const segments = [
    [left + 5, top, right - 5, top],
    [right, top + 5, right, middle - 5],
    [right, middle + 5, right, bottom - 5],
    [left + 5, bottom, right - 5, bottom],
    [left, middle + 5, left, bottom - 5],
    [left, top + 5, left, middle - 5],
    [left + 5, middle, right - 5, middle],
  ] as const;
  const active = wireDigitSegments[digit] ?? wireDigitSegments[0]!;
  const stroke = (color: string, width: number) => {
    context.beginPath();
    for (const segmentIndex of active) {
      const segment = segments[segmentIndex]!;
      context.moveTo(segment[0], segment[1]);
      context.lineTo(segment[2], segment[3]);
    }
    context.strokeStyle = color;
    context.lineWidth = width;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke();
  };
  stroke("rgba(2, 4, 5, 0.95)", 12);
  stroke("rgba(248, 252, 252, 0.98)", 5);
}

function digitTexture(digit: number, side: "left" | "right") {
  const key = `${side}:${digit}`;
  const cached = digitTextures.get(key);
  if (cached) return cached;

  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = 256;
  textureCanvas.height = 128;
  const context = textureCanvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");

  roundedRect(context, 14, 13, 228, 102, 14);
  context.strokeStyle = "rgba(231, 240, 242, 0.62)";
  context.lineWidth = 4;
  context.stroke();
  context.beginPath();
  context.moveTo(128, 28);
  context.lineTo(128, 100);
  context.strokeStyle = "rgba(231, 240, 242, 0.28)";
  context.lineWidth = 3;
  context.stroke();

  const x = side === "left" ? 72 : 184;
  drawWireDigit(context, digit, x);

  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  digitTextures.set(key, texture);
  return texture;
}

function setCommonLayers(object: THREE.Object3D) {
  object.layers.set(0);
}

function createDigitSprite(
  digit: number,
  digitSide: "left" | "right",
  eye: "left" | "right",
  position: THREE.Vector3,
  span: number,
) {
  const material = new THREE.SpriteMaterial({
    map: digitTexture(digit, digitSide),
    color: palettes[currentTheme].digit,
    transparent: true,
    opacity: 0.94,
    depthTest: true,
    depthWrite: false,
    alphaTest: 0.025,
  });
  const sprite = new THREE.Sprite(material);
  sprite.position.copy(position);
  const labelScale = Math.min(1.55, Math.sqrt(span));
  sprite.scale.set(0.66 * labelScale, 0.33 * labelScale, 1);
  sprite.center.set(0.5, 0.5);
  sprite.layers.set(eye === "left" ? 1 : 2);
  sprite.renderOrder = 10;
  return sprite;
}

function disposeContent() {
  if (!contentGroup) return;
  cubeRoot.remove(contentGroup);
  const materials = new Set<THREE.Material>();
  contentGroup.traverse((object) => {
    if (!("material" in object)) return;
    const material = (object as THREE.Object3D & {
      material: THREE.Material | THREE.Material[];
    }).material;
    for (const item of Array.isArray(material) ? material : [material]) {
      materials.add(item);
    }
  });
  for (const material of materials) material.dispose();
  layerVisuals.length = 0;
  cellVisuals.clear();
  raycastMeshes.length = 0;
}

function colorIndexFor(cell: RgCell, representation: CubeRepresentation) {
  if (representation.method === "graph" && representation.level > 0) {
    return cell.id % 4;
  }
  if (representation.gridSize === 1) return 2;
  return Math.round((cell.depth / (representation.gridSize - 1)) * 3);
}

function buildRepresentation(representation: CubeRepresentation) {
  disposeContent();
  contentGroup = new THREE.Group();
  contentGroup.name = `number-cube-${representation.method}-${representation.level}`;
  contentGroup.scale.setScalar(0.94);
  representationTransitionStart = performance.now();
  cubeRoot.add(contentGroup);

  const palette = palettes[currentTheme];
  const transform = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (let depth = 0; depth < representation.gridSize; depth++) {
    const cells = representation.cells.filter((cell) => cell.depth === depth);
    const instanceCount = cells.reduce(
      (count, cell) => count + cell.parts.length,
      0,
    );
    const fillMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.62,
      metalness: 0.08,
      transparent: true,
      opacity: ghostOpacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    const fill = new THREE.InstancedMesh(
      boxGeometry,
      fillMaterial,
      instanceCount,
    );
    const wireGroup = new THREE.Group();
    fill.name = `cube-depth-${depth}-fill`;
    wireGroup.name = `cube-depth-${depth}-wire`;
    fill.renderOrder = depth;
    fill.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    setCommonLayers(fill);

    const instanceCellIds: number[] = [];
    let instanceIndex = 0;
    cells.forEach((cell) => {
      const fills: CellVisual["fills"] = [];
      const colorIndex = colorIndexFor(cell, representation);
      const wireMaterial = new THREE.LineBasicMaterial({
        color: palette.layers[colorIndex],
        transparent: true,
        opacity:
          representation.method === "graph" && representation.level > 0
            ? 0.38
            : 0.28,
        depthWrite: false,
      });
      const supportMaterials: THREE.LineBasicMaterial[] = [];
      for (const part of cell.parts) {
        const position = latticePosition(part.center);
        const size = partSize(part.span);
        scale.setScalar(size / CELL_SIZE);
        transform.compose(position, rotation, scale);
        fill.setMatrixAt(instanceIndex, transform);
        fill.setColorAt(
          instanceIndex,
          new THREE.Color(palette.layers[colorIndex]),
        );
        instanceCellIds.push(cell.id);
        fills.push({ fill, instanceIndex });

        const cellEdges = new THREE.LineSegments(
          cellEdgesGeometry,
          wireMaterial,
        );
        cellEdges.position.copy(position);
        cellEdges.scale.copy(scale);
        cellEdges.renderOrder = depth + 4;
        setCommonLayers(cellEdges);
        wireGroup.add(cellEdges);
        instanceIndex++;
      }

      if (representation.method === "gaussian" && representation.level === 1) {
        const supportMaterial = new THREE.LineBasicMaterial({
          color: palette.layers[colorIndex],
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
        });
        const support = new THREE.LineSegments(cellEdgesGeometry, supportMaterial);
        support.position.copy(latticePosition(cell.center));
        support.scale.setScalar(partSize(3) / CELL_SIZE);
        support.renderOrder = depth + 3;
        setCommonLayers(support);
        wireGroup.add(support);
        supportMaterials.push(supportMaterial);
      }

      const position = latticePosition(cell.center);
      const labelSpan = representation.level === 0 ? 1 : 2 ** representation.level;
      const digitSprites: CellVisual["digitSprites"] = [
        {
          digit: "tens",
          eye: "left",
          sprite: createDigitSprite(
            Math.floor(cell.value / 10),
            "left",
            "left",
            position,
            labelSpan,
          ),
        },
        {
          digit: "tens",
          eye: "right",
          sprite: createDigitSprite(
            Math.floor(cell.value / 10),
            "left",
            "right",
            position,
            labelSpan,
          ),
        },
        {
          digit: "ones",
          eye: "left",
          sprite: createDigitSprite(
            cell.value % 10,
            "right",
            "left",
            position,
            labelSpan,
          ),
        },
        {
          digit: "ones",
          eye: "right",
          sprite: createDigitSprite(
            cell.value % 10,
            "right",
            "right",
            position,
            labelSpan,
          ),
        },
      ];
      contentGroup!.add(...digitSprites.map(({ sprite }) => sprite));
      cellVisuals.set(cell.id, {
        fills,
        wireMaterials: [wireMaterial],
        supportMaterials,
        digitSprites,
        digitMaterials: digitSprites.map(({ sprite }) => sprite.material),
      });
    });

    fill.instanceMatrix.needsUpdate = true;
    if (fill.instanceColor) fill.instanceColor.needsUpdate = true;
    fill.userData.cellIds = instanceCellIds;
    contentGroup.add(fill, wireGroup);
    raycastMeshes.push(fill);
    layerVisuals.push({
      depth,
      fill,
    });
  }

  updateLayerAppearance();
}

function updateCellViewDepths() {
  cellViewDepths.clear();
  if (!currentRepresentation) return;
  camera.updateMatrixWorld(true);
  cubeRoot.updateMatrixWorld(true);
  const localToView = new THREE.Matrix4().multiplyMatrices(
    camera.matrixWorldInverse,
    cubeRoot.matrixWorld,
  );
  const distances = currentRepresentation.cells.map((cell) => ({
    id: cell.id,
    distance: -latticePosition(cell.center).applyMatrix4(localToView).z,
  }));
  const min = Math.min(...distances.map(({ distance }) => distance));
  const max = Math.max(...distances.map(({ distance }) => distance));
  const span = max - min;
  for (const { id, distance } of distances) {
    cellViewDepths.set(id, span < 0.0001 ? 0.5 : (distance - min) / span);
  }
}

function focusWindowWidth() {
  if (currentRepresentation.gridSize === 1) return 1;
  return currentRepresentation.gridSize === 2 ? 0.3 : 0.17;
}

function cellFocusStrength(cellId: number) {
  if (focusDepth === undefined) return 1;
  const cellDepth = cellViewDepths.get(cellId) ?? 0.5;
  const distance = (cellDepth - focusDepth) / focusWindowWidth();
  return Math.exp(-0.5 * distance * distance);
}

function updateLayerAppearance() {
  const themeOpacity = currentTheme === "light" ? 0.5 : 1;
  const presentation = labelPresentation(labelEncoding, peekActive);
  for (const layer of layerVisuals) {
    layer.fill.material.opacity = ghostOpacity * themeOpacity;
  }

  for (const cell of currentRepresentation.cells) {
    const visual = cellVisuals.get(cell.id);
    if (!visual) continue;
    const strength = cellFocusStrength(cell.id);
    const focusMix = focusDepth === undefined ? 1 : 0.1 + strength * 0.9;
    const wireOpacity =
      currentRepresentation.method === "graph" && currentRepresentation.level > 0
        ? 0.38
        : currentTheme === "light"
          ? 0.2
          : 0.28;
    for (const material of visual.wireMaterials) {
      material.opacity = wireOpacity * focusMix;
    }
    for (const material of visual.supportMaterials) {
      material.opacity = 0.08 * focusMix;
    }
    const labelOpacity =
      focusDepth === undefined ? 0.9 : 0.07 + strength * 0.87;
    for (const { digit, eye, sprite } of visual.digitSprites) {
      const visibility = presentation[digit][eye];
      sprite.visible = visibility > 0;
      sprite.material.opacity = labelOpacity * visibility;
    }
  }
  updateCellColors();
}

function updateCellColors() {
  const palette = palettes[currentTheme];
  const background = new THREE.Color(palette.background);
  for (const cell of currentRepresentation.cells) {
    const visual = cellVisuals.get(cell.id);
    if (!visual) continue;
    const colorIndex = colorIndexFor(cell, currentRepresentation);
    const color = new THREE.Color(
      solvedCellIds.has(cell.id)
        ? palette.solved
        : palette.layers[colorIndex],
    );
    if (focusDepth !== undefined) {
      color.lerp(background, (1 - cellFocusStrength(cell.id)) * 0.78);
    }
    for (const { fill, instanceIndex } of visual.fills) {
      fill.setColorAt(instanceIndex, color);
      if (fill.instanceColor) fill.instanceColor.needsUpdate = true;
    }
    for (const material of visual.digitMaterials) {
      material.color.set(
        solvedCellIds.has(cell.id) ? palette.solved : palette.digit,
      );
    }
  }
}

function parseSeed() {
  const raw = new URLSearchParams(location.search).get("seed");
  if (!raw) return 0x3d726775;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : 0x3d726775;
}

function stringHash(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function representationTargets(representation: CubeRepresentation) {
  if (representation.level === 0) {
    return currentPuzzle.targets
      .map(
        (value) =>
          representation.cells.find((cell) => cell.value === value)?.id,
      )
      .filter((id): id is number => id !== undefined);
  }
  return shuffled(
    representation.cells.map((cell) => cell.id),
    currentPuzzle.seed ^
      stringHash(
        `${representation.method}:${representation.reducer}:${representation.level}`,
      ),
  ).slice(0, Math.min(8, representation.cells.length));
}

function updateRgControls() {
  const phase =
    rgLevel === 0 ? "MICRO" : rgLevel === 1 ? "MESO" : "FIXED POINT";
  mergeMethodSelect.value = mergeMethod;
  valueReducerSelect.value = valueReducer;
  labelEncodingSelect.value = labelEncoding;
  rgLevelRange.value = String(rgLevel);
  rgLevelOutput.value = `${currentRepresentation.gridSize}³`;
  rgReadout.value = `${phase} · ${currentRepresentation.cells.length} ${
    currentRepresentation.cells.length === 1 ? "parent" : "cells"
  } · ${currentRepresentation.supportLabel}`;
  scheduleStereoChromeSync();
}

function updateFocusControl() {
  if (focusDepth === undefined) {
    layerRange.value = "0";
    layerOutput.value = "ALL";
  } else {
    const percent = Math.round(focusDepth * 100);
    layerRange.value = String(percent + 1);
    layerOutput.value =
      percent <= 4
        ? "NEAR"
        : percent >= 96
          ? "FAR"
          : `Z${String(percent).padStart(2, "0")}`;
  }
  scheduleStereoChromeSync();
}

function setFocusDepth(nextDepth: number | undefined) {
  focusDepth =
    nextDepth === undefined
      ? undefined
      : THREE.MathUtils.clamp(nextDepth, 0, 1);
  updateCellViewDepths();
  updateFocusControl();
  updateLayerAppearance();
}

function moveFocusByWheel(event: WheelEvent) {
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? canvas.clientHeight
        : 1;
  const delta = THREE.MathUtils.clamp((-event.deltaY * unit) / 640, -0.16, 0.16);
  setFocusDepth((focusDepth ?? 0.5) + delta);
}

function refreshRepresentation() {
  currentRepresentation = buildCubeRepresentation(
    currentPuzzle,
    mergeMethod,
    valueReducer,
    rgLevel,
  );
  targetCellIds = representationTargets(currentRepresentation);
  targetIndex = 0;
  solvedCellIds = new Set<number>();
  focusDepth = undefined;
  updateFocusControl();
  buildRepresentation(currentRepresentation);
  updateRgControls();
  updateMission();
  hoveredCellId = undefined;
  delete canvas.dataset.hoveredCell;
  hoverOutline.visible = false;
}

function startPuzzle(seed: number) {
  currentPuzzle = createCubePuzzle(seed);
  refreshRepresentation();
  history.replaceState(null, "", `${location.pathname}?seed=${currentPuzzle.seed}`);
}

function updateMission() {
  const complete = targetIndex >= targetCellIds.length;
  const targetId = targetCellIds[targetIndex];
  const target =
    targetId === undefined ? undefined : currentRepresentation.cells[targetId];
  targetNumber.textContent = complete
    ? "✓"
    : String(target?.value ?? "--").padStart(2, "0");
  progress.textContent = `${Math.min(targetIndex, targetCellIds.length)}/${targetCellIds.length}`;
  targetNumber.closest(".mission")?.classList.toggle("complete", complete);
  scheduleStereoChromeSync();
}

function showToast(message: string, kind: "correct" | "wrong") {
  window.clearTimeout(toastTimer);
  setLocalizedCopy(toast, message);
  if (toastMirror) setLocalizedCopy(toastMirror, message);
  toast.className = `result-toast stereo-toast-left visible ${kind}`;
  if (toastMirror) {
    toastMirror.className = `result-toast stereo-toast-right visible ${kind}`;
  }
  toastTimer = window.setTimeout(() => {
    toast.className = "result-toast stereo-toast-left";
    if (toastMirror) {
      toastMirror.className = "result-toast stereo-toast-right";
    }
  }, kind === "correct" ? 920 : 720);
}

function selectCell(cellId: number) {
  if (targetIndex >= targetCellIds.length) return;
  const cell = currentRepresentation.cells[cellId];
  const expectedId = targetCellIds[targetIndex];
  const expected =
    expectedId === undefined ? undefined : currentRepresentation.cells[expectedId];
  if (!cell || !expected) return;

  if (cell.id === expected.id) {
    solvedCellIds.add(cell.id);
    targetIndex++;
    updateCellColors();
    updateMission();
    showToast(
      targetIndex >= targetCellIds.length
        ? "CUBE CLEARED"
        : `LOCKED · ${cell.value}`,
      "correct",
    );
    return;
  }

  const visual = cellVisuals.get(cell.id);
  if (visual) {
    window.clearTimeout(wrongResetTimer);
    for (const material of visual.digitMaterials) material.color.set(0xff5f68);
    wrongResetTimer = window.setTimeout(updateCellColors, 420);
  }
  showToast(`READ ${cell.value} · FIND ${expected.value}`, "wrong");
}

function updateCamera() {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  const eyeAspect = width / 2 / height;
  frameMultiplier = Math.max(1, 0.72 / eyeAspect);
  const distance = cameraDistance * frameMultiplier;
  const horizontal = Math.cos(pitch) * distance;
  camera.position.set(
    Math.sin(yaw) * horizontal,
    Math.sin(pitch) * distance,
    Math.cos(yaw) * horizontal,
  ).add(cameraTarget);
  camera.lookAt(cameraTarget);
  camera.focus = distance;
  camera.updateMatrixWorld(true);

  const stereoStrength = Number(stereoRange.value) / 100;
  stereoCamera.eyeSep = (0.08 + stereoStrength * 0.72) * frameMultiplier;
  if (currentRepresentation) {
    updateCellViewDepths();
    updateLayerAppearance();
  }
}

function resetView() {
  yaw = Math.PI / 4;
  pitch = 0.34;
  cameraDistance = 9.6;
  cameraTarget.set(0, 0, 0);
  focusDepth = undefined;
  updateFocusControl();
  updateCamera();
}

function resizeRenderer() {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const targetWidth = Math.round(width * renderer.getPixelRatio());
  const targetHeight = Math.round(height * renderer.getPixelRatio());
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    renderer.setSize(width, height, false);
    updateCamera();
  }
}

function render() {
  const now = performance.now();
  const elapsed = Math.min(50, now - lastRenderTime);
  lastRenderTime = now;
  if (!drag && !spatialPinch && pointers.size === 0 && !helpDialog.open) {
    yaw += elapsed * 0.00003;
    updateCamera();
  }
  resizeRenderer();
  if (contentGroup && contentGroup.scale.x < 0.999) {
    const progress = THREE.MathUtils.clamp(
      (now - representationTransitionStart) / 260,
      0,
      1,
    );
    const eased = 1 - (1 - progress) ** 3;
    contentGroup.scale.setScalar(0.94 + eased * 0.06);
  }
  scene.updateMatrixWorld();
  camera.updateMatrixWorld();
  updateStereoCameras(stereoCamera, camera);

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const leftWidth = Math.floor(width / 2);
  const rightWidth = width - leftWidth;

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, width, height);
  renderer.clear();
  renderer.setScissorTest(true);

  const [leftPanelCamera, rightPanelCamera] = stereoPanelCameras(stereoCamera, stereoMode);

  renderer.setScissor(0, 0, leftWidth, height);
  renderer.setViewport(0, 0, leftWidth, height);
  renderer.render(scene, leftPanelCamera);

  renderer.setScissor(leftWidth, 0, rightWidth, height);
  renderer.setViewport(leftWidth, 0, rightWidth, height);
  renderer.render(scene, rightPanelCamera);

  renderer.setScissorTest(false);
  requestAnimationFrame(render);
}

function pickedCell(clientX: number, clientY: number): number | undefined {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return undefined;

  const leftEye = x < rect.width / 2;
  const eyeX = leftEye ? x : x - rect.width / 2;
  pointerNdc.set(
    (eyeX / (rect.width / 2)) * 2 - 1,
    -(y / rect.height) * 2 + 1,
  );

  updateCamera();
  updateStereoCameras(stereoCamera, camera);
  const eyeCamera =
    leftEye === (stereoMode === "parallel")
      ? stereoCamera.cameraL
      : stereoCamera.cameraR;
  raycaster.setFromCamera(pointerNdc, eyeCamera);
  const hits = raycaster.intersectObjects(raycastMeshes, false);
  for (const hit of hits) {
    if (hit.instanceId === undefined) continue;
    const ids = hit.object.userData.cellIds as number[] | undefined;
    const cellId = ids?.[hit.instanceId];
    if (cellId === undefined) continue;
    if (focusDepth === undefined || cellFocusStrength(cellId) >= 0.24) {
      return cellId;
    }
  }
  return undefined;
}

function updateHover(clientX: number, clientY: number) {
  const cellId = pickedCell(clientX, clientY);
  setFocusedCell(cellId);
}

function setFocusedCell(cellId: number | undefined) {
  if (cellId === hoveredCellId) return;
  hoveredCellId = cellId;
  if (cellId === undefined) delete canvas.dataset.hoveredCell;
  else canvas.dataset.hoveredCell = String(cellId);
  const cell =
    cellId === undefined ? undefined : currentRepresentation.cells[cellId];
  hoverOutline.visible = !!cell;
  if (cell) {
    const bounds = cellBounds(cell);
    const size = bounds.max.clone().sub(bounds.min).addScalar(0.08);
    hoverOutline.position.copy(bounds.min).add(bounds.max).multiplyScalar(0.5);
    hoverOutline.scale.set(
      size.x / (CELL_SIZE + 0.08),
      size.y / (CELL_SIZE + 0.08),
      size.z / (CELL_SIZE + 0.08),
    );
  }
}

function moveKeyboardFocus(direction: FocusDirection) {
  updateCamera();
  updateCellViewDepths();
  camera.updateMatrixWorld(true);
  cubeRoot.updateMatrixWorld(true);
  const candidates = currentRepresentation.cells.map((cell) => {
    const projected = latticePosition(cell.center)
      .applyMatrix4(cubeRoot.matrixWorld)
      .project(camera);
    return {
      id: cell.id,
      x: projected.x,
      y: projected.y,
      depth: cellViewDepths.get(cell.id) ?? 0.5,
    };
  });
  const nextId = directionalFocusTarget(candidates, hoveredCellId, direction);
  if (nextId === undefined) return;
  setFocusedCell(nextId);
  setFocusDepth(cellViewDepths.get(nextId) ?? 0.5);
}

function setRgLevel(nextLevel: number, announce = false) {
  const normalized = Math.max(0, Math.min(2, Math.round(nextLevel))) as RgLevel;
  if (normalized === rgLevel) return false;
  rgLevel = normalized;
  refreshRepresentation();
  if (announce) {
    showToast(
      rgLevel === 0
        ? "DETAIL RESTORED · 4³"
        : rgLevel === 1
          ? "COARSE GRAIN · 2³"
          : "RG FIXED POINT · 1³",
      "correct",
    );
  }
  return true;
}

function applyZoomDistance(nextDistance: number) {
  if (nextDistance > 13.2 && rgLevel < 2) {
    if (setRgLevel(rgLevel + 1, true)) cameraDistance = 9.4;
  } else if (nextDistance < 6.8 && rgLevel > 0) {
    if (setRgLevel(rgLevel - 1, true)) cameraDistance = 10.4;
  } else {
    cameraDistance = THREE.MathUtils.clamp(nextDistance, 6.4, 15);
  }
  updateCamera();
}

function pointerPairDistance() {
  const pair = [...pointers.values()].slice(0, 2);
  return pair.length === 2 ? pair[0]!.distanceTo(pair[1]!) : undefined;
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, new THREE.Vector2(event.clientX, event.clientY));
  if (pointers.size === 1) {
    const grabbedCellId = event.button === 2
      ? undefined
      : pickedCell(event.clientX, event.clientY);
    if (grabbedCellId !== undefined) setFocusedCell(grabbedCellId);
    const grabbedCell = grabbedCellId === undefined
      ? undefined
      : currentRepresentation.cells[grabbedCellId];
    const grabbedPoint = grabbedCell
      ? latticePosition(grabbedCell.center).applyMatrix4(cubeRoot.matrixWorld)
      : undefined;
    const cameraForward = camera.getWorldDirection(new THREE.Vector3());
    const grabbedDepth = grabbedPoint
      ? grabbedPoint.clone().sub(camera.position).dot(cameraForward)
      : 0;
    drag = {
      pointerId: event.pointerId,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      mode: grabbedDepth > 0 ? "depth-pan" : "orbit",
      depth: grabbedDepth,
    };
  } else {
    pinchDistance = pointerPairDistance();
    if (drag) drag.moved = true;
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!pointers.has(event.pointerId)) {
    if (cubeApp.classList.contains("spatial-tracking")) return;
    updateHover(event.clientX, event.clientY);
    return;
  }

  pointers.set(event.pointerId, new THREE.Vector2(event.clientX, event.clientY));
  if (pointers.size >= 2) {
    const nextDistance = pointerPairDistance();
    if (nextDistance && pinchDistance) {
      applyZoomDistance(cameraDistance * (pinchDistance / nextDistance));
    }
    pinchDistance = nextDistance;
    return;
  }

  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.lastX;
  const dy = event.clientY - drag.lastY;
  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
  if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) {
    drag.moved = true;
  }
  if (drag.mode === "depth-pan") {
    const scale = depthPlanePanScale(
      drag.depth,
      THREE.MathUtils.degToRad(camera.fov),
      canvas.clientHeight,
    );
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    cameraTarget.addScaledVector(right, -dx * scale);
    cameraTarget.addScaledVector(up, dy * scale);
  } else {
    yaw -= dx * 0.006;
    pitch = THREE.MathUtils.clamp(pitch + dy * 0.005, -1.08, 1.08);
  }
  updateCamera();
});

function finishPointer(event: PointerEvent) {
  const wasClick =
    pointers.size === 1 &&
    drag?.pointerId === event.pointerId &&
    drag.button === 0 &&
    !drag.moved;
  pointers.delete(event.pointerId);
  if (wasClick) {
    const cellId = pickedCell(event.clientX, event.clientY);
    if (cellId !== undefined) selectCell(cellId);
  }
  if (pointers.size === 0) {
    drag = undefined;
    pinchDistance = undefined;
    updateHover(event.clientX, event.clientY);
  } else {
    const [pointerId, point] = pointers.entries().next().value as [
      number,
      THREE.Vector2,
    ];
    drag = {
      pointerId,
      button: -1,
      startX: point.x,
      startY: point.y,
      lastX: point.x,
      lastY: point.y,
      moved: true,
      mode: "orbit",
      depth: 0,
    };
    pinchDistance = undefined;
  }
}

canvas.addEventListener("pointerup", finishPointer);
canvas.addEventListener("pointercancel", finishPointer);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("pointerleave", () => {
  if (pointers.size === 0) {
    hoveredCellId = undefined;
    delete canvas.dataset.hoveredCell;
    hoverOutline.visible = false;
  }
});

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      applyZoomDistance(cameraDistance * Math.exp(event.deltaY * 0.001));
    } else {
      moveFocusByWheel(event);
    }
    updateHover(event.clientX, event.clientY);
  },
  { passive: false },
);

canvas.addEventListener("keydown", (event) => {
  const step = event.shiftKey ? 0.16 : 0.08;
  const key = event.key.toLowerCase();
  const focusDirection = ({
    h: "left",
    l: "right",
    k: "up",
    j: "down",
    u: "far",
    i: "near",
  } as const)[key as "h" | "l" | "k" | "j" | "u" | "i"];
  if (focusDirection) moveKeyboardFocus(focusDirection);
  else if (event.key === "Enter" && hoveredCellId !== undefined) {
    selectCell(hoveredCellId);
  } else if (event.key === "ArrowLeft") yaw += step;
  else if (event.key === "ArrowRight") yaw -= step;
  else if (event.key === "ArrowUp") pitch = Math.min(1.08, pitch - step);
  else if (event.key === "ArrowDown") pitch = Math.max(-1.08, pitch + step);
  else if (event.key === "+" || event.key === "=") {
    applyZoomDistance(cameraDistance * 0.9);
  } else if (event.key === "-" || event.key === "_") {
    applyZoomDistance(cameraDistance * 1.1);
  } else if (key === "r") resetView();
  else return;
  event.preventDefault();
  if (!focusDirection && !event.key.match(/^[+=_-]$/)) updateCamera();
});

labelEncodingSelect.addEventListener("change", () => {
  labelEncoding =
    labelEncodingSelect.value === "shared"
      ? "shared"
      : labelEncodingSelect.value === "split"
        ? "split"
        : "matched";
  localStorage.setItem("rgui-cube-label-encoding", labelEncoding);
  updateLayerAppearance();
  updateEyeLabels();
  showToast(`LABEL · ${labelEncoding.toUpperCase()}`, "correct");
});

mergeMethodSelect.addEventListener("change", () => {
  mergeMethod =
    mergeMethodSelect.value === "gaussian"
      ? "gaussian"
      : mergeMethodSelect.value === "graph"
        ? "graph"
        : "block";
  localStorage.setItem("rgui-cube-merge", mergeMethod);
  refreshRepresentation();
  showToast(`SUPPORT · ${mergeMethod.toUpperCase()}`, "correct");
});

valueReducerSelect.addEventListener("change", () => {
  valueReducer =
    valueReducerSelect.value === "sum"
      ? "sum"
      : valueReducerSelect.value === "median"
        ? "median"
        : "mean";
  localStorage.setItem("rgui-cube-reducer", valueReducer);
  refreshRepresentation();
  showToast(`VALUE · ${valueReducer.toUpperCase()}`, "correct");
});

rgLevelRange.addEventListener("input", () => {
  setRgLevel(Number(rgLevelRange.value), true);
});

layerRange.addEventListener("input", () => {
  const sliderValue = Number(layerRange.value);
  setFocusDepth(sliderValue === 0 ? undefined : (sliderValue - 1) / 100);
});

stereoRange.addEventListener("input", () => {
  stereoOutput.value = stereoRange.value;
  updateCamera();
});

opacityRange.addEventListener("input", () => {
  ghostOpacity = Number(opacityRange.value) / 100;
  opacityOutput.value = `${opacityRange.value}%`;
  updateLayerAppearance();
});

function updateEyeLabel(
  element: HTMLElement,
  eye: "L" | "R",
  copy: string,
  emphasis: "tens" | "ones" | "full",
) {
  element.querySelector("b")!.textContent = eye;
  setLocalizedCopy(element.querySelector<HTMLElement>("span")!, copy);
  element.classList.toggle("eye-label-tens", emphasis === "tens");
  element.classList.toggle("eye-label-ones", emphasis === "ones");
  element.classList.toggle("eye-label-full", emphasis === "full");
}

function eyeDescriptor(logicalEye: "left" | "right"): {
  eye: "L" | "R";
  copy: string;
  emphasis: "tens" | "ones" | "full";
} {
  const eye = logicalEye === "left" ? "L" : "R";
  if (labelEncoding === "shared") {
    return { eye, copy: "FULL LABEL", emphasis: "full" as const };
  }
  const tens = logicalEye === "left";
  return {
    eye,
    copy:
      labelEncoding === "matched"
        ? tens
          ? "TENS LEAD"
          : "ONES LEAD"
        : tens
          ? "TENS"
          : "ONES",
    emphasis: tens ? ("tens" as const) : ("ones" as const),
  };
}

function updateEyeLabels() {
  const physicalLeft = eyeDescriptor(
    stereoMode === "parallel" ? "left" : "right",
  );
  const physicalRight = eyeDescriptor(
    stereoMode === "parallel" ? "right" : "left",
  );
  updateEyeLabel(
    leftEyeLabel,
    physicalLeft.eye,
    physicalLeft.copy,
    physicalLeft.emphasis,
  );
  updateEyeLabel(
    rightEyeLabel,
    physicalRight.eye,
    physicalRight.copy,
    physicalRight.emphasis,
  );
}

function setStereoMode(mode: StereoMode) {
  stereoMode = mode;
  localStorage.setItem("rgui-stereo-mode", mode);
  helpDialog.dataset.stereoMode = mode;
  for (const button of stereoModeButtons) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.stereoMode === mode),
    );
  }
  updateEyeLabels();
  setLocalizedCopy(missionLabel, `${mode.toUpperCase()} · FIND`);
  scheduleStereoChromeSync();
}

for (const button of stereoModeButtons) {
  button.addEventListener("click", () => {
    setStereoMode(button.dataset.stereoMode === "cross" ? "cross" : "parallel");
  });
}

resetViewButton.addEventListener("click", resetView);
newPuzzleButton.addEventListener("click", () => {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? Date.now();
  startPuzzle(seed);
  showToast("NEW CUBE", "correct");
});

function setPeek(active: boolean) {
  peekActive = active;
  peekButton.setAttribute("aria-pressed", String(active));
  scheduleStereoChromeSync();
  if (currentRepresentation) updateLayerAppearance();
}

function togglePeekLock() {
  peekLocked = !peekLocked;
  setPeek(peekLocked);
  showToast(peekLocked ? "PEEK LOCKED" : "PEEK RELEASED", "correct");
}

function beginPeekPress() {
  if (peekPressStarted !== undefined) return;
  peekPressStarted = performance.now();
  setPeek(true);
}

function finishPeekPress(cancelled: boolean) {
  if (peekPressStarted === undefined) return;
  const held = performance.now() - peekPressStarted >= 320;
  peekPressStarted = undefined;
  if (!cancelled && !held) togglePeekLock();
  else setPeek(peekLocked);
}

peekButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  beginPeekPress();
});
peekButton.addEventListener("pointerup", () => finishPeekPress(false));
peekButton.addEventListener("pointercancel", () => finishPeekPress(true));
peekButton.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  if (event.key === "Enter") {
    event.preventDefault();
    togglePeekLock();
  } else if (event.key === " ") {
    event.preventDefault();
    setPeek(true);
  }
});
peekButton.addEventListener("keyup", (event) => {
  if (event.key === " ") {
    event.preventDefault();
    setPeek(peekLocked);
  }
});
window.addEventListener("pointerup", () => finishPeekPress(false));

async function translateInterface(translator: NativeTextTranslator) {
  for (const element of translatableElements) {
    const source = element.dataset.i18nSource;
    if (!source) continue;
    try {
      const translated = await translator.translate(source);
      if (
        activeTranslator === translator &&
        element.dataset.i18nSource === source
      ) {
        element.textContent = translated;
      }
    } catch {
      if (element.dataset.i18nSource === source) element.textContent = source;
    }
  }
}

function restoreEnglishInterface() {
  activeTranslator?.destroy?.();
  activeTranslator = undefined;
  for (const element of translatableElements) {
    element.textContent = element.dataset.i18nSource ?? element.textContent;
  }
  document.documentElement.lang = "en";
  translateButton.setAttribute("aria-pressed", "false");
}

async function setupNativeTranslation() {
  const api = getNativeTranslatorApi();
  const targetLanguage = preferredTargetLanguage();
  if (!api || !targetLanguage) return;

  try {
    const availability = await api.availability({
      sourceLanguage: "en",
      targetLanguage,
    });
    if (availability === "unavailable") return;
  } catch {
    return;
  }

  const languageLabel = targetLanguage.split("-")[0]!.toUpperCase();
  translateButton.hidden = false;
  translateButton.textContent = languageLabel;
  translateButton.title = `Translate English UI to ${targetLanguage} with the browser`;
  translateButton.setAttribute("aria-label", translateButton.title);

  translateButton.addEventListener("click", async () => {
    if (activeTranslator) {
      restoreEnglishInterface();
      translateButton.textContent = languageLabel;
      showToast("ENGLISH RESTORED", "correct");
      return;
    }

    translateButton.disabled = true;
    translateButton.textContent = "…";
    translateButton.setAttribute("aria-busy", "true");
    showToast("PREPARING BROWSER TRANSLATION", "correct");
    try {
      const translator = await createNativeTranslator(
        api,
        targetLanguage,
        (loaded) => {
          showToast(`LANGUAGE PACK · ${Math.round(loaded * 100)}%`, "correct");
        },
      );
      activeTranslator = translator;
      document.documentElement.lang = targetLanguage;
      await translateInterface(translator);
      translateButton.setAttribute("aria-pressed", "true");
      showToast(`${languageLabel} TRANSLATION ACTIVE`, "correct");
    } catch {
      restoreEnglishInterface();
      showToast("BROWSER TRANSLATION UNAVAILABLE", "wrong");
    } finally {
      translateButton.disabled = false;
      translateButton.removeAttribute("aria-busy");
      translateButton.textContent = languageLabel;
    }
  });
}

const HELP_SEEN_KEY = "rgui-cube-help-seen-v3";

function openHelp() {
  window.clearTimeout(helpAnimationTimer);
  helpClosing = false;
  if (!helpDialog.open) helpDialog.showModal();
  helpDialog.focus({ preventScroll: true });
  helpDialog.classList.remove("closing", "opening");
  void helpDialog.offsetWidth;
  helpDialog.classList.add("opening");
  helpAnimationTimer = window.setTimeout(() => {
    if (!helpClosing) helpDialog.classList.remove("opening");
  }, 340);
  localStorage.setItem(HELP_SEEN_KEY, "1");
}

function finishHelpClose() {
  if (!helpClosing) return;
  window.clearTimeout(helpAnimationTimer);
  helpClosing = false;
  helpDialog.classList.remove("opening", "closing");
  if (helpDialog.open) helpDialog.close();
}

function closeHelp() {
  if (!helpDialog.open || helpClosing) return;
  window.clearTimeout(helpAnimationTimer);
  helpClosing = true;
  helpDialog.classList.remove("opening");
  void helpDialog.offsetWidth;
  helpDialog.classList.add("closing");
  helpAnimationTimer = window.setTimeout(finishHelpClose, 340);
}

helpButton.addEventListener("click", openHelp);
helpCloseButton.addEventListener("click", closeHelp);
helpStartButton.addEventListener("click", closeHelp);
helpDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeHelp();
});
helpDialog.addEventListener("animationend", (event) => {
  if (event.animationName === "help-depth-out") finishHelpClose();
  if (event.animationName === "help-depth-in" && !helpClosing) {
    helpDialog.classList.remove("opening");
  }
});
helpDialog.addEventListener("click", (event) => {
  if (event.target === helpDialog) closeHelp();
});

const themeMedia = matchMedia("(prefers-color-scheme: light)");
const savedTheme = localStorage.getItem("rgui-theme");
let themeChoice: ThemeChoice =
  savedTheme === "light" || savedTheme === "dark" ? savedTheme : "auto";
const themeIcons: Record<ThemeChoice, string> = {
  auto: "◐",
  light: "☀",
  dark: "☾",
};

function effectiveTheme(): Theme {
  return themeChoice === "auto"
    ? themeMedia.matches
      ? "light"
      : "dark"
    : themeChoice;
}

function applyTheme() {
  currentTheme = effectiveTheme();
  document.documentElement.dataset.theme = currentTheme;
  if (themeChoice === "auto") localStorage.removeItem("rgui-theme");
  else localStorage.setItem("rgui-theme", themeChoice);

  const palette = palettes[currentTheme];
  renderer.setClearColor(palette.background, 1);
  outerMaterial.color.set(palette.outer);
  hoverMaterial.color.set(currentTheme === "dark" ? 0xffd447 : 0x7937a2);
  for (const material of floorMaterials) material.color.set(palette.grid);
  hemisphereLight.intensity = currentTheme === "dark" ? 2.15 : 2.6;
  keyLight.intensity = currentTheme === "dark" ? 3.4 : 2.8;
  rimLight.intensity = currentTheme === "dark" ? 1.65 : 1.1;
  if (currentRepresentation) {
    buildRepresentation(currentRepresentation);
    updateCellColors();
  }

  themeButton.textContent = themeIcons[themeChoice];
  themeButton.title =
    themeChoice === "auto"
      ? `Theme: auto (${currentTheme})`
      : `Theme: ${themeChoice}`;
  themeButton.setAttribute("aria-label", `${themeButton.title}. Change theme`);
}

themeButton.addEventListener("click", () => {
  themeChoice =
    themeChoice === "auto"
      ? "light"
      : themeChoice === "light"
        ? "dark"
        : "auto";
  applyTheme();
});
themeMedia.addEventListener("change", () => {
  if (themeChoice === "auto") applyTheme();
});

window.addEventListener("resize", updateCamera);

startPuzzle(parseSeed());
setStereoMode(stereoMode);
applyTheme();
resetView();
setupStereoChrome();
void setupNativeTranslation();
const spatialCursorChannel = createSpatialCursorChannel((frame) => {
  const result = reduceSpatialCursor(spatialCursorState, frame);
  spatialCursorState = result.state;
  for (const intent of result.intents) applySpatialIntent(intent);
});
window.addEventListener("pagehide", () => spatialCursorChannel?.close(), { once: true });
if (!localStorage.getItem(HELP_SEEN_KEY)) requestAnimationFrame(openHelp);
requestAnimationFrame(render);
