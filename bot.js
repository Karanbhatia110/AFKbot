const express = require("express");
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const OWNER_NAME = "ZioGod";                 // your exact IGN
const SAFE_POS = new Vec3(285, 91, 2381);   // center of wander area
const WANDER_RADIUS = 15;                   // how far to roam from SAFE_POS
const BOT_USERNAME = "ZioBot";              // bot name

const SERVER_HOST = "__HAVEN__.aternos.me";  // e.g. "ziogod.aternos.me"
const SERVER_PORT = 33034;         // e.g. 25565 or your Aternos port (number)

// Some common hostile mobs (no players)
const HOSTILE_MOBS = new Set([
  "Zombie",
  "Husk",
  "Drowned",
  "Skeleton",
  "Stray",
  "Creeper",
  "Spider",
  "Cave Spider",
  "Enderman",
  "Slime",
  "Magma Cube",
  "Phantom",
  "Witch",
  "Pillager",
  "Vindicator",
  "Evoker",
  "Ravager",
  "Vex",
  "Guardian",
  "Elder Guardian",
  "Silverfish",
  "Endermite",
  "Blaze",
  "Wither Skeleton",
  "Zombie Villager"
]);

// Tiny web server so Render keeps this service alive
app.get("/", (_req, res) => res.send("ZioGod partner/wander bot is running"));
app.listen(PORT, () => console.log(`Web server on port ${PORT}`));

function startBot() {
  const bot = mineflayer.createBot({
    host: SERVER_HOST,
    port: SERVER_PORT,
    username: BOT_USERNAME
  });

  bot.loadPlugin(pathfinder);

  let mcData = null;
  let movements = null;
  let currentMode = "none"; // "partner" or "wander"
  let modeCheckInterval = null;
  let wanderInterval = null;
  let humanLookInterval = null;
  let lastAttackTime = 0;

  // ===== Helper functions =====

  function isOwnerOnline() {
    return !!(bot.players[OWNER_NAME] && bot.players[OWNER_NAME].entity);
  }

  function isHostileMob(entity) {
    if (!entity || entity.type !== "mob") return false;
    const name = (entity.displayName || "").trim();
    return HOSTILE_MOBS.has(name);
  }

  function equipSword() {
    const sword = bot.inventory?.items().find(item =>
      item.name.toLowerCase().includes("sword")
    );
    if (sword) {
      return bot.equip(sword, "hand").catch(() => {});
    }
    return Promise.resolve();
  }

  function attackMob(target) {
    const now = Date.now();
    if (!target) return;
    if (now - lastAttackTime < 600) return; // rate limit
    lastAttackTime = now;

    equipSword()
      .then(() => {
        const aimPos = target.position.offset(0, target.height * 0.5, 0);
        bot.lookAt(aimPos, true, () => {
          bot.attack(target);
        });
      })
      .catch(() => {});
  }

  // Pick a random block near SAFE_POS to walk to
  function randomWanderGoal() {
    const dx = (Math.random() * 2 - 1) * WANDER_RADIUS;
    const dz = (Math.random() * 2 - 1) * WANDER_RADIUS;
    const x = Math.round(SAFE_POS.x + dx);
    const z = Math.round(SAFE_POS.z + dz);
    const y = SAFE_POS.y; // keeps it simple; world should be walkable here
    return new Vec3(x, y, z);
  }

  function setModePartner() {
    if (!movements) return;
    if (!isOwnerOnline()) return;
    if (currentMode === "partner") return;
    currentMode = "partner";
    console.log("[MODE] Partner: owner online, following & defending.");

    const ownerEntity = bot.players[OWNER_NAME].entity;
    const { GoalFollow } = goals;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalFollow(ownerEntity, 2), true);
  }

  function setModeWander() {
    if (!movements) return;
    if (currentMode === "wander") return;
    currentMode = "wander";
    console.log("[MODE] Wander: owner offline, roaming like a player.");

    // Go first near safe pos, then wander
    const { GoalBlock } = goals;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(
      new GoalBlock(SAFE_POS.x, SAFE_POS.y, SAFE_POS.z),
      false
    );
  }

  // ===== Human-like head movement / tiny actions =====

  function startHumanLook() {
    humanLookInterval = setInterval(() => {
      // small random chance to "do something"
      if (Math.random() < 0.4) {
        const yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.8;
        const pitch = bot.entity.pitch + (Math.random() - 0.5) * 0.4;
        bot.look(yaw, pitch, true);
      }

      // sometimes jump a little (looks human)
      if (Math.random() < 0.15) {
        bot.setControlState("jump", true);
        setTimeout(() => {
          bot.setControlState("jump", false);
        }, 350);
      }

      // sometimes swing hand like mining
      if (Math.random() < 0.1) {
        bot.swingArm("right", true);
      }
    }, 3000 + Math.random() * 3000);
  }

  // Wander like a player near SAFE_POS when in wander mode
  function startWanderLoop() {
    wanderInterval = setInterval(() => {
      if (currentMode !== "wander") return;
      const target = randomWanderGoal();
      const { GoalBlock } = goals;
      bot.pathfinder
