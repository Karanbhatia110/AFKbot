require("dotenv").config();
const express = require("express");
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const OWNER_NAME = "ZioGod";                 // your IGN (case-sensitive!)
const SAFE_POS = new Vec3(612, 110, 3324);    // safe / base center
const WANDER_RADIUS = 15;                    // wander range when you're offline
const BOT_USERNAME = "ZioBot";               // bot username

const SERVER_HOST = "__HAVEN__.aternos.me";  // Aternos host
const SERVER_PORT = 33034;                   // Aternos port

// Discord Config
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

// Use sets for O(1) lookups
const HOSTILE_MOBS = new Set([
    "Zombie", "Husk", "Drowned", "Skeleton", "Stray", "Creeper", "Spider", "Cave Spider",
    "Enderman", "Slime", "Magma Cube", "Phantom", "Witch", "Pillager", "Vindicator",
    "Evoker", "Ravager", "Vex", "Guardian", "Elder Guardian", "Silverfish", "Endermite",
    "Blaze", "Wither Skeleton", "Zombie Villager"
]);

const ANIMAL_MOBS = new Set(["Cow", "Sheep", "Pig", "Chicken", "Rabbit"]);

// Tiny web server
app.get("/", (_req, res) => res.send("ZioBot is running"));
app.listen(PORT, () => console.log(`Web server on port ${PORT}`));

// ===== GLOBAL STATE =====
let bot; // The Mineflayer bot instance
let mcData = null;
let movements = null;

// Bot Behavior State
let currentMode = "none"; // "partner" | "wander" | "travel" | "goto" | "stay"
let isTravelingToOwner = false;
let gotoTarget = null; // { x, y, z }
let currentTarget = null;
let initialTravelDistance = 0;
let lastAttackTime = 0;
let tryingToMountBoat = false;
let manualOverride = false; // If true, auto-logic won't switch modes

// Intervals (managed in startBot/end events)
let modeCheckInterval = null;
let wanderInterval = null;
let humanLookInterval = null;
let survivalInterval = null;

// Discord State
let statusMessage = null;

// ===== DISCORD CLIENT (Singleton) =====
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

discordClient.once("ready", () => {
    console.log(`Discord bot logged in as ${discordClient.user.tag}`);
    // Start status update loop independently of Minecraft bot status
    setInterval(updateStatusMessage, 10000);
});

discordClient.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== DISCORD_CHANNEL_ID) return;

    const args = message.content.trim().split(/\s+/);
    const cmd = args[0].toLowerCase();

    // Check if bot is connected before processing commands that require it
    const isBotReady = bot && bot.entity;

    switch (cmd) {
        case "!wander":
            if (!isBotReady) { message.reply("Bot is offline."); return; }
            manualOverride = true; // User explicitly asked to wander
            setModeWander();
            message.reply("Switched to **Wander** mode (Manual Override ON).");
            break;
        case "!stay":
            if (!isBotReady) { message.reply("Bot is offline."); return; }
            manualOverride = true; // User explicitly asked to stay
            setModeStay();
            message.reply("Stopped movement. Mode: **Stay**.");
            break;
        case "!follow":
            if (!isBotReady) { message.reply("Bot is offline."); return; }
            if (isOwnerOnline()) {
                manualOverride = false; // Returning to auto-partner mode
                setModePartner();
                message.reply("Switched to **Partner** mode (Following owner).");
            } else {
                message.reply("Owner is not online!");
            }
            break;
        case "!come":
            if (!isBotReady) { message.reply("Bot is offline."); return; }
            message.reply("Executing COME command...");
            const ownerEntity = bot.players[OWNER_NAME]?.entity;
            if (ownerEntity) {
                startTravelToOwner();
            } else {
                message.reply("Owner entity not found currently.");
            }
            break;
        case "!goto":
            if (!isBotReady) { message.reply("Bot is offline."); return; }
            if (args.length < 4) {
                message.reply("Usage: `!goto <x> <y> <z>`");
                return;
            }
            const tx = parseFloat(args[1]);
            const ty = parseFloat(args[2]);
            const tz = parseFloat(args[3]);
            if (isNaN(tx) || isNaN(ty) || isNaN(tz)) {
                message.reply("Invalid coordinates.");
                return;
            }
            startTravelToTarget(new Vec3(tx, ty, tz));
            message.reply(`Traveling to **${tx}, ${ty}, ${tz}**...`);
            break;
        case "!status":
            await updateStatusMessage();
            message.reply("Status updated.");
            break;
    }
});

discordClient.login(DISCORD_TOKEN).catch(e => console.error("Discord Login Failed:", e));

// ===== HELPER FUNCTIONS =====

function isOwnerOnline() {
    return !!(bot && bot.players && bot.players[OWNER_NAME] && bot.players[OWNER_NAME].entity);
}

function isHostileMob(entity) {
    if (!entity || entity.type !== "mob") return false;
    const name = (entity.displayName || "").trim();
    return HOSTILE_MOBS.has(name);
}

async function equipSword() {
    if (!bot || !bot.inventory) return;
    const sword = bot.inventory.items().find(item =>
        item.name.toLowerCase().includes("sword")
    );
    if (sword) {
        return bot.equip(sword, "hand").catch(() => { });
    }
}

function attackMob(target) {
    if (!bot || !target) return;
    const now = Date.now();
    if (now - lastAttackTime < 600) return; // rate limit
    lastAttackTime = now;

    equipSword()
        .then(() => {
            const aimPos = target.position.offset(0, target.height * 0.5, 0);
            bot.lookAt(aimPos, true, () => {
                bot.attack(target);
            });
        })
        .catch(() => { });
}

function randomWanderGoal() {
    const dx = (Math.random() * 2 - 1) * WANDER_RADIUS;
    const dz = (Math.random() * 2 - 1) * WANDER_RADIUS;
    const x = Math.round(SAFE_POS.x + dx);
    const z = Math.round(SAFE_POS.z + dz);
    const y = SAFE_POS.y;
    return new Vec3(x, y, z);
}

function setModePartner() {
    if (!movements || !isOwnerOnline()) return;
    currentMode = "partner";
    isTravelingToOwner = false;
    gotoTarget = null;
    console.log("[MODE] Partner: owner online, following & defending.");

    const ownerEntity = bot.players[OWNER_NAME].entity;
    const { GoalFollow } = goals;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalFollow(ownerEntity, 2), true);
}

function setModeWander() {
    if (!movements) return;
    currentMode = "wander";
    isTravelingToOwner = false;
    gotoTarget = null;
    console.log("[MODE] Wander: roaming safely.");

    const { GoalBlock } = goals;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(
        new GoalBlock(SAFE_POS.x, SAFE_POS.y, SAFE_POS.z),
        false
    );
}

function setModeStay() {
    currentMode = "stay";
    isTravelingToOwner = false;
    gotoTarget = null;
    if (bot && bot.pathfinder) bot.pathfinder.setGoal(null);
    console.log("[MODE] Stay: stopping movement.");
}

async function startTravelToTarget(targetVec3) {
    if (!bot.entity || !movements) return;

    console.log(`[MODE] Goto request → calculating best path...`);

    // Reset state
    currentTarget = targetVec3;
    isTravelingToOwner = false;
    currentMode = "goto";
    gotoTarget = targetVec3;
    initialTravelDistance = bot.entity.position.distanceTo(currentTarget);

    // Segmented pathfinding removed by user request.
    // Bot will calculate path to the final target immediately.

    bot.pathfinder.setMovements(movements);

    // Try full 3D goal first
    let path = bot.pathfinder.getPathTo(movements, new goals.GoalBlock(
        gotoTarget.x,
        gotoTarget.y,
        gotoTarget.z
    ));

    // If path fails → switch to "XZ smart navigation"
    if (!path || path.status === "noPath") {
        console.log("⚠ No clean 3D path — using smart navigation instead.");
        bot.pathfinder.setGoal(
            new goals.GoalNearXZ(gotoTarget.x, gotoTarget.z, 2),
            false
        );
    } else {
        bot.pathfinder.setGoal(
            new goals.GoalBlock(gotoTarget.x, gotoTarget.y, gotoTarget.z),
            false
        );
    }

    console.log(
        `[MODE] Goto: Traveling safely → ${gotoTarget.x}, ${gotoTarget.y}, ${gotoTarget.z}`
    );
}

function startTravelToOwner() {
    const ownerEntity = bot.players[OWNER_NAME]?.entity;
    if (!ownerEntity) {
        console.log("Owner not found in world → can't travel (yet).");
        return;
    }
    isTravelingToOwner = true;
    currentMode = "travel";
    gotoTarget = null;
    console.log(`[MODE] Traveling to ${OWNER_NAME}...`);

    const { GoalNear } = goals;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(
        new GoalNear(
            ownerEntity.position.x,
            ownerEntity.position.y,
            ownerEntity.position.z,
            2
        )
    );
}

// ===== DISCORD STATUS UPDATER =====
async function updateStatusMessage() {
    if (!discordClient.isReady()) return;

    try {
        const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
        if (!channel) return;

        let statusText = "**STATUS:** Offline / Connecting...";

        if (bot && bot.entity) {
            const pos = bot.entity.position;
            const x = Math.round(pos.x);
            const y = Math.round(pos.y);
            const z = Math.round(pos.z);
            const block = bot.blockAt(pos);
            const biomeName = (block && block.biome) ? block.biome.name : "Unknown";
            const timeOfDay = bot.time.timeOfDay;

            let travelText = "None";
            if (currentMode === "travel" && bot.players[OWNER_NAME]?.entity) {
                const dest = bot.players[OWNER_NAME].entity.position;
                const dist = pos.distanceTo(dest).toFixed(0);
                travelText = `To Owner (${dist}m)`;
            } else if (currentMode === "goto" && gotoTarget) {
                const dist = pos.distanceTo(gotoTarget).toFixed(0);
                travelText = `To ${gotoTarget.x}, ${gotoTarget.y}, ${gotoTarget.z} (${dist}m)`;
            }

            statusText =
                `**MODE:** ${currentMode.toUpperCase()}\n` +
                `**POS:** ${x}, ${y}, ${z}\n` +
                `**BIOME:** ${biomeName}\n` +
                `**TIME:** ${timeOfDay}\n` +
                `**TRAVEL:** ${travelText}`;
        }

        // Find existing pinned status message if not cached
        if (!statusMessage) {
            try {
                const pinned = await channel.messages.fetchPins();
                statusMessage = pinned.find(m => m.author.id === discordClient.user.id);
            } catch (err) {
                console.error("Failed to fetch pins:", err);
            }
        }

        if (statusMessage) {
            if (statusMessage.content !== statusText) {
                await statusMessage.edit(statusText);
            }
        } else {
            const sent = await channel.send(statusText);
            await sent.pin();
            statusMessage = sent;
        }
    } catch (err) {
        console.error("Failed to update status message:", err);
        statusMessage = null; // Reset status message on error to force re-fetch
    }
}

// ===== SURVIVAL / LOGIC LOOPS =====

function startHumanLook() {
    humanLookInterval = setInterval(() => {
        if (!bot || !bot.entity) return;
        if (Math.random() < 0.4) {
            const yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.8;
            const pitch = bot.entity.pitch + (Math.random() - 0.5) * 0.4;
            bot.look(yaw, pitch, true);
        }
        if (Math.random() < 0.15) {
            bot.setControlState("jump", true);
            setTimeout(() => bot.setControlState("jump", false), 350);
        }
        if (Math.random() < 0.1) bot.swingArm("right", true);
    }, 3000 + Math.random() * 3000);
}

function startWanderLoop() {
    wanderInterval = setInterval(() => {
        if (!bot || currentMode !== "wander" || !movements) return;
        const target = randomWanderGoal();
        const { GoalBlock } = goals;
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(
            new GoalBlock(target.x, target.y, target.z),
            false
        );
    }, 8000 + Math.random() * 7000);
}

function getItemCount(predicate) {
    if (!bot || !bot.inventory) return 0;
    return bot.inventory.items().filter(predicate).reduce((a, i) => a + i.count, 0);
}

function findNearbyBlock(typeNames, maxDistance = 10) {
    if (!bot || !bot.entity) return null;
    const origin = bot.entity.position;
    let best = null;
    let bestDist = Infinity;

    for (let y = -2; y <= 2; y++) {
        for (let x = -maxDistance; x <= maxDistance; x++) {
            for (let z = -maxDistance; z <= maxDistance; z++) {
                const pos = origin.offset(x, y, z);
                const block = bot.blockAt(pos);
                if (!block) continue;
                if (!typeNames.includes(block.name)) continue;
                const d = origin.distanceTo(pos);
                if (d < bestDist) {
                    bestDist = d;
                    best = block;
                }
            }
        }
    }
    return best;
}

async function ensureFurnaceNear() {
    const existing = findNearbyBlock(["furnace", "lit_furnace"], 8);
    if (existing) return existing;

    const cobbleCount = getItemCount(i => i.name === "cobblestone");
    if (cobbleCount < 8) return null;

    const craftingTable = findNearbyBlock(["crafting_table"], 8);
    if (!craftingTable) return null;

    try {
        await bot.pathfinder.goto(
            new goals.GoalBlock(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z)
        );
        const furnaceRecipe = bot.recipesFor(mcData.itemsByName.furnace.id, null, 1)[0];
        if (!furnaceRecipe) return null;
        await bot.craft(furnaceRecipe, 1, craftingTable);
        console.log("Crafted a furnace. Please place it manually near SAFE_POS once.");
        return null;
    } catch (e) {
        console.log("Error while crafting furnace:", e.message);
        return null;
    }
}

async function cookFoodIfPossible() {
    const rawItems = bot.inventory.items().filter(i =>
        ["beef", "porkchop", "mutton", "chicken", "rabbit"].includes(i.name)
    );
    if (rawItems.length === 0) return;

    const furnaceBlock = await ensureFurnaceNear();
    if (!furnaceBlock) return;

    let fuel = bot.inventory.items().find(i =>
        ["coal", "charcoal", "oak_log"].includes(i.name) || i.name.includes("planks")
    );
    if (!fuel) return;

    try {
        await bot.pathfinder.goto(
            new goals.GoalBlock(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z)
        );

        const furnace = await bot.openFurnace(furnaceBlock);

        if (!furnace.fuelItem()) {
            await furnace.putFuel(fuel.type, null, 1);
            fuel = null;
        }

        const raw = rawItems[0];
        if (!furnace.inputItem()) {
            await furnace.putInput(raw.type, null, 1);
        }

        console.log("Cooking food in furnace...");
        await new Promise(resolve => setTimeout(resolve, 10000));

        const output = furnace.outputItem();
        if (output) {
            await furnace.takeOutput(output.type, null, output.count);
            console.log("Took cooked food from furnace:", output.name);
        }

        furnace.close();
    } catch (e) {
        console.log("Error handling furnace:", e.message);
    }
}

async function craftArmorIfPossible() {
    const craftingTable = findNearbyBlock(["crafting_table"], 8);
    if (!craftingTable) return;

    const ironCount = getItemCount(i => i.name === "iron_ingot");
    const leatherCount = getItemCount(i => i.name === "leather");
    let recipeItem = null;

    if (ironCount >= 8 && mcData.itemsByName.iron_chestplate) {
        recipeItem = mcData.itemsByName.iron_chestplate;
    } else if (leatherCount >= 8 && mcData.itemsByName.leather_chestplate) {
        recipeItem = mcData.itemsByName.leather_chestplate;
    }

    if (!recipeItem) return;

    try {
        await bot.pathfinder.goto(
            new goals.GoalBlock(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z)
        );
        const recipes = bot.recipesFor(recipeItem.id, null, 1);
        if (!recipes || recipes.length === 0) return;
        await bot.craft(recipes[0], 1, craftingTable);
        console.log("Crafted armor:", recipeItem.name);

        const armorItem = bot.inventory.items().find(i => i.name === recipeItem.name);
        if (armorItem) {
            await bot.equip(armorItem, "torso");
            console.log("Equipped armor:", armorItem.name);
        }
    } catch (e) {
        console.log("Error crafting armor:", e.message);
    }
}

function huntNearestAnimal() {
    // Basic logic: if food is high, don't hunt
    if (bot.food !== undefined && bot.food > 18) return;

    let nearest = null;
    let dist = Infinity;

    for (const id in bot.entities) {
        const e = bot.entities[id];
        if (!e || !e.position || !e.displayName) continue;
        if (!ANIMAL_MOBS.has(e.displayName)) continue;
        const d = bot.entity.position.distanceTo(e.position);
        if (d < dist && d < 30) {
            nearest = e;
            dist = d;
        }
    }

    if (!nearest) return;

    console.log("Hunting animal:", nearest.displayName);
    const { GoalFollow } = goals;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalFollow(nearest, 1.5), false);

    const interval = setInterval(() => {
        if (!nearest || !nearest.position || !bot || !bot.entity) {
            clearInterval(interval);
            return;
        }
        const d = bot.entity.position.distanceTo(nearest.position);
        if (d < 3) {
            attackMob(nearest);
        }
        if (d > 40) {
            clearInterval(interval);
        }
    }, 500);
}

function eatIfHungry() {
    if (!bot || bot.food === undefined) return;
    if (bot.food >= 18) return;

    const foodItem = bot.inventory.items().find(i =>
        ["beef", "porkchop", "mutton", "chicken", "rabbit", "bread", "potato"].some(f => i.name.includes(f))
    );

    if (foodItem) {
        bot.equip(foodItem, "hand").then(() => bot.activateItem()).catch(() => { });
    }
}

async function survivalTick() {
    if (currentMode === "travel" || currentMode === "goto") return;
    eatIfHungry();
    if (bot.food !== undefined && bot.food < 16) {
        huntNearestAnimal();
        await cookFoodIfPossible();
    }
    await craftArmorIfPossible();
}

function checkIfArrivedToOwner() {
    if (!isTravelingToOwner) return;
    const ownerEntity = bot.players[OWNER_NAME]?.entity;
    if (!ownerEntity) return;
    const dist = bot.entity.position.distanceTo(ownerEntity.position);
    if (dist <= 3) {
        isTravelingToOwner = false;
        console.log(`[MODE] Arrived to ${OWNER_NAME}. Switching to partner mode.`);
        setModePartner();
    }
}

function checkGotoArrival() {
    if (currentMode !== "goto" || !gotoTarget) return;
    const dist = bot.entity.position.distanceTo(gotoTarget);
    if (dist < 3) {
        // If we assumed we are done, check if this was just a segment
        if (currentTarget && bot.entity.position.distanceTo(currentTarget) > 5) {
            console.log("[Travel] Segment complete. Recalculating next segment...");
            startTravelToTarget(currentTarget); // Continue to final target
        } else {
            console.log(`[MODE] Arrived at destination ${gotoTarget}. Switching to wander.`);
            setModeWander();
        }
    }
}

async function sitWithOwnerInBoat() {
    const owner = bot.players[OWNER_NAME]?.entity;
    if (!owner || !owner.vehicle) return;

    const boat = bot.entities[owner.vehicle];
    if (!boat) return;

    if (bot.vehicle && bot.vehicle.id === boat.id) return;
    if (tryingToMountBoat) return;

    tryingToMountBoat = true;
    try {
        console.log("Owner is in boat → bot trying to enter...");
        bot.clearControlStates();
        const { GoalNear } = goals;
        await bot.pathfinder.goto(new GoalNear(boat.position.x, boat.position.y, boat.position.z, 1.3));
        await new Promise(r => setTimeout(r, 300));
        if (!bot.vehicle) bot.mount(boat);
    } catch (err) {
        console.log("Boat mount failed:", err.message);
    }
    tryingToMountBoat = false;
}

function leaveBoatIfOwnerLeft() {
    if (!bot.vehicle) return;
    const owner = bot.players[OWNER_NAME]?.entity;
    if (!owner || !owner.vehicle) {
        console.log("Owner left boat → bot leaving boat.");
        bot.dismount();
    }
}

// ===== MAIN BOT START FUNCTION =====

function startBot() {
    bot = mineflayer.createBot({
        host: SERVER_HOST,
        port: SERVER_PORT,
        username: BOT_USERNAME
    });

    bot.loadPlugin(pathfinder);

    bot.on("spawn", () => {
        mcData = require("minecraft-data")(bot.version);
        movements = new Movements(bot, mcData);
        movements = new Movements(bot, mcData);
        movements.allowSprinting = false; // OPTIMIZATION: Disable sprinting to reduce chunk loading
        movements.canDig = false;       // prevents mining through walls
        movements.allowParkour = true;  // allows parkour jumps to climb
        movements.scafoldingBlocks = []; // prevents bridging behavior

        console.log("Bot spawned in world.");

        // Mode Check Loop
        modeCheckInterval = setInterval(() => {
            if (isTravelingToOwner || currentMode === "goto" || currentMode === "stay") return;

            // If user manually set a mode (like !wander), don't auto-switch back to partner
            if (manualOverride) return;

            // Default Auto-Behavior:
            // If owner online -> Partner
            // If owner offline -> Wander
            if (isOwnerOnline()) {
                if (currentMode !== "partner") setModePartner();
            } else {
                if (currentMode !== "wander") setModeWander();
            }
        }, 5000);

        startHumanLook();
        startWanderLoop();

        survivalInterval = setInterval(() => {
            survivalTick().catch(() => { });
        }, 15000);
    });

    bot.on("physicsTick", () => {
        // Attack enemies if in partner mode
        if (currentMode === "partner") {
            const ownerEntity = bot.players[OWNER_NAME]?.entity;
            if (ownerEntity) {
                let nearest = null;
                let nearestDist = Infinity;
                for (const id in bot.entities) {
                    const e = bot.entities[id];
                    if (!isHostileMob(e) || !e.position) continue;
                    const d = Math.min(e.position.distanceTo(ownerEntity.position), e.position.distanceTo(bot.entity.position));
                    if (d < 8 && d < nearestDist) {
                        nearest = e;
                        nearestDist = d;
                    }
                }
                if (nearest) attackMob(nearest);
            }
        }
        checkIfArrivedToOwner();
        checkGotoArrival();
        sitWithOwnerInBoat();
        leaveBoatIfOwnerLeft();
        eatIfHungry(); // Simple frequent check
        // Full hunting/cooking is in survivalTick (slower)
    });

    bot.on("chat", (username, message) => {
        if (username !== OWNER_NAME) return;
        if (message.toLowerCase() === "come") {
            console.log("Come command received via chat...");
            const ownerEntity = bot.players[OWNER_NAME]?.entity;
            if (ownerEntity) {
                startTravelToOwner();
            } else {
                console.log("Owner entity not found immediately.");
            }
        }
    });

    bot.on("death", () => console.log("Bot died → respawning & continuing."));
    bot.on("kicked", reason => console.log("Bot kicked:", reason));
    bot.on("error", err => console.log("Bot error:", err));

    bot.on("end", () => {
        console.log("Bot disconnected → reconnecting in 30s.");
        // Stop all intervals associated with THIS bot instance
        clearInterval(modeCheckInterval);
        clearInterval(wanderInterval);
        clearInterval(humanLookInterval);
        clearInterval(survivalInterval);

        // Schedule restart
        setTimeout(startBot, 30000);
    });
}

// Start Main Loop
startBot();

// Prevent process from crashing on unhandled network errors
process.on('uncaughtException', (err) => {
    console.error("Uncaught Exception:", err);
    // process.exit(1); // Do NOT exit, let the bot try to recover via its own logic
});

process.on('unhandledRejection', (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
