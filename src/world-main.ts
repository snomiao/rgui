import * as THREE from "three";
import "./world.css";
import { WorldInputRouter } from "./world/inputRouter.js";
import { FIXED_DT, initialWorldState, stepWorld, type WorldAction } from "./world/simulation.js";
import { approximateDyadicNumber } from "./world/dyadic.js";
import { createWorldModel, materialTotal, materializeCell, mineCell, moveCell, placeCell, setSelectedSlot, setViewDepth, type MaterialCell } from "./world/model.js";
import { childPath, encodeOctreePath, type Octant, type OctreePath } from "./world/octreePath.js";
import { updateStereoCameras } from "./stereo/rig.js";

const canvas = document.querySelector<HTMLCanvasElement>("#world-canvas")!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setScissorTest(true);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0e0f);
scene.add(new THREE.HemisphereLight(0xe8ffff, 0x263137, 2.4));
const sun = new THREE.DirectionalLight(0xfff1cc, 2); sun.position.set(4,8,3); scene.add(sun);
const floor = new THREE.Mesh(new THREE.BoxGeometry(16,1,16), new THREE.MeshStandardMaterial({color:0x68737a,roughness:.9})); floor.position.y=-.5; scene.add(floor);
const blockGroup = new THREE.Group(); scene.add(blockGroup);
const targetOutline=new THREE.Box3Helper(new THREE.Box3(),0xffd447);targetOutline.visible=false;scene.add(targetOutline);
const heldMesh = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color:0xffd447,transparent:true,opacity:.78})); heldMesh.visible=false; scene.add(heldMesh);
const materialColors = {stone:0x66767e,wood:0x9a6d43,water:0x3b8fc2} as const;
const unitBlockGeometry=new THREE.BoxGeometry(1,1,1);
const blockMaterials={stone:new THREE.MeshStandardMaterial({color:materialColors.stone,roughness:.85}),wood:new THREE.MeshStandardMaterial({color:materialColors.wood,roughness:.85}),water:new THREE.MeshStandardMaterial({color:materialColors.water,roughness:.35,transparent:true,opacity:.72})};
let model=createWorldModel(), heldPath:OctreePath|undefined, lastMinedPath:OctreePath|undefined, manipulation:"environment"|"object"="environment", viewClutch=false;
let renderedMeshes:THREE.Mesh[]=[];
function pathTransform(path:OctreePath) {
  const [rx,ry,rz]=path.root.split(",").map(Number) as [number,number,number];
  let size=1,x=rx,y=ry+.5,z=rz;
  for (const octant of path.octants) { size/=2; x+=(octant&1?1:-1)*size/2; y+=(octant&2?1:-1)*size/2; z+=(octant&4?1:-1)*size/2; }
  return {position:new THREE.Vector3(x,y,z),size};
}
function pathAtPosition(position:THREE.Vector3,depth:number):OctreePath {
  const rx=Math.round(position.x),ry=Math.max(0,Math.round(position.y-.5)),rz=Math.round(position.z);
  let minX=rx-.5,minY=ry,minZ=rz-.5,size=1;const octants:Octant[]=[];
  for(let level=0;level<depth;level++){const half=size/2;let octant=0;if(position.x>=minX+half){octant|=1;minX+=half;}if(position.y>=minY+half){octant|=2;minY+=half;}if(position.z>=minZ+half){octant|=4;minZ+=half;}octants.push(octant as Octant);size=half;}
  return {root:`${rx},${ry},${rz}`,octants};
}
function displayPaths(cell:MaterialCell):OctreePath[] {
  const target=model.viewDepth.get(cell.path.root)??0;
  let paths=[cell.path];
  while(paths[0]!.octants.length<target) paths=paths.flatMap(path=>Array.from({length:8},(_,i)=>childPath(path,i as Octant)));
  return paths;
}
function rebuildBlocks() {
  blockGroup.clear(); renderedMeshes=[];
  for(const cell of model.cells.values()) for(const path of displayPaths(cell)) {
    if(heldPath && encodeOctreePath(path)===encodeOctreePath(heldPath)) continue;
    const {position,size}=pathTransform(path); const mesh=new THREE.Mesh(unitBlockGeometry,blockMaterials[cell.material]);
    mesh.position.copy(position); mesh.scale.setScalar(size); if(cell.rotation)mesh.rotation.set(...cell.rotation);mesh.userData.path=path; blockGroup.add(mesh); renderedMeshes.push(mesh);
  }
}
rebuildBlocks();
const camera = new THREE.PerspectiveCamera(66,1,.05,100);
const stereo = new THREE.StereoCamera(); stereo.aspect=.5; stereo.eyeSep=.064;
const cursorElements=[...document.querySelectorAll<HTMLElement>(".world-cursors i")];
let state = initialWorldState(); const active = new Set<string>();
const bindings: Record<string,WorldAction> = {KeyW:"move-forward",KeyS:"move-back",KeyA:"move-left",KeyD:"move-right",Space:"move-up",KeyR:"move-up",ShiftLeft:"move-down",KeyF:"move-down",KeyH:"look-left",KeyL:"look-right",KeyK:"look-up",KeyJ:"look-down",KeyU:"focus-far",KeyI:"focus-near"};
function effectiveTarget(){return viewClutch?"environment":manipulation;}
function resolved(code:string):string|undefined {
  if(effectiveTarget()==="object") return ({KeyH:"object-yaw-left",KeyL:"object-yaw-right",KeyK:"object-pitch-up",KeyJ:"object-pitch-down",KeyQ:"object-roll-left",KeyE:"object-roll-right",KeyU:"object-far",KeyI:"object-near"} as Record<string,string>)[code]??bindings[code];
  return bindings[code]??({KeyQ:"orbit-left",KeyE:"orbit-right"} as Record<string,string>)[code];
}
const router = new WorldInputRouter({resolveAction:resolved,onPress:({action})=>active.add(action),onRelease:({action})=>active.delete(action)});
const raycaster=new THREE.Raycaster();
function focusedPath(){ raycaster.setFromCamera(new THREE.Vector2(0,0),camera); return (raycaster.intersectObjects(renderedMeshes,false)[0]?.object.userData.path as OctreePath|undefined); }
function discreteKey(event:KeyboardEvent){
  if(/^Digit\d$/.test(event.code)){ model=setSelectedSlot(model,event.code==="Digit0"?9:Number(event.code.slice(-1))-1); return true; }
  if(event.code==="KeyG"&&heldPath){manipulation=manipulation==="object"?"environment":"object";return true;}
  if(event.code==="KeyV"){viewClutch=true;return true;}
  if(event.code==="KeyY"||event.code==="KeyO"){const path=focusedPath();if(path){const d=model.viewDepth.get(path.root)??0;model=setViewDepth(model,path.root,d+(event.code==="KeyY"?1:-1));rebuildBlocks();}return true;}
  if(event.code==="Enter"){
    if(!heldPath){const focused=focusedPath();const materialized=focused?materializeCell(model,focused):undefined;if(focused&&materialized){model=materialized;heldPath=focused;const transform=pathTransform(heldPath);const cell=model.cells.get(encodeOctreePath(heldPath));manipulation="object";state={...state,heldDistance:Math.max(.35,camera.position.distanceTo(transform.position)),heldRotation:[...(cell?.rotation??[0,0,0])]};heldMesh.position.copy(transform.position);heldMesh.scale.setScalar(transform.size);heldMesh.rotation.set(...state.heldRotation);heldMesh.visible=true;rebuildBlocks();}}
    else {const target=pathAtPosition(heldMesh.position,heldPath.octants.length);const moved=moveCell(model,heldPath,target,state.heldRotation);if(moved){model=moved;heldPath=undefined;heldMesh.visible=false;manipulation="environment";rebuildBlocks();}}return true;
  }
  if(event.code==="KeyT"&&heldPath){heldPath=undefined;heldMesh.visible=false;manipulation="environment";rebuildBlocks();return true;}
  if(event.code==="Backspace"){const path=focusedPath();const next=path?mineCell(model,path):undefined;if(next){model=next;lastMinedPath=path;rebuildBlocks();}return true;}
  if(event.code==="KeyP"&&lastMinedPath){const next=placeCell(model,lastMinedPath);if(next){model=next;lastMinedPath=undefined;rebuildBlocks();}return true;}
  return false;
}
window.addEventListener("keydown",(event)=>{ if(!event.repeat&&discreteKey(event)){event.preventDefault();return;} if (router.keyDown(event.code,performance.now())) event.preventDefault(); });
window.addEventListener("keyup",(event)=>{ if(event.code==="KeyV")viewClutch=false; if (router.keyUp(event.code)) event.preventDefault(); });
window.addEventListener("blur",()=>router.releaseAll());
canvas.addEventListener("pointerdown",()=>canvas.focus());
let previous=performance.now(), accumulator=0;
function frame(now:number) {
  const width=canvas.clientWidth, height=canvas.clientHeight;
  if (canvas.width!==Math.round(width*renderer.getPixelRatio()) || canvas.height!==Math.round(height*renderer.getPixelRatio())) renderer.setSize(width,height,false);
  accumulator += Math.min(.1,(now-previous)/1000); previous=now;
  while (accumulator>=FIXED_DT) {
    const obstacles=[...model.cells.values()].filter(cell=>!heldPath||encodeOctreePath(cell.path)!==encodeOctreePath(heldPath)).map(cell=>{const t=pathTransform(cell.path);return [t.position.x,t.position.y,t.position.z,t.size] as const;});
    state=stepWorld(state,active as Set<WorldAction>,obstacles);
    accumulator-=FIXED_DT;
  }
  camera.position.set(...state.position); camera.rotation.order="YXZ"; camera.rotation.set(state.pitch,state.yaw,0); camera.aspect=width/height; camera.focus=Math.exp(state.logFocusDistance); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  updateStereoCameras(stereo,camera);
  const focusPoint=new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion).multiplyScalar(Math.exp(state.logFocusDistance)).add(camera.position);
  [stereo.cameraL,stereo.cameraR].forEach((eye,index)=>{const projected=focusPoint.clone().project(eye);const cursor=cursorElements[index];if(cursor){cursor.style.left=`${(index*0.5+(projected.x+1)*0.25)*width}px`;cursor.style.top=`${(1-projected.y)*0.5*height}px`;}});
  if(heldPath){const direction=new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);heldMesh.position.copy(camera.position).addScaledVector(direction,state.heldDistance);heldMesh.rotation.set(...state.heldRotation);}
  const half=Math.floor(width/2); renderer.setViewport(0,0,half,height); renderer.setScissor(0,0,half,height); renderer.render(scene,stereo.cameraL);
  renderer.setViewport(half,0,width-half,height); renderer.setScissor(half,0,width-half,height); renderer.render(scene,stereo.cameraR);
  const p=`${state.position.map(v=>v.toFixed(1)).join(" ")}`; document.querySelectorAll<HTMLElement>(".position").forEach(e=>e.textContent=p);
  document.querySelectorAll<HTMLElement>(".focus").forEach(e=>e.textContent=`FOCUS ${Math.exp(state.logFocusDistance).toFixed(1)}m`);
  const target=focusedPath(); document.querySelectorAll<HTMLElement>(".target").forEach(e=>e.textContent=`TARGET ${target?encodeOctreePath(target):"AIR"}`);
  const targetMesh=target?renderedMeshes.find(mesh=>encodeOctreePath(mesh.userData.path as OctreePath)===encodeOctreePath(target)):undefined;targetOutline.visible=!!targetMesh;if(targetMesh)targetOutline.box.setFromObject(targetMesh);
  document.querySelectorAll<HTMLElement>(".mode").forEach(e=>e.textContent=effectiveTarget()==="object"?"OBJECT":"ENV");
  const total=["stone","wood","water"].reduce((sum,m)=>sum+approximateDyadicNumber(materialTotal(model,m as "stone"|"wood"|"water")),0);
  document.querySelectorAll<HTMLElement>(".mass").forEach(e=>e.textContent=`MASS ${total.toFixed(3)}m³`);
  const slots=model.slots.slice(0,3).map((s,i)=>`${i+1}${i===model.selectedSlot?"*":""}:${s.material?.[0]?.toUpperCase()??"-"} ${approximateDyadicNumber(s.amount).toFixed(3)}`).join(" · ");
  document.querySelectorAll<HTMLElement>(".slots").forEach(e=>e.textContent=slots);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
