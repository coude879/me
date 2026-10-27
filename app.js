import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
// Meshopt 解码器（ESM 版本，直接从 Three.js CDN 引入）
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

/* ============================================================
   DOM
   ============================================================ */
const canvas = document.getElementById("cityCanvas");
const stage = document.getElementById("cityStage");
const loadStatus = document.getElementById("loadStatus");
const hintEl = document.querySelector(".stage-hint");

/* ============================================================
   渲染器（像素精确 + 高性能）
   ============================================================ */
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
  stencil: false,
});
renderer.outputColorSpace = THREE.SRGBColorSpace;

/* ============================================================
   场景 / 相机 / 控制器
   ============================================================ */
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 300);
camera.position.set(14, 10, 18);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.85;
controls.zoomSpeed = 0.75;
controls.minDistance = 5;
controls.maxDistance = 50;
controls.maxPolarAngle = Math.PI / 2.1;
controls.screenSpacePanning = false;
controls.target.set(0, 2, 0);

/* ============================================================
   灯光（保持原有氛围）
   ============================================================ */
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1a2e, 1.5));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
keyLight.position.set(14, 22, 12);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x7c9cff, 0.7);
fillLight.position.set(-12, 7, -10);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xb48cff, 0.45);
rimLight.position.set(-6, 5, 16);
scene.add(rimLight);

const shadowDisc = new THREE.Mesh(
  new THREE.CircleGeometry(9, 64),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false })
);
shadowDisc.rotation.x = -Math.PI / 2;
shadowDisc.position.y = -0.04;
scene.add(shadowDisc);

/* ============================================================
   状态
   ============================================================ */
let cityModel = null;
let lastFitAspect = 1;
let hasUserInteracted = false;
let autoRotate = true;
let resumeTimer = 0;
let isVisible = true;

/* ============================================================
   尺寸适配（防边缘抖动，逻辑不变）
   ============================================================ */
let curW = 0, curH = 0, curDpr = 0;
let resizeScheduled = false;

function applySize() {
  const rect = stage.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const w = Math.ceil(rect.width);
  const h = Math.ceil(rect.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (w === curW && h === curH && dpr === curDpr) return;
  curW = w; curH = h; curDpr = dpr;
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, true);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (!hasUserInteracted && cityModel) {
    const ratio = Math.abs(camera.aspect - lastFitAspect) / lastFitAspect;
    if (ratio > 0.18) fitCameraToModel();
  }
}

function scheduleResize() {
  if (resizeScheduled) return;
  resizeScheduled = true;
  requestAnimationFrame(() => { resizeScheduled = false; applySize(); });
}

new ResizeObserver(scheduleResize).observe(stage);
window.addEventListener("resize", scheduleResize, { passive: true });
window.addEventListener("orientationchange", scheduleResize, { passive: true });
applySize();

/* ============================================================
   ★ 核心：Meshopt + 渐进式加载
   ============================================================ */

// ① 创建 GLTFLoader，挂载 MeshoptDecoder
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

// ② 渐进式模型 URL（Needle Cloud 已处理为多层 LOD）
// 如果你有自己的模型，先用 gltfpack -cc 压缩为 meshopt 格式，
// 再通过 Needle Cloud 或 gltf-progressive 工具链处理为渐进式。
const CITY_URL =
  "https://cloud.needle.tools/-/assets/Z23hmXB2oYehK-2oYehK-world/file";

// ③ 标记状态：轻量模型到达前
hintEl.classList.add("loading");
loadStatus.textContent = "正在加载轻量模型…";

loader.load(
  CITY_URL,
  (gltf) => {
    const model = gltf.scene;

    // --- 自动缩放与居中（不变）---
    const box0 = new THREE.Box3().setFromObject(model);
    const size0 = box0.getSize(new THREE.Vector3());
    const maxDim = Math.max(size0.x, size0.y, size0.z) || 1;
    const scale = 12 / maxDim;
    model.scale.setScalar(scale);
    model.updateMatrixWorld(true);

    const box1 = new THREE.Box3().setFromObject(model);
    const center = box1.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box1.min.y, -center.z);

    scene.add(model);
    cityModel = model;
    fitCameraToModel();

    // --- 轻量模型就绪：画面立即出现，退出 loading 态 ---
    hintEl.classList.remove("loading");
    hintEl.classList.add("loaded");
    loadStatus.textContent = "轻量模型已就绪 · 细节流式加载中";
  },
  (xhr) => {
    // 可选的下载进度（渐进式加载下初始包很小，进度可能瞬间完成）
    if (xhr.total) {
      const pct = Math.round((xhr.loaded / xhr.total) * 100);
      loadStatus.textContent = `下载中 ${pct}%`;
    }
  },
  (err) => {
    console.error("城市模型加载失败：", err);
    hintEl.classList.remove("loading");
    loadStatus.textContent = "模型加载失败，请刷新重试";
  }
);

/* ============================================================
   自适应取景（不变）
   ============================================================ */
function fitCameraToModel() {
  if (!cityModel) return;
  const box = new THREE.Box3().setFromObject(cityModel);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;

  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const distV = radius / Math.sin(vFov / 2);
  const distH = radius / Math.sin(hFov / 2);
  const dist = Math.max(distV, distH) * 1.12;

  const dir = new THREE.Vector3(0.62, 0.46, 0.72).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  controls.target.copy(center);
  controls.minDistance = radius * 0.9;
  controls.maxDistance = dist * 2.6;
  controls.update();
  lastFitAspect = camera.aspect;
}

/* ============================================================
   交互 / 可见性 / 渲染循环（均不变）
   ============================================================ */
controls.addEventListener("start", () => {
  hasUserInteracted = true;
  autoRotate = false;
  clearTimeout(resumeTimer);
});
controls.addEventListener("end", () => {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => { autoRotate = true