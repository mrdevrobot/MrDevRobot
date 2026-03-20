<template>
  <div class="dungeon-wrap">
    <div class="dungeon-terminal">
      <!-- Header bar -->
      <div class="dungeon-titlebar">
        <span class="titlebar-dot titlebar-dot--red" />
        <span class="titlebar-dot titlebar-dot--yellow" />
        <span class="titlebar-dot titlebar-dot--green" />
        <span class="titlebar-title">mrdevrobot@dungeon:~$ ./crawl</span>
      </div>

      <!-- Screen output -->
      <div class="dungeon-screen" ref="screenRef">
        <!-- Intro / title screen -->
        <template v-if="phase === 'intro'">
          <pre class="dungeon-art">{{ ART }}</pre>
          <p class="dline dline--dim">// A terminal dungeon crawler</p>
          <p class="dline dline--dim">// surviving in a world of brackets and semicolons</p>
          <div class="dline" style="margin-top:1rem">
            <span class="dprompt">&gt;</span>
            <span v-if="savedState" class="dtext">
              Hero <span class="dgreen">{{ savedState.name }}</span> found in save file.
              Floor <span class="dgreen">{{ savedState.floor }}</span> · HP <span class="dgreen">{{ savedState.hp }}/{{ savedState.maxHp }}</span> · XP <span class="dgreen">{{ savedState.xp }}</span>
            </span>
            <span v-else class="dtext">No save file found. New adventure awaits.</span>
          </div>
          <div class="dungeon-choices">
            <button class="dchoice" @click="startNew">[ N ] New Game</button>
            <button v-if="savedState" class="dchoice" @click="continueGame">[ C ] Continue</button>
          </div>
        </template>

        <!-- Name entry -->
        <template v-else-if="phase === 'naming'">
          <p class="dline"><span class="dprompt">&gt;</span> <span class="dtext">Enter your hero's name:</span></p>
          <div class="dungeon-input-row">
            <span class="dprompt">&gt;&gt;</span>
            <input
              ref="nameInputRef"
              v-model="nameInput"
              class="dungeon-input"
              maxlength="18"
              spellcheck="false"
              autocomplete="off"
              @keydown.enter="confirmName"
              @keydown.escape="phase = 'intro'"
            />
            <span class="dungeon-cursor" aria-hidden="true">_</span>
          </div>
          <p class="dline dline--dim" style="margin-top:.5rem">// Press ENTER to confirm · ESC to go back</p>
        </template>

        <!-- Main game -->
        <template v-else-if="phase === 'game'">
          <!-- Status bar -->
          <div class="dungeon-status">
            <span class="dgreen">{{ state.name }}</span>
            <span class="dsep">//</span>
            <span>Floor <span class="dgreen">{{ state.floor }}</span></span>
            <span class="dsep">//</span>
            <span>HP <span :class="hpClass">{{ state.hp }}/{{ state.maxHp }}</span></span>
            <span class="dsep">//</span>
            <span>ATK <span class="dgreen">{{ state.atk }}</span></span>
            <span class="dsep">//</span>
            <span>XP <span class="dgreen">{{ state.xp }}</span></span>
            <span class="dsep">//</span>
            <span>Gold <span class="dyellow">{{ state.gold }}</span></span>
          </div>

          <!-- Map -->
          <div class="dungeon-map" aria-label="dungeon map">
            <div v-for="(row, y) in map" :key="y" class="dmap-row">
              <span
                v-for="(cell, x) in row"
                :key="x"
                :class="cellClass(x, y)"
              >{{ cellChar(x, y) }}</span>
            </div>
          </div>

          <!-- Log -->
          <div class="dungeon-log">
            <p v-for="(line, i) in log" :key="i" class="dlog-line" :class="line.cls">
              <span class="dprompt">&gt;</span> {{ line.text }}
            </p>
          </div>

          <!-- Actions -->
          <div v-if="!inCombat" class="dungeon-choices">
            <button class="dchoice" @click="move('n')" :disabled="!canMove('n')">[ W ] North</button>
            <button class="dchoice" @click="move('s')" :disabled="!canMove('s')">[ S ] South</button>
            <button class="dchoice" @click="move('a')" :disabled="!canMove('a')">[ A ] West</button>
            <button class="dchoice" @click="move('d')" :disabled="!canMove('d')">[ D ] East</button>
            <button class="dchoice dchoice--dim" @click="rest" :disabled="state.hp >= state.maxHp">[ R ] Rest</button>
            <button class="dchoice dchoice--dim" @click="phase = 'intro'">[ Q ] Save &amp; Quit</button>
          </div>
          <div v-else class="dungeon-choices">
            <button class="dchoice dchoice--red" @click="attackEnemy">[ F ] Attack</button>
            <button class="dchoice" @click="fleeEnemy">[ X ] Flee</button>
          </div>
        </template>

        <!-- Dead -->
        <template v-else-if="phase === 'dead'">
          <pre class="dungeon-art dungeon-art--red">{{ SKULL }}</pre>
          <p class="dline dline--red">[ GAME OVER ] — {{ state.name }} has fallen on Floor {{ state.floor }}</p>
          <p class="dline dline--dim">// Final XP: {{ state.xp }} · Gold collected: {{ state.gold }}</p>
          <div class="dungeon-choices">
            <button class="dchoice" @click="startNew">[ N ] New Game</button>
          </div>
        </template>

        <!-- Victory -->
        <template v-else-if="phase === 'victory'">
          <pre class="dungeon-art">{{ TROPHY }}</pre>
          <p class="dline dline--green">[ VICTORY ] — {{ state.name }} reached the deepest chamber!</p>
          <p class="dline dline--dim">// XP: {{ state.xp }} · Gold: {{ state.gold }} · Floors cleared: 10</p>
          <div class="dungeon-choices">
            <button class="dchoice" @click="startNew">[ N ] New Run</button>
          </div>
        </template>
      </div>

      <!-- Keyboard hint -->
      <div class="dungeon-hint">
        <span v-if="phase === 'game' && !inCombat">// use W A S D to move · R to rest · Q to quit</span>
        <span v-else-if="phase === 'game' && inCombat">// F to attack · X to flee</span>
        <span v-else>&nbsp;</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'

// ─── ASCII art ───────────────────────────────────────────────────────────────
const ART = `
  ██████╗ ██╗   ██╗███╗   ██╗ ██████╗ ███████╗ ██████╗ ███╗   ██╗
  ██╔══██╗██║   ██║████╗  ██║██╔════╝ ██╔════╝██╔═══██╗████╗  ██║
  ██║  ██║██║   ██║██╔██╗ ██║██║  ███╗█████╗  ██║   ██║██╔██╗ ██║
  ██║  ██║██║   ██║██║╚██╗██║██║   ██║██╔══╝  ██║   ██║██║╚██╗██║
  ██████╔╝╚██████╔╝██║ ╚████║╚██████╔╝███████╗╚██████╔╝██║ ╚████║
  ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝
                    T E R M I N A L   C R A W L E R
`.trim()

const SKULL = `
    ░░░░░░░
   ░ ◉   ◉ ░
   ░  ___  ░
   ░ ╚═══╝ ░
    ░░░░░░░
   YOU DIED`.trim()

const TROPHY = `
      ★
    ╔═══╗
    ║ ♦ ║
    ╚═╦═╝
      ║
   ═══╩═══
  VICTORIOUS`.trim()

// ─── Types ───────────────────────────────────────────────────────────────────
type Dir = 'n' | 's' | 'a' | 'd'
type CellType = 'wall' | 'floor' | 'player' | 'enemy' | 'chest' | 'stairs' | 'visited'

interface Enemy { name: string; hp: number; maxHp: number; atk: number; xpReward: number; gold: number; symbol: string }
interface LogLine { text: string; cls?: string }

interface GameState {
  name: string
  floor: number
  hp: number
  maxHp: number
  atk: number
  xp: number
  gold: number
  px: number
  py: number
}

// ─── Map constants ────────────────────────────────────────────────────────────
const MAP_W = 21
const MAP_H = 11

// ─── Reactive state ──────────────────────────────────────────────────────────
const phase = ref<'intro' | 'naming' | 'game' | 'dead' | 'victory'>('intro')
const nameInput = ref('')
const nameInputRef = ref<HTMLInputElement | null>(null)
const screenRef = ref<HTMLDivElement | null>(null)

const savedState = ref<GameState | null>(null)

const state = reactive<GameState>({
  name: 'Hero', floor: 1, hp: 20, maxHp: 20, atk: 4, xp: 0, gold: 0, px: 1, py: 1
})

const map = ref<CellType[][]>([])
const visited = ref<Set<string>>(new Set())
const currentEnemy = ref<Enemy | null>(null)
const inCombat = ref(false)
const log = ref<LogLine[]>([])

const SAVE_KEY = 'mrdevrobot_dungeon_v1'

// ─── Computed ─────────────────────────────────────────────────────────────────
const hpClass = computed(() => {
  const ratio = state.hp / state.maxHp
  if (ratio <= 0.25) return 'dred'
  if (ratio <= 0.5) return 'dyellow'
  return 'dgreen'
})

// ─── Persistence ─────────────────────────────────────────────────────────────
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return
    savedState.value = JSON.parse(raw) as GameState
  } catch { /* ignore */ }
}

function saveGame() {
  try {
    const snapshot: GameState = { ...state }
    localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot))
  } catch { /* ignore */ }
}

function deleteSave() {
  try { localStorage.removeItem(SAVE_KEY) } catch { /* ignore */ }
}

// ─── Map generation ───────────────────────────────────────────────────────────
function emptyMap(): CellType[][] {
  return Array.from({ length: MAP_H }, () => Array(MAP_W).fill('wall') as CellType[])
}

function carve(m: CellType[][], x: number, y: number) {
  const dirs: [number, number][] = [[0, -2], [0, 2], [-2, 0], [2, 0]]
  shuffle(dirs)
  for (const [dx, dy] of dirs) {
    const nx = x + dx, ny = y + dy
    if (nx > 0 && nx < MAP_W - 1 && ny > 0 && ny < MAP_H - 1 && m[ny][nx] === 'wall') {
      m[y + dy / 2][x + dx / 2] = 'floor'
      m[ny][nx] = 'floor'
      carve(m, nx, ny)
    }
  }
}

function generateMap(floor: number) {
  const m = emptyMap()
  // Start at (1,1) — always odd coords for maze carving
  m[1][1] = 'floor'
  carve(m, 1, 1)

  // Collect all floor cells
  const floors: [number, number][] = []
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++)
      if (m[y][x] === 'floor') floors.push([x, y])

  // Place stairs far from start
  const stairsCell = floors[floors.length - 1]
  m[stairsCell[1]][stairsCell[0]] = 'stairs'

  // Place enemies (2 + floor/2)
  const enemyCount = Math.min(2 + Math.floor(floor / 2), 5)
  const candidates = floors.filter(([x, y]) => !(x === 1 && y === 1) && m[y][x] === 'floor')
  shuffle(candidates)
  for (let i = 0; i < Math.min(enemyCount, candidates.length); i++) {
    const [x, y] = candidates[i]
    m[y][x] = 'enemy'
  }

  // Place chests (1-2)
  const chestCount = rng(1, 2)
  for (let i = enemyCount; i < Math.min(enemyCount + chestCount, candidates.length); i++) {
    const [x, y] = candidates[i]
    if (m[y][x] === 'floor') m[y][x] = 'chest'
  }

  map.value = m
  visited.value = new Set<string>(['1,1'])
}

// ─── Cell rendering ───────────────────────────────────────────────────────────
function cellChar(x: number, y: number): string {
  const px = state.px, py = state.py
  if (x === px && y === py) return '@'
  const key = `${x},${y}`
  if (!visited.value.has(key)) return ' '
  const c = map.value[y][x]
  if (c === 'wall') return '█'
  if (c === 'floor' || c === 'visited') return '·'
  if (c === 'enemy') return currentEnemy.value ? (currentEnemy.value.symbol) : 'E'
  if (c === 'stairs') return '>'
  if (c === 'chest') return '$'
  return '·'
}

function cellClass(x: number, y: number): string {
  const px = state.px, py = state.py
  if (x === px && y === py) return 'dc-player'
  const key = `${x},${y}`
  if (!visited.value.has(key)) return 'dc-fog'
  const c = map.value[y][x]
  if (c === 'wall') return 'dc-wall'
  if (c === 'enemy') return 'dc-enemy'
  if (c === 'stairs') return 'dc-stairs'
  if (c === 'chest') return 'dc-chest'
  return 'dc-floor'
}

// Reveal cells in vision radius around player
function revealAround(px: number, py: number) {
  const radius = 3
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = px + dx, ny = py + dy
      if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H) {
        if (Math.abs(dx) + Math.abs(dy) <= radius + 1) {
          visited.value.add(`${nx},${ny}`)
        }
      }
    }
  }
}

// ─── Movement ─────────────────────────────────────────────────────────────────
const DIR_DELTA: Record<Dir, [number, number]> = { n: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] }

function canMove(dir: Dir): boolean {
  const [dx, dy] = DIR_DELTA[dir]
  const nx = state.px + dx, ny = state.py + dy
  if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) return false
  return map.value[ny][nx] !== 'wall'
}

function move(dir: Dir) {
  if (inCombat.value) return
  const [dx, dy] = DIR_DELTA[dir]
  const nx = state.px + dx, ny = state.py + dy
  if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) return
  const cell = map.value[ny][nx]
  if (cell === 'wall') return

  state.px = nx
  state.py = ny
  revealAround(nx, ny)

  if (cell === 'enemy') triggerCombat(nx, ny)
  else if (cell === 'chest') openChest(nx, ny)
  else if (cell === 'stairs') descend()
  else addLog('Moved ' + { n: 'north', s: 'south', a: 'west', d: 'east' }[dir] + '.', 'dline--dim')

  saveGame()
  scrollLog()
}

// ─── Keyboard handler ─────────────────────────────────────────────────────────
function onKeyDown(e: KeyboardEvent) {
  if (phase.value !== 'game') return
  const key = e.key.toLowerCase()
  if (!inCombat.value) {
    if (key === 'w' || key === 'arrowup') { e.preventDefault(); move('n') }
    else if (key === 's' || key === 'arrowdown') { e.preventDefault(); move('s') }
    else if (key === 'a' || key === 'arrowleft') { e.preventDefault(); move('a') }
    else if (key === 'd' || key === 'arrowright') { e.preventDefault(); move('d') }
    else if (key === 'r') { e.preventDefault(); rest() }
    else if (key === 'q') { e.preventDefault(); phase.value = 'intro'; saveGame() }
  } else {
    if (key === 'f') { e.preventDefault(); attackEnemy() }
    else if (key === 'x') { e.preventDefault(); fleeEnemy() }
  }
}

// ─── Enemies ──────────────────────────────────────────────────────────────────
const ENEMY_POOL = [
  { name: 'Null Pointer', symbol: '?', baseHp: 6,  baseAtk: 2, xpMul: 1,   goldMul: 1 },
  { name: 'Stack Overflow', symbol: 'S', baseHp: 10, baseAtk: 3, xpMul: 1.5, goldMul: 2 },
  { name: 'Race Condition', symbol: 'R', baseHp: 8,  baseAtk: 4, xpMul: 2,   goldMul: 2 },
  { name: 'Memory Leak',    symbol: 'M', baseHp: 14, baseAtk: 3, xpMul: 2,   goldMul: 3 },
  { name: 'Deadlock Dragon',symbol: 'D', baseHp: 20, baseAtk: 5, xpMul: 4,   goldMul: 6 },
]

function spawnEnemy(floor: number): Enemy {
  const tier = Math.min(Math.floor(floor / 2), ENEMY_POOL.length - 1)
  const pool = ENEMY_POOL.slice(0, tier + 1)
  const tmpl = pool[rng(0, pool.length - 1)]
  const scale = 1 + (floor - 1) * 0.25
  const hp = Math.round(tmpl.baseHp * scale)
  const atk = Math.max(1, Math.round(tmpl.baseAtk * scale * 0.8))
  return {
    name: tmpl.name,
    symbol: tmpl.symbol,
    hp, maxHp: hp,
    atk,
    xpReward: Math.round(tmpl.xpMul * floor * 3),
    gold: Math.round(tmpl.goldMul * floor * rng(1, 3))
  }
}

function triggerCombat(ex: number, ey: number) {
  const enemy = spawnEnemy(state.floor)
  currentEnemy.value = enemy
  inCombat.value = true
  addLog(`⚔ ${enemy.name} appears! HP ${enemy.hp} ATK ${enemy.atk}`, 'dline--red')
}

function attackEnemy() {
  if (!currentEnemy.value) return
  const enemy = currentEnemy.value

  // Player attacks
  const pdmg = Math.max(1, state.atk + rng(-1, 2))
  enemy.hp -= pdmg
  addLog(`You hit ${enemy.name} for ${pdmg} dmg. (${Math.max(0, enemy.hp)}/${enemy.maxHp} HP left)`)

  if (enemy.hp <= 0) {
    // Enemy dies
    addLog(`${enemy.name} defeated! +${enemy.xpReward} XP +${enemy.gold} gold`, 'dline--green')
    state.xp += enemy.xpReward
    state.gold += enemy.gold
    // Remove enemy from map
    map.value[state.py][state.px] = 'visited'
    currentEnemy.value = null
    inCombat.value = false
    // Level up check
    checkLevelUp()
    saveGame()
    return
  }

  // Enemy counter-attacks
  const edmg = Math.max(1, enemy.atk + rng(-1, 1))
  state.hp -= edmg
  addLog(`${enemy.name} hits you for ${edmg} dmg. (${state.hp}/${state.maxHp} HP)`, state.hp <= 0 ? 'dline--red' : 'dline--yellow')

  if (state.hp <= 0) {
    state.hp = 0
    inCombat.value = false
    currentEnemy.value = null
    deleteSave()
    phase.value = 'dead'
  }
  saveGame()
}

function fleeEnemy() {
  if (rng(0, 1) === 0) {
    addLog('You escaped!', 'dline--dim')
    inCombat.value = false
    currentEnemy.value = null
    // Move back one step
    const dirs: Dir[] = ['n', 's', 'a', 'd']
    for (const d of dirs) {
      const [dx, dy] = DIR_DELTA[d]
      const nx = state.px + dx, ny = state.py + dy
      if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H && map.value[ny][nx] === 'floor') {
        state.px = nx; state.py = ny; break
      }
    }
  } else {
    const edmg = Math.max(1, (currentEnemy.value?.atk ?? 2) + rng(-1, 1))
    state.hp -= edmg
    addLog(`Flee failed! ${currentEnemy.value?.name} hits you for ${edmg}.`, 'dline--red')
    if (state.hp <= 0) {
      state.hp = 0
      inCombat.value = false
      currentEnemy.value = null
      deleteSave()
      phase.value = 'dead'
    }
  }
  saveGame()
}

// ─── Chest ────────────────────────────────────────────────────────────────────
function openChest(x: number, y: number) {
  const gold = rng(3, 8) * state.floor
  const healRoll = rng(0, 2)
  state.gold += gold
  map.value[y][x] = 'visited'
  let msg = `Chest opened! +${gold} gold`
  if (healRoll === 2) {
    const heal = rng(3, 6)
    state.hp = Math.min(state.maxHp, state.hp + heal)
    msg += ` +${heal} HP`
  }
  addLog(msg, 'dline--yellow')
}

// ─── Stairs ───────────────────────────────────────────────────────────────────
function descend() {
  if (state.floor >= 10) {
    deleteSave()
    phase.value = 'victory'
    return
  }
  state.floor++
  addLog(`You descend to floor ${state.floor}!`, 'dline--green')
  generateMap(state.floor)
  state.px = 1
  state.py = 1
  revealAround(1, 1)
  saveGame()
}

// ─── Rest ─────────────────────────────────────────────────────────────────────
function rest() {
  if (state.hp >= state.maxHp) return
  const heal = Math.max(2, Math.floor(state.maxHp * 0.15))
  state.hp = Math.min(state.maxHp, state.hp + heal)
  addLog(`You rest and recover ${heal} HP. (${state.hp}/${state.maxHp})`, 'dline--dim')
  saveGame()
}

// ─── Level up ─────────────────────────────────────────────────────────────────
function checkLevelUp() {
  const threshold = state.floor * 20
  if (state.xp >= threshold) {
    state.atk += 1
    state.maxHp += 5
    state.hp = Math.min(state.maxHp, state.hp + 5)
    addLog(`LEVEL UP! ATK=${state.atk}, MaxHP=${state.maxHp}`, 'dline--green')
  }
}

// ─── Log helper ──────────────────────────────────────────────────────────────
function addLog(text: string, cls?: string) {
  log.value.push({ text, cls })
  if (log.value.length > 12) log.value.shift()
}

async function scrollLog() {
  await nextTick()
  if (screenRef.value) screenRef.value.scrollTop = screenRef.value.scrollHeight
}

// ─── Game lifecycle ──────────────────────────────────────────────────────────
function startNew() {
  deleteSave()
  nameInput.value = ''
  phase.value = 'naming'
  nextTick(() => nameInputRef.value?.focus())
}

function confirmName() {
  const n = nameInput.value.trim()
  if (!n) return
  Object.assign(state, { name: n, floor: 1, hp: 20, maxHp: 20, atk: 4, xp: 0, gold: 0, px: 1, py: 1 })
  log.value = []
  inCombat.value = false
  currentEnemy.value = null
  generateMap(1)
  revealAround(1, 1)
  addLog(`Welcome, ${n}. The dungeon awaits.`, 'dline--dim')
  phase.value = 'game'
  saveGame()
}

function continueGame() {
  if (!savedState.value) return
  Object.assign(state, savedState.value)
  log.value = []
  inCombat.value = false
  currentEnemy.value = null
  generateMap(state.floor)
  revealAround(state.px, state.py)
  addLog(`Welcome back, ${state.name}. Floor ${state.floor}.`, 'dline--dim')
  phase.value = 'game'
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function rng(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
onMounted(() => {
  loadSave()
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
})

// Auto-save when phase switches back to intro
watch(phase, (val) => {
  if (val === 'intro' && state.name) saveGame()
})
</script>

<style scoped>
/* ─── Wrapper ─────────────────────────────────────────────────── */
.dungeon-wrap {
  display: flex;
  justify-content: center;
  padding: 0 1.25rem;
}

.dungeon-terminal {
  width: 100%;
  max-width: 720px;
  background: #0a0c0a;
  border: 1px solid #2a3a2a;
  box-shadow: 0 0 40px rgba(74, 222, 128, 0.08), 0 4px 24px rgba(0,0,0,0.5);
  font-family: 'Space Mono', monospace;
  font-size: 0.78rem;
  color: #c8e6c9;
  overflow: hidden;
}

/* ─── Title bar ───────────────────────────────────────────────── */
.dungeon-titlebar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  background: #161a16;
  padding: 0.45rem 0.75rem;
  border-bottom: 1px solid #1e281e;
}

.titlebar-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.titlebar-dot--red    { background: #ff5f57; }
.titlebar-dot--yellow { background: #febc2e; }
.titlebar-dot--green  { background: #28c840; }

.titlebar-title {
  font-size: 0.68rem;
  color: #4a5a4a;
  margin-left: 0.5rem;
  letter-spacing: 0.04em;
}

/* ─── Screen ──────────────────────────────────────────────────── */
.dungeon-screen {
  padding: 1rem 1.1rem 0.5rem;
  min-height: 300px;
  max-height: 520px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #2a3a2a #0a0c0a;
}

/* ─── ASCII art ───────────────────────────────────────────────── */
.dungeon-art {
  font-size: clamp(0.38rem, 1.2vw, 0.62rem);
  color: #4ade80;
  line-height: 1.25;
  margin-bottom: 1rem;
  white-space: pre;
  overflow-x: auto;
  text-shadow: 0 0 8px rgba(74,222,128,0.4);
}

.dungeon-art--red { color: #f87171; text-shadow: 0 0 8px rgba(248,113,113,0.4); }

/* ─── Text lines ──────────────────────────────────────────────── */
.dline { margin-bottom: 0.35rem; line-height: 1.55; }
.dline--dim    { color: #4a5a4a; }
.dline--green  { color: #4ade80; }
.dline--yellow { color: #facc15; }
.dline--red    { color: #f87171; }
.dprompt { color: #4ade80; margin-right: 0.4rem; }
.dtext   { color: #c8e6c9; }
.dgreen  { color: #4ade80; }
.dyellow { color: #facc15; }
.dred    { color: #f87171; }

/* ─── Status bar ──────────────────────────────────────────────── */
.dungeon-status {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 0.7rem;
  background: #111611;
  border: 1px solid #1e281e;
  padding: 0.4rem 0.7rem;
  margin-bottom: 0.75rem;
  font-size: 0.72rem;
  letter-spacing: 0.02em;
}

.dsep { color: #2a3a2a; }

/* ─── Map ─────────────────────────────────────────────────────── */
.dungeon-map {
  border: 1px solid #1e281e;
  padding: 0.35rem 0.5rem;
  margin-bottom: 0.75rem;
  background: #060806;
  line-height: 1.35;
  overflow-x: auto;
}

.dmap-row { white-space: pre; display: block; }

.dc-wall   { color: #2a3a2a; }
.dc-floor  { color: #1e281e; }
.dc-fog    { color: #060806; }
.dc-player { color: #4ade80; font-weight: 700; text-shadow: 0 0 6px #4ade80; }
.dc-enemy  { color: #f87171; font-weight: 700; text-shadow: 0 0 6px #f87171; }
.dc-stairs { color: #facc15; font-weight: 700; }
.dc-chest  { color: #fb923c; font-weight: 700; }

/* ─── Log ─────────────────────────────────────────────────────── */
.dungeon-log {
  border-top: 1px solid #1e281e;
  padding-top: 0.5rem;
  margin-bottom: 0.5rem;
  min-height: 2.5rem;
}

.dlog-line {
  font-size: 0.72rem;
  line-height: 1.5;
  color: #c8e6c9;
  margin-bottom: 0.1rem;
}
.dlog-line .dprompt { color: #2a4a2a; }

/* ─── Choices ─────────────────────────────────────────────────── */
.dungeon-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0.75rem 0 0.5rem;
}

.dchoice {
  background: transparent;
  border: 1px solid #2a4a2a;
  color: #4ade80;
  font-family: 'Space Mono', monospace;
  font-size: 0.72rem;
  padding: 0.35rem 0.7rem;
  cursor: pointer;
  letter-spacing: 0.04em;
  transition: background 0.1s, border-color 0.1s, box-shadow 0.1s;
  white-space: nowrap;
}

.dchoice:hover:not(:disabled) {
  background: rgba(74,222,128,0.1);
  border-color: #4ade80;
  box-shadow: 0 0 8px rgba(74,222,128,0.2);
}

.dchoice:disabled {
  opacity: 0.25;
  cursor: default;
}

.dchoice--dim { border-color: #1e281e; color: #4a5a4a; }
.dchoice--dim:hover:not(:disabled) {
  background: rgba(74,222,128,0.05);
  border-color: #2a3a2a;
  color: #c8e6c9;
}

.dchoice--red { border-color: #7f1d1d; color: #f87171; }
.dchoice--red:hover:not(:disabled) {
  background: rgba(248,113,113,0.1);
  border-color: #f87171;
  box-shadow: 0 0 8px rgba(248,113,113,0.2);
}

/* ─── Input ───────────────────────────────────────────────────── */
.dungeon-input-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.5rem 0;
}

.dungeon-input {
  background: transparent;
  border: none;
  border-bottom: 1px solid #4ade80;
  color: #4ade80;
  font-family: 'Space Mono', monospace;
  font-size: 0.82rem;
  outline: none;
  width: 180px;
  padding: 0.15rem 0.1rem;
  letter-spacing: 0.06em;
}

.dungeon-cursor {
  color: #4ade80;
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* ─── Hint bar ────────────────────────────────────────────────── */
.dungeon-hint {
  background: #060806;
  border-top: 1px solid #1e281e;
  padding: 0.3rem 0.75rem;
  font-size: 0.65rem;
  color: #2a4a2a;
  letter-spacing: 0.04em;
  min-height: 1.6rem;
}

/* ─── Scrollbar ───────────────────────────────────────────────── */
.dungeon-screen::-webkit-scrollbar { width: 4px; }
.dungeon-screen::-webkit-scrollbar-track { background: #0a0c0a; }
.dungeon-screen::-webkit-scrollbar-thumb { background: #2a3a2a; border-radius: 2px; }
</style>
