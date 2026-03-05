import * as THREE from 'three';

// --- Global Game State ---
let speed = 0;
let baseSpeed = 1.0;
let score = 0;
let isGameOver = false;
let isGameStarted = false;
let obstacles = [];
let stars = [];
const laneWidth = 3;
const carSpeedX = 20;

// --- Setup Three.js Scene ---
const canvas = document.querySelector('#gameCanvas');
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.015); // Deep space fog

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 4, 12);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, canvas: canvas });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

// Bloom Effect (Post-processing) setup could be added here for stronger neon, 
// using Three.js EffectComposer, but we'll try to achieve it with materials first for simplicity & perf.

// --- Environment: Space Background ---
const createStars = () => {
    const starsGeometry = new THREE.BufferGeometry();
    const starsCount = 4000;
    const posArray = new Float32Array(starsCount * 3);
    const colorArray = new Float32Array(starsCount * 3);

    for (let i = 0; i < starsCount * 3; i++) {
        // Spread stars widely
        if (i % 3 === 0) posArray[i] = (Math.random() - 0.5) * 400; // x
        if (i % 3 === 1) posArray[i] = (Math.random() - 0.5) * 200 + 50; // y (keep mostly above/level)
        if (i % 3 === 2) posArray[i] = (Math.random() - 0.5) * 400; // z

        // Slight color variation (blue/orange tint)
        colorArray[i] = Math.random() > 0.8 ? 1.0 : 0.6; // R
        colorArray[i + 1] = Math.random() > 0.8 ? 0.6 : 0.8; // G
        colorArray[i + 2] = Math.random() > 0.5 ? 1.0 : 0.8; // B
    }

    starsGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    starsGeometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));

    const starsMaterial = new THREE.PointsMaterial({
        size: 0.2,
        vertexColors: true,
        transparent: true,
        opacity: 0.8
    });

    const starMesh = new THREE.Points(starsGeometry, starsMaterial);
    scene.add(starMesh);
    return starMesh;
};
const starField = createStars();


// --- Environment: Moving Neon Grid Road ---
// We create a wide plane with a grid texture mapped onto it, or actual GridHelper
const gridGroup = new THREE.Group();
const gridHelper1 = new THREE.GridHelper(200, 50, 0xff8800, 0xff5500);
gridHelper1.position.y = -1;
gridHelper1.material.opacity = 0.5;
gridHelper1.material.transparent = true;
gridGroup.add(gridHelper1);

const gridHelper2 = new THREE.GridHelper(200, 50, 0xffaa00, 0x552200);
gridHelper2.position.y = -1;
gridHelper2.position.z = -200; // Place behind first grid
gridHelper2.material.opacity = 0.5;
gridHelper2.material.transparent = true;
gridGroup.add(gridHelper2);
scene.add(gridGroup);


// --- Player Car ---
const createCar = () => {
    const car = new THREE.Group();

    // --- Materials ---
    const bodyMat = new THREE.MeshStandardMaterial({
        color: 0x111111,
        roughness: 0.2,
        metalness: 0.8
    });
    const glassMat = new THREE.MeshStandardMaterial({
        color: 0xffddaa,
        roughness: 0.1,
        metalness: 0.9,
        emissive: 0xff8800,
        emissiveIntensity: 0.6
    });
    const neonMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
    const lineMat = new THREE.LineBasicMaterial({ color: 0xff8800, linewidth: 2 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 });

    // --- Geometry Composition ---

    // Base chassis
    const chassisGeo = new THREE.BoxGeometry(2.2, 0.4, 4.6);
    const chassis = new THREE.Mesh(chassisGeo, bodyMat);
    chassis.position.set(0, 0.3, 0);

    // Front wedge (hood)
    const hoodGeo = new THREE.BoxGeometry(2.0, 0.3, 1.8);
    const hood = new THREE.Mesh(hoodGeo, bodyMat);
    hood.position.set(0, 0.45, -1.8);
    hood.rotation.x = Math.PI / 16; // sloped down slightly

    // Cabin
    const cabinGeo = new THREE.BoxGeometry(1.6, 0.5, 2.0);
    const cabin = new THREE.Mesh(cabinGeo, bodyMat);
    cabin.position.set(0, 0.75, 0.2);

    // Windshield (glowing)
    const windshieldGeo = new THREE.PlaneGeometry(1.5, 1.2);
    const windshield = new THREE.Mesh(windshieldGeo, glassMat);
    windshield.position.set(0, 0.78, -0.65);
    windshield.rotation.x = -Math.PI / 3.5;

    // Spoiler
    const spoilerWingGeo = new THREE.BoxGeometry(2.4, 0.1, 0.6);
    const spoilerWing = new THREE.Mesh(spoilerWingGeo, bodyMat);
    spoilerWing.position.set(0, 1.2, 2.1);

    const spoilerStrutGeo = new THREE.BoxGeometry(0.1, 0.5, 0.2);
    const strutL = new THREE.Mesh(spoilerStrutGeo, bodyMat);
    strutL.position.set(-0.8, 0.95, 2.0);
    const strutR = new THREE.Mesh(spoilerStrutGeo, bodyMat);
    strutR.position.set(0.8, 0.95, 2.0);

    // Wheels
    const tireGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.3, 24);
    const rimGeo = new THREE.TorusGeometry(0.28, 0.05, 12, 24);

    const createWheel = (x, z) => {
        const wheel = new THREE.Group();
        const tire = new THREE.Mesh(tireGeo, tireMat);
        tire.rotation.z = Math.PI / 2;

        const rim = new THREE.Mesh(rimGeo, neonMat);
        rim.rotation.y = Math.PI / 2;
        rim.position.x = x > 0 ? 0.16 : -0.16; // Push rim to the outside face

        wheel.add(tire);
        wheel.add(rim);
        wheel.position.set(x, 0.45, z);
        return wheel;
    };

    const w1 = createWheel(-1.25, -1.5);
    const w2 = createWheel(1.25, -1.5);
    const w3 = createWheel(-1.25, 1.6);
    const w4 = createWheel(1.25, 1.6);

    // Headlights (Neon slits)
    const hlightGeo = new THREE.BoxGeometry(0.6, 0.05, 0.05);
    const hlL = new THREE.Mesh(hlightGeo, neonMat);
    hlL.position.set(-0.7, 0.4, -2.65);
    const hlR = new THREE.Mesh(hlightGeo, neonMat);
    hlR.position.set(0.7, 0.4, -2.65);

    // Edge Lines (Tron effect)
    const addEdges = (mesh, geo) => {
        const edges = new THREE.EdgesGeometry(geo);
        const line = new THREE.LineSegments(edges, lineMat);
        line.position.copy(mesh.position);
        line.rotation.copy(mesh.rotation);
        return line;
    };

    // Assemble Car
    car.add(chassis); car.add(addEdges(chassis, chassisGeo));
    car.add(hood); car.add(addEdges(hood, hoodGeo));
    car.add(cabin); car.add(addEdges(cabin, cabinGeo));
    car.add(windshield); // Glow effect from material
    car.add(spoilerWing); car.add(addEdges(spoilerWing, spoilerWingGeo));
    car.add(strutL); car.add(strutR);
    car.add(w1); car.add(w2); car.add(w3); car.add(w4);
    car.add(hlL); car.add(hlR);

    // Back Thruster Glow
    const thrusterGeo = new THREE.BoxGeometry(1.8, 0.2, 0.1);
    const thruster = new THREE.Mesh(thrusterGeo, neonMat);
    thruster.position.set(0, 0.5, 2.3);
    car.add(thruster);

    car.position.set(0, -1, 0); // Start position
    return car;
};

const playerCar = createCar();
scene.add(playerCar);


// --- Lighting ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
scene.add(ambientLight);

// Light following the car to highlight it
const carLight = new THREE.PointLight(0xffaa00, 10, 20);
carLight.position.set(0, 2, 0);
playerCar.add(carLight);

// Global directional light
const dirLight = new THREE.DirectionalLight(0xaabbff, 0.5);
dirLight.position.set(100, 100, 50);
scene.add(dirLight);


// --- Obstacles ---
const createObstacle = () => {
    // Determine lane (-1, 0, 1) represents left, middle, right lanes roughly
    const lane = Math.floor(Math.random() * 5) - 2; // -2, -1, 0, 1, 2
    const xPos = lane * laneWidth;

    const isWall = Math.random() > 0.8; // 20% chance of wide wall

    const obGeo = isWall ? new THREE.BoxGeometry(8, 2, 1) : new THREE.BoxGeometry(2, 2, 2);

    const obMat = new THREE.MeshStandardMaterial({
        color: 0x222222,
        roughness: 0.5,
        metalness: 0.5
    });
    const obMesh = new THREE.Mesh(obGeo, obMat);

    // Neon Red Edges for Danger
    const edges = new THREE.EdgesGeometry(obGeo);
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xff0044, linewidth: 2 });
    const obLine = new THREE.LineSegments(edges, edgeMat);
    obMesh.add(obLine);

    // Position far away
    obMesh.position.set(xPos, -0.5, -200);

    scene.add(obMesh);
    obstacles.push(obMesh);
};


// --- Input Handling ---
const keys = { left: false, right: false };
window.addEventListener('keydown', (e) => {
    if (e.code === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.left = true;
    if (e.code === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.right = true;
});
window.addEventListener('keyup', (e) => {
    if (e.code === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.left = false;
    if (e.code === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.right = false;
});


// --- UI Integration ---
const scoreElement = document.getElementById('scoreValue');
const startScreen = document.getElementById('startScreen');
const gameOverScreen = document.getElementById('gameOverScreen');
const finalScoreElement = document.getElementById('finalScore');
const startButton = document.getElementById('startButton');
const restartButton = document.getElementById('restartButton');

const startGame = () => {
    isGameStarted = true;
    isGameOver = false;
    score = 0;
    baseSpeed = 1.0;
    speed = baseSpeed;
    playerCar.position.set(0, -1, 0);
    playerCar.rotation.set(0, 0, 0);

    // Clear existing obstacles
    obstacles.forEach(ob => scene.remove(ob));
    obstacles = [];

    startScreen.classList.add('hidden');
    gameOverScreen.classList.add('hidden');
};

const triggerGameOver = () => {
    isGameOver = true;
    speed = 0; // stop movement
    finalScoreElement.innerText = Math.floor(score);
    gameOverScreen.classList.remove('hidden');
};

startButton.addEventListener('click', startGame);
restartButton.addEventListener('click', startGame);


// --- Game Loop ---
const clock = new THREE.Clock();
let obstacleTimer = 0;
let nextObstacleInterval = 1.0;

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();

    // Always slowly animate stars
    starField.position.z += 5 * delta;
    if (starField.position.z > 200) starField.position.z = 0;

    if (isGameStarted && !isGameOver) {
        // Compute current speed
        speed = baseSpeed + (score * 0.001); // Gradually increase speed
        const moveDist = speed * 100 * delta; // Arbitrary multiplier for feel

        // 1. Move Grid (Road)
        gridGroup.position.z += moveDist;
        if (gridGroup.position.z > 200) {
            gridGroup.position.z -= 200; // Reset for infinite scroll
        }

        // 2. Move Player Car
        if (keys.left && playerCar.position.x > -8) {
            playerCar.position.x -= carSpeedX * delta;
            playerCar.rotation.z = THREE.MathUtils.lerp(playerCar.rotation.z, 0.3, 0.1);
            playerCar.rotation.y = THREE.MathUtils.lerp(playerCar.rotation.y, 0.1, 0.1);
        } else if (keys.right && playerCar.position.x < 8) {
            playerCar.position.x += carSpeedX * delta;
            playerCar.rotation.z = THREE.MathUtils.lerp(playerCar.rotation.z, -0.3, 0.1);
            playerCar.rotation.y = THREE.MathUtils.lerp(playerCar.rotation.y, -0.1, 0.1);
        } else {
            // Return to neutral rotation smoothly
            playerCar.rotation.z = THREE.MathUtils.lerp(playerCar.rotation.z, 0, 0.1);
            playerCar.rotation.y = THREE.MathUtils.lerp(playerCar.rotation.y, 0, 0.1);
        }

        // 3. Spawn Obstacles
        obstacleTimer += delta;
        // Spawn faster as speed increases
        const spawnDelay = Math.max(0.3, 1.5 - (speed * 0.2));
        if (obstacleTimer > spawnDelay) {
            createObstacle();
            obstacleTimer = 0;
        }

        // 4. Update Obstacles and Check Collisions
        // We use a tight bounding box on car for forgiving gameplay
        const carBox = new THREE.Box3().setFromObject(playerCar);
        carBox.expandByScalar(-0.4); // shrink hitbox slightly

        for (let i = obstacles.length - 1; i >= 0; i--) {
            const ob = obstacles[i];
            ob.position.z += moveDist;

            // Collision Detection
            if (ob.position.z > -10 && ob.position.z < 10) { // Only check if close
                const obBox = new THREE.Box3().setFromObject(ob);
                obBox.expandByScalar(-0.2); // shrink obstacle hitbox slightly

                if (carBox.intersectsBox(obBox)) {
                    triggerGameOver();
                    break;
                }
            }

            // Garbage Collection for passed obstacles
            if (ob.position.z > 20) {
                scene.remove(ob);
                obstacles.splice(i, 1);
            }
        }

        // 5. Update Score and Camera effects
        score += moveDist * 0.1;
        scoreElement.innerText = Math.floor(score);

        // Camera shake effect slightly based on speed
        const shake = (Math.random() - 0.5) * speed * 0.05;
        camera.position.x = shake;
        camera.position.y = 4 + shake;
        // Adjust camera FOV slightly to simulate speed (Hyperspace effect)
        camera.fov = THREE.MathUtils.lerp(camera.fov, 75 + speed * 10, 0.05);
        camera.updateProjectionMatrix();

    } else if (isGameOver) {
        // Crash effect - spin car
        playerCar.rotation.y += 5 * delta;
        playerCar.rotation.z += 5 * delta;
        camera.fov = THREE.MathUtils.lerp(camera.fov, 75, 0.1);
        camera.updateProjectionMatrix();
    }

    renderer.render(scene, camera);
}

// Start loop
animate();

// --- Handle Window Resize ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
