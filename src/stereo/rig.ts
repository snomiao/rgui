import * as THREE from "three";

export type StereoViewingMode = "parallel" | "cross";

export function updateStereoCameras(stereo: THREE.StereoCamera, camera: THREE.PerspectiveCamera) {
  stereo.update(camera);
  for (const eye of [stereo.cameraL, stereo.cameraR]) {
    eye.projectionMatrixInverse.copy(eye.projectionMatrix).invert();
    eye.updateMatrixWorld(true);
  }
}

export function stereoPanelCameras(stereo: THREE.StereoCamera, mode: StereoViewingMode) {
  return mode === "parallel"
    ? [stereo.cameraL, stereo.cameraR] as const
    : [stereo.cameraR, stereo.cameraL] as const;
}
