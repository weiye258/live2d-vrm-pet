// ============================================================
// VRM Adapter v3 — Three.js + @pixiv/three-vrm
// 核心修复：deprecated API 全部替换 + 完整 idle 动画 + 手臂自然下垂
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// ============ 安全获取骨骼节点 ============
function getBoneNode(humanoid, boneName) {
  if (!humanoid) return null;
  try {
    const bone = humanoid.getRawBone(boneName);
    if (bone && bone.node) return bone.node;
  } catch (e) {}
  try {
    const bone = humanoid.getBone(boneName);
    if (bone && bone.node) return bone.node;
    if (bone && bone.rotation) return bone;
  } catch (e) {}
  return null;
}

// ============ VRMRenderer ============
class VRMRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.vrm = null;
    this.clock = new THREE.Clock();
    this.loader = null;
    this._animId = null;

    this._gazeTarget = { x: 0, y: 0 };
    this._lipSyncValue = 0;
    this._zoomLevel = 1.0;
    this._offsetX = 0;   // 模型在画面中的水平偏移（世界单位，正交相机下 = 画面平移）
    this._offsetY = 0;   // 模型在画面中的垂直偏移
    this._idleEnabled = true;
    this._gazeEnabled = true;

    // 右键旋转
    this._rotY = 0;
    this._rotDragging = false;
    this._rotLastX = 0;

    // idle 动画计时器
    this._t = 0; // 全局时间
    this._blinkTimer = 3; // 首次眨眼延迟
    this._blinkState = 0;
    this._blinkValue = 0;
    this._headTiltTimer = 0;
    this._headTiltTarget = { x: 0, y: 0, z: 0 };
    this._headTiltCurrent = { x: 0, y: 0, z: 0 };

    this._modelWidth = 0;
    this._modelHeight = 0;

    // 记录骨骼初始旋转（用于 idle 动画叠加）
    this._initPose = {};

    // 模型自带动画（glTF animations）：有则优先播放模型自己的动作
    this._clips = [];
    this._mixer = null;
    this._clipAction = null;
    this._acting = false;
    this._actingUntil = 0;

    this._init();
  }

  _init() {
    this.scene = new THREE.Scene();

    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const aspect = w / h;
    const frustum = 2.0;
    this.camera = new THREE.OrthographicCamera(
      -frustum * aspect, frustum * aspect, frustum, -frustum, 0.1, 100
    );
    this.camera.position.set(0, 1.0, 5);
    this.camera.lookAt(0, 1.0, 0);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, alpha: true, antialias: true, premultipliedAlpha: false,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // 三点布光
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xfff5e6, 0.9);
    key.position.set(2, 3, 3); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(key);
    this.scene.add(new THREE.DirectionalLight(0xe6f0ff, 0.4).translateX(-3).translateY(2).translateZ(2));
    this.scene.add(new THREE.DirectionalLight(0xffffff, 0.3).translateY(2).translateZ(-3));
    this.scene.add(new THREE.DirectionalLight(0xfff8f0, 0.25).translateY(5).translateZ(1));

    // 地面阴影
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.ShadowMaterial({ opacity: 0.15 })
    );
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; ground.receiveShadow = true;
    this.scene.add(ground);

    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));

    this._onResize = () => this.resize(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', this._onResize);

    // 右键旋转（不阻止 contextmenu，让右键菜单正常弹出）
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) { this._rotDragging = true; this._rotLastX = e.clientX; }
    });
    window.addEventListener('mousemove', (e) => {
      if (!this._rotDragging) return;
      this._rotY += (e.clientX - this._rotLastX) * 0.01;
      this._rotLastX = e.clientX;
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 2) this._rotDragging = false; });
  }

  // ============ 模型加载 ============
  async loadModel(path) {
    this.destroy();
    if (path.toLowerCase().endsWith('.obj')) return this._loadOBJ(path);
    return this._loadVRM(path);
  }

  _loadVRM(path) {
    return new Promise((resolve, reject) => {
      this.loader.load(path, (gltf) => {
        const vrm = gltf.userData.vrm;
        if (!vrm) { reject(new Error('Not a valid VRM')); return; }
        try { VRMUtils.removeUnnecessaryVertices(gltf.scene); } catch (e) {}
        try { VRMUtils.combineSkeletons(gltf.scene); } catch (e) {}

        this.vrm = vrm;
        this.scene.add(vrm.scene);
        vrm.scene.rotation.y = Math.PI;
        this._enableShadows(vrm.scene);
        this._alignToGround(vrm.scene);

        // 诊断：列出所有可用骨骼
        try {
          const hm = vrm.humanoid;
          if (hm) {
            const boneNames = [];
            // v3.x: humanoid 有 rawHumanBones 属性
            if (hm.rawHumanBones) {
              for (const [k, v] of Object.entries(hm.rawHumanBones)) {
                if (v && v.node) boneNames.push(k);
              }
            }
            console.log('[VRM] Available bones (' + boneNames.length + '):', boneNames.join(', '));
          }
        } catch (e) { console.log('[VRM] bone enum error:', e.message); }

        // 记录初始姿态
        this._saveInitPose();

        // 收集模型自带动画（glTF animations），有则动作优先用模型自己的
        this._clips = (gltf.animations && gltf.animations.length) ? gltf.animations : (vrm.scene.animations || []);
        if (this._clips.length) {
          try { this._mixer = new THREE.AnimationMixer(vrm.scene); } catch (e) { this._mixer = null; }
          console.log('[VRM] 发现模型自带动画 ' + this._clips.length + ' 个: ' + this._clips.map(c => c.name || '(未命名)').join(', '));
        } else {
          this._mixer = null;
          console.log('[VRM] 模型无自带动画，触发动作时不会播放动画');
        }

        // 重置手臂到自然下垂（覆盖 T-pose）
        this._resetArmsToIdle();

        this._fitCamera();
        this._startLoop();
        console.log('[VRM] Loaded:', path);
        resolve(vrm);
      }, (p) => {
        const pct = p.total ? Math.round(100 * p.loaded / p.total) : 0;
        console.log('[VRM] Loading...', pct + '%');
      }, reject);
    });
  }

  _loadOBJ(path) {
    return new Promise((resolve, reject) => {
      const basePath = path.substring(0, path.lastIndexOf('/') + 1);
      const mtlPath = path.replace('.obj', '.mtl');
      const mtlLoader = new MTLLoader();
      mtlLoader.setResourcePath(basePath);
      mtlLoader.load(mtlPath, (materials) => {
        materials.preload();
        new OBJLoader().setMaterials(materials).load(path,
          (obj) => this._onOBJLoaded(obj, path, resolve), undefined, reject);
      }, () => {
        new OBJLoader().load(path, (obj) => this._onOBJLoaded(obj, path, resolve), undefined, reject);
      });
    });
  }

  _onOBJLoaded(obj, path, resolve) {
    this._objGroup = obj;
    this.scene.add(obj);
    this._enableShadows(obj);
    this._alignToGround(obj);
    this.vrm = { scene: obj, humanoid: null, expressionManager: null, lookAt: null, update: () => {} };
    this._fitCamera(); this._startLoop();
    console.log('[OBJ] Loaded:', path);
    resolve(this.vrm);
  }

  _enableShadows(group) {
    group.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true; obj.receiveShadow = true;
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach(m => { m.side = THREE.DoubleSide; });
        }
      }
    });
  }

  _alignToGround(group) {
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3(); box.getSize(size);
    this._modelWidth = size.x; this._modelHeight = size.y;
    if (box.min.y < -0.1) group.position.y -= box.min.y;
  }

  // ============ 记录初始姿态 ============
  _saveInitPose() {
    if (!this.vrm || !this.vrm.humanoid) return;
    this._initPose = {};
    const bones = ['head', 'spine', 'chest', 'upperChest', 'neck',
      'leftUpperArm', 'leftLowerArm', 'leftHand',
      'rightUpperArm', 'rightLowerArm', 'rightHand',
      'hips'];
    let found = 0;
    for (const name of bones) {
      const node = getBoneNode(this.vrm.humanoid, name);
      if (node) {
        this._initPose[name] = { x: node.rotation.x, y: node.rotation.y, z: node.rotation.z };
        found++;
      }
    }
    console.log('[VRM] Init pose saved:', found, 'bones out of', bones.length);
  }

  // ============ 手臂自然下垂（覆盖 T-pose）============
  _resetArmsToIdle() {
    if (!this.vrm || !this.vrm.humanoid) { console.log('[VRM] no humanoid'); return; }
    const hm = this.vrm.humanoid;

    // 尝试所有可能的骨骼名
    const tryBone = (names) => {
      for (const n of names) {
        const node = getBoneNode(hm, n);
        if (node) return node;
      }
      return null;
    };

    const leftUpper = tryBone(['leftUpperArm', 'LeftUpperArm', 'leftArm', 'LeftArm']);
    const rightUpper = tryBone(['rightUpperArm', 'RightUpperArm', 'rightArm', 'RightArm']);
    const leftLower = tryBone(['leftLowerArm', 'LeftLowerArm', 'leftForeArm', 'LeftForeArm']);
    const rightLower = tryBone(['rightLowerArm', 'RightLowerArm', 'rightForeArm', 'RightForeArm']);
    const leftHand = tryBone(['leftHand', 'LeftHand']);
    const rightHand = tryBone(['rightHand', 'RightHand']);

    console.log('[VRM] Arm bones:', {
      leftUpper: !!leftUpper, rightUpper: !!rightUpper,
      leftLower: !!leftLower, rightLower: !!rightLower,
      leftHand: !!leftHand, rightHand: !!rightHand
    });

    // 手臂自然下垂（VRM T-pose 手臂平伸，需要大幅度旋转）
    // 左臂：z 正方向 = 向身体内侧（右手坐标系）
    // 右臂：z 负方向 = 向身体内侧
    if (leftUpper) { leftUpper.rotation.z = 1.3; leftUpper.rotation.x = 0.1; console.log('[VRM] leftUpper rotated z=1.3'); }
    if (rightUpper) { rightUpper.rotation.z = -1.3; rightUpper.rotation.x = 0.1; console.log('[VRM] rightUpper rotated z=-1.3'); }
    if (leftLower) { leftLower.rotation.x = 0.3; leftLower.rotation.y = -0.2; }
    if (rightLower) { rightLower.rotation.x = 0.3; rightLower.rotation.y = 0.2; }
    if (leftHand) { leftHand.rotation.x = 0.1; leftHand.rotation.z = 0.1; }
    if (rightHand) { rightHand.rotation.x = 0.1; rightHand.rotation.z = -0.1; }

    this._saveInitPose();
  }

  // ============ 相机/缩放 ============
  _fitCamera() {
    if (!this.vrm) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const aspect = w / h;
    const frustum = ((this._modelHeight || 2.0) / 0.55) / this._zoomLevel;
    this.camera.left = -frustum * aspect; this.camera.right = frustum * aspect;
    this.camera.top = frustum; this.camera.bottom = -frustum;
    const box = new THREE.Box3().setFromObject(this.vrm.scene);
    const center = new THREE.Vector3(); box.getCenter(center);
    // 相机平移 = 画面平移：模型显示位置由用户拖拽的偏移决定，视线仍对准模型中心
    this.camera.position.set(center.x + this._offsetX, center.y + this._offsetY, 5);
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
  }

  setZoom(level) { this._zoomLevel = Math.max(0.3, Math.min(5.0, level)); this._fitCamera(); }
  setOffset(x, y) { this._offsetX = Number(x) || 0; this._offsetY = Number(y) || 0; this._fitCamera(); }
  getOffset() { return { x: this._offsetX, y: this._offsetY }; }
  // 按屏幕像素增量移动模型位置（正交相机：换算世界单位），返回最新偏移
  offsetByScreen(dx, dy) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const aspect = w / h;
    const frustum = ((this._modelHeight || 2.0) / 0.55) / this._zoomLevel;
    this._offsetX += (dx / w) * frustum * aspect * 2;
    this._offsetY -= (dy / h) * frustum * 2;   // 屏幕 y 向下，世界 y 向上
    this._fitCamera();
    return { x: this._offsetX, y: this._offsetY };
  }
  setGaze(nx, ny) { this._gazeTarget.x = Math.max(-1, Math.min(1, nx)); this._gazeTarget.y = Math.max(-1, Math.min(1, ny)); }
  setIdleEnabled(v) { this._idleEnabled = !!v; }
  setGazeEnabled(v) { this._gazeEnabled = !!v; }

  // ============ 表情 ============
  playExpression(name) {
    if (!this.vrm?.expressionManager) return false;
    const map = { 'happy': 'happy', '开心': 'happy', 'angry': 'angry', '生气': 'angry',
      'sad': 'sad', '悲伤': 'sad', 'relaxed': 'relaxed', '放松': 'relaxed',
      'surprised': 'surprised', '惊讶': 'surprised', 'neutral': 'neutral', '默认': 'neutral' };
    const vrmName = map[name] || name.toLowerCase();
    try {
      ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'].forEach(n => {
        try { this.vrm.expressionManager.setValue(n, 0); } catch (e) {}
      });
      this.vrm.expressionManager.setValue(vrmName, 1.0);
      setTimeout(() => { try { this.vrm.expressionManager.setValue(vrmName, 0); } catch (e) {} }, 3000);
      return true;
    } catch (e) { return false; }
  }

  setLipSync(value) { this._lipSyncValue = Math.max(0, Math.min(1, value)); }

  // ============ 动作 ============
  playMotion(name) {
    if (!this.vrm) return false;
    // 只播模型自带动画；模型没有自带动画就不动（不再用程序化骨骼动作兜底）
    return this._playClip(name);
  }

  // 播放模型自带动画：优先按名称匹配（jump/dance/wave…），无匹配则随机播放模型自己的动作
  _playClip(name) {
    if (!this._mixer || !this._clips.length) return false;
    let clip = null;
    const lower = String(name || '').toLowerCase();
    for (const c of this._clips) {
      const cn = String(c.name || '').toLowerCase();
      if (cn === lower || (lower && (cn.includes(lower) || lower.includes(cn)))) { clip = c; break; }
    }
    if (!clip) clip = this._clips[Math.floor(Math.random() * this._clips.length)];
    if (!clip) return false;
    try {
      if (this._clipAction) this._clipAction.stop();
      this._clipAction = this._mixer.clipAction(clip);
      this._clipAction.reset().fadeIn(0.2).play();
      this._clipAction.setLoop(THREE.LoopOnce, 1);
      this._clipAction.clampWhenFinished = true;
      this._acting = true;
      this._actingUntil = performance.now() + (clip.duration * 1000 + 300);
      try { if (this.vrm?.lookAt) this.vrm.lookAt.enable = false; } catch (e) {}
      console.log('[VRM] 播放模型自带动画: ' + (clip.name || '(未命名)'));
      return true;
    } catch (e) {
      console.log('[VRM] 播放自带动画失败: ' + e.message);
      return false;
    }
  }
  // 自带动画播完后恢复 idle 待机
  _autoEndAction() {
    if (!this._acting || !this._actingUntil) return;
    if (performance.now() >= this._actingUntil) {
      this._acting = false;
      this._actingUntil = 0;
      try { if (this.vrm?.lookAt) this.vrm.lookAt.enable = true; } catch (e) {}
    }
  }

  getMotionGroups() {
    // 只有模型文件里真的有自带动画时，才作为「动作组」展示；没有就返回空，避免误导
    if (this._clips && this._clips.length) {
      return this._clips.map(c => c.name).filter(Boolean);
    }
    return [];
  }
  getExpressionNames() {
    // 只展示模型真实带的表情；没有表情管理就直接返回空，不伪造默认列表
    if (!this.vrm?.expressionManager) return [];
    try { const m = this.vrm.expressionManager.expressionMap; if (m) return Object.keys(m); } catch (e) {}
    return [];
  }
  getSize() { return { w: this._modelWidth, h: this._modelHeight }; }

  // ============ 渲染循环 ============
  _startLoop() {
    if (this._animId) return;
    const loop = () => {
      this._animId = requestAnimationFrame(loop);
      const delta = this.clock.getDelta();
      this._update(delta);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }
  _stopLoop() { if (this._animId) { cancelAnimationFrame(this._animId); this._animId = null; } }

  // ============ 每帧更新 ============
  _update(delta) {
    if (!this.vrm) return;
    // 自带动画播完后自动恢复待机
    this._autoEndAction();
    // 推进模型自带动画（AnimationMixer 需每帧 update 才会播放）
    if (this._mixer) this._mixer.update(delta);
    try { this.vrm.update(delta); } catch (e) {}

    // 右键旋转
    if (this.vrm.scene) this.vrm.scene.rotation.y = Math.PI + this._rotY;

    // 视线跟随（用 VRM 自带 lookAt 系统）
    if (this._gazeEnabled) this._updateLookAt();

    // idle 动画（动作播放期间暂停骨骼晃动，避免干扰模型自带动画）
    if (this._idleEnabled) {
      this._t += delta;
      this._updateBlink(delta);
      if (!this._acting) this._updateIdleBody(delta);
    }

    this._updateLipSync();
  }

  // ---- 视线跟随（通过 VRM lookAt 目标）----
  _updateLookAt() {
    if (!this.vrm?.lookAt) return;
    // three-vrm v3.x: 设置 lookAt 的目标位置
    // lookAt.target 是一个 Object3D，设置它的世界位置来控制视线方向
    try {
      const target = this.vrm.lookAt.target;
      if (target) {
        // 把目标放在相机前方，偏移量由鼠标控制
        target.position.set(
          this._gazeTarget.x * 2,
          1.0 - this._gazeTarget.y * 1.5,
          5
        );
      }
    } catch (e) {}
  }

  // ---- 眨眼 ----
  _updateBlink(delta) {
    if (!this.vrm?.expressionManager) return;
    this._blinkTimer -= delta;
    if (this._blinkState === 0 && this._blinkTimer <= 0) {
      this._blinkState = 1; this._blinkTimer = 0;
    }
    const speed = 12;
    switch (this._blinkState) {
      case 1: this._blinkValue += delta * speed; if (this._blinkValue >= 1) { this._blinkValue = 1; this._blinkState = 2; this._blinkTimer = 0.06; } break;
      case 2: this._blinkTimer -= delta; if (this._blinkTimer <= 0) { this._blinkState = 3; } break;
      case 3: this._blinkValue -= delta * speed; if (this._blinkValue <= 0) { this._blinkValue = 0; this._blinkState = 0; this._blinkTimer = 2 + Math.random() * 4; } break;
    }
    try { this.vrm.expressionManager.setValue('blink', this._blinkValue); } catch (e) {}
  }

  // ---- idle 全身动画（呼吸+摇摆+手臂摆动+头部随机）----
  _updateIdleBody(delta) {
    if (!this.vrm?.humanoid) return;
    const t = this._t;
    const ip = this._initPose;

    // 呼吸：胸部起伏（明显）
    const chest = getBoneNode(this.vrm.humanoid, 'chest');
    if (chest && ip.chest) chest.rotation.x = ip.chest.x + Math.sin(t * 1.2) * 0.04;

    const spine = getBoneNode(this.vrm.humanoid, 'spine');
    if (spine && ip.spine) spine.rotation.x = ip.spine.x + Math.sin(t * 1.2 + 0.3) * 0.03;

    // 重心：轻转身 + 微小的左右倾斜（不做左右平移，避免整体左右移动显得怪异）
    const hips = getBoneNode(this.vrm.humanoid, 'hips');
    if (hips && ip.hips) {
      hips.rotation.z = ip.hips.z + Math.sin(t * 0.5) * 0.02;
      hips.rotation.y = ip.hips.y + Math.sin(t * 0.3) * 0.03;
    }

    // 手臂摆动（在自然下垂基础上明显摆动）
    const lArm = getBoneNode(this.vrm.humanoid, 'leftUpperArm');
    const rArm = getBoneNode(this.vrm.humanoid, 'rightUpperArm');
    if (lArm && ip.leftUpperArm) {
      lArm.rotation.x = ip.leftUpperArm.x + Math.sin(t * 0.8) * 0.08;
      lArm.rotation.z = ip.leftUpperArm.z + Math.sin(t * 0.6) * 0.05;
    }
    if (rArm && ip.rightUpperArm) {
      rArm.rotation.x = ip.rightUpperArm.x + Math.sin(t * 0.8 + 1) * 0.08;
      rArm.rotation.z = ip.rightUpperArm.z + Math.sin(t * 0.6 + 1) * 0.05;
    }

    // 小臂摆动
    const lFore = getBoneNode(this.vrm.humanoid, 'leftLowerArm');
    const rFore = getBoneNode(this.vrm.humanoid, 'rightLowerArm');
    if (lFore && ip.leftLowerArm) lFore.rotation.x = ip.leftLowerArm.x + Math.sin(t * 1.0) * 0.1;
    if (rFore && ip.rightLowerArm) rFore.rotation.x = ip.rightLowerArm.x + Math.sin(t * 1.0 + 0.5) * 0.1;

    // 手掌微动
    for (const name of ['leftHand', 'rightHand']) {
      const bone = getBoneNode(this.vrm.humanoid, name);
      if (bone && ip[name]) bone.rotation.x = ip[name].x + Math.sin(t * 1.5 + name.length) * 0.08;
    }

    // 头部：视线跟随鼠标 + 随机歪头
    this._headTiltTimer -= delta;
    if (this._headTiltTimer <= 0) {
      this._headTiltTarget = {
        x: (Math.random() - 0.5) * 0.15,
        y: (Math.random() - 0.5) * 0.2,
        z: (Math.random() - 0.5) * 0.1,
      };
      this._headTiltTimer = 5 + Math.random() * 5;
    }
    const head = getBoneNode(this.vrm.humanoid, 'head');
    if (head && ip.head) {
      const smooth = 0.05;
      this._headTiltCurrent.x += (this._headTiltTarget.x - this._headTiltCurrent.x) * smooth;
      this._headTiltCurrent.y += (this._headTiltTarget.y - this._headTiltCurrent.y) * smooth;
      this._headTiltCurrent.z += (this._headTiltTarget.z - this._headTiltCurrent.z) * smooth;
      // 鼠标跟随 + 随机歪头 + 轻微呼吸点头
      const gazeX = this._gazeEnabled ? this._gazeTarget.x * 0.15 : 0;
      const gazeY = this._gazeEnabled ? -this._gazeTarget.y * 0.1 : 0;
      head.rotation.x = ip.head.x + this._headTiltCurrent.x + gazeY + Math.sin(t * 1.5) * 0.02;
      head.rotation.y = ip.head.y + this._headTiltCurrent.y + gazeX;
      head.rotation.z = ip.head.z + this._headTiltCurrent.z;
    }
  }

  // ---- 口型同步 ----
  _updateLipSync() {
    if (!this.vrm?.expressionManager) return;
    try { this.vrm.expressionManager.setValue('aa', this._lipSyncValue); } catch (e) {}
  }

  // ============ resize / destroy / dispose ============
  resize(w, h) { if (this.renderer && this.camera) { this.renderer.setSize(w, h); this._fitCamera(); } }

  destroy() {
    this._stopLoop();
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      try { VRMUtils.deepDispose(this.vrm.scene); } catch (e) {}
      this.vrm = null;
    }
    this._modelWidth = 0; this._modelHeight = 0;
    this._blinkState = 0; this._blinkValue = 0; this._blinkTimer = 3;
    this._t = 0; this._rotY = 0; this._rotDragging = false;
    this._initPose = {};
    this._headTiltTarget = { x: 0, y: 0, z: 0 };
    this._headTiltCurrent = { x: 0, y: 0, z: 0 };
    this._headTiltTimer = 0;
    this._lipSyncValue = 0; this._gazeTarget = { x: 0, y: 0 };
  }

  dispose() {
    this.destroy();
    if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
    window.removeEventListener('resize', this._onResize);
  }
}

window.VRMAdapter = VRMRenderer;
window.dispatchEvent(new Event('vrm-adapter-ready'));
