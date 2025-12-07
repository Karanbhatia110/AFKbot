const express = require("express");
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const OWNER_NAME = "ZioGod";                 // your IGN (case-sensitive!)
const SAFE_POS = new Vec3(285, 91, 2381);    // safe / base center
const WANDER_RADIUS = 15;                    // wander range when you're offline
const BOT_USERNAME = "ZioBot";               // bot username

const SERVER_HOST = "__HAVEN__.aternos.me";  // Aternos host
const SERVER_PORT = 33034;                   // Aternos port

// Hostile mobs that bot will attack (never players)
const HOSTILE_MOBS = new Set([
    "Zombie", "Husk", "Drowned", "Skeleton", "Stray", "Creeper", "Spider", "Cave Spider",
    "Enderman", "Slime", "Magma Cube", "Phantom", "Witch", "Pillager", "Vindicator",
    "Evoker", "Ravager", "Vex", "Guardian", "Elder Guardian", "Silverfish", "Endermite",
    "Blaze", "Wither Skeleton", "Zombie Villager"
]);

// Passive mobs (animals for food)
const ANIMAL_MOBS = new Set(["Cow", "Sheep", "Pig", "Chicken", "Rabbit"]);

// Tiny web server so Render keeps this service alive (safe to use locally too)
app.get("/", (_req, res) => res.send("ZioBot is running"));
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
    let currentMode = "none"; // "partner" | "wander" | "travel"
    let modeCheckInterval = null;
    let wanderInterval = null;
    let humanLookInterval = null;
    let lastAttackTime = 0;
    let isTravelingToOwner = false;
    let survivalInterval = null;

    // ===== Helpers =====

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
            return bot.equip(sword, "hand").catch(() => { });
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
        if (!movements) return;
        if (!isOwnerOnline()) return;
        currentMode = "partner";
        console.log("[MODE] Partner: owner online, following & defending.");

        const ownerEntity = bot.players[OWNER_NAME].entity;
        const { GoalFollow } = goals;
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new GoalFollow(ownerEntity, 2), true);
    }

    function setModeWander() {
        if (!movements) return;
        currentMode = "wander";
        console.log("[MODE] Wander: owner offline, roaming safely.");

        const { GoalBlock } = goals;
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(
            new GoalBlock(SAFE_POS.x, SAFE_POS.y, SAFE_POS.z),
            false
        );
    }

    function startHumanLook() {
        humanLookInterval = setInterval(() => {
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
            if (currentMode !== "wander") return;
            const target = randomWanderGoal();
            const { GoalBlock } = goals;
            bot.pathfinder.setMovements(movements);
            bot.pathfinder.setGoal(
                new GoalBlock(target.x, target.y, target.z),
                false
            );
        }, 8000 + Math.random() * 7000);
    }

    async function trySitWithOwner() {
        const owner = bot.players[OWNER_NAME]?.entity;
        if (!owner) return;

        // Look for a boat the owner is riding
        const vehicleId = owner.vehicle;
        if (!vehicleId) return; // owner not in a boat

        const boat = bot.entities[vehicleId];
        if (!boat) return;

        // If bot already in the boat, do nothing
        if (bot.vehicle && bot.vehicle.id === boat.id) return;

        try {
            console.log("Owner is in a boat → entering boat...");
            await bot.pathfinder.goto(new goals.GoalNear(boat.position.x, boat.position.y, boat.position.z, 1));
            bot.mount(boat);
        } catch (err) {
            console.log("Failed to mount boat:", err.message);
        }
    }


    // ===== Long-distance COME travel =====

    function startTravelToOwner() {
        const ownerEntity = bot.players[OWNER_NAME]?.entity;
        if (!ownerEntity) {
            console.log("Owner not found in world → can't travel (yet).");
            return;
        }
        isTravelingToOwner = true;
        currentMode = "travel";
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

    // ===== Survival: eat, hunt, cook, armor =====

    function eatIfHungry() {
        if (bot.food === undefined) return; // some servers don't send hunger
        if (bot.food >= 18) return; // 9 bars+ is fine

        const foodItem = bot.inventory.items().find(i =>
            i.name.includes("beef") ||
            i.name.includes("porkchop") ||
            i.name.includes("mutton") ||
            i.name.includes("chicken") ||
            i.name.includes("rabbit") ||
            i.name.includes("bread") ||
            i.name.includes("potato")
        );

        if (!foodItem) return;

        bot.equip(foodItem, "hand")
            .then(() => {
                bot.activateItem(); // eat
                console.log("Eating:", foodItem.name);
            })
            .catch(() => { });
    }

    function huntNearestAnimal() {
        if (bot.food !== undefined && bot.food > 18) return; // not hungry enough

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

        // simple attack loop when near
        const interval = setInterval(() => {
            if (!nearest || !nearest.position) {
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

    function getItemCount(predicate) {
        return bot.inventory.items().filter(predicate).reduce((a, i) => a + i.count, 0);
    }

    function findNearbyBlock(typeNames, maxDistance = 10) {
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
        // If bot already has a furnace placed nearby or in hotbar, skip.
        const existing = findNearbyBlock(["furnace", "lit_furnace"], 8);
        if (existing) return existing;

        // If has 8 cobblestone, craft furnace using nearby crafting table.
        const cobbleCount = getItemCount(i => i.name === "cobblestone");
        if (cobbleCount < 8) {
            console.log("No furnace and not enough cobblestone to craft one.");
            return null;
        }

        const craftingTable = findNearbyBlock(["crafting_table"], 8);
        if (!craftingTable) {
            console.log("Need crafting table near SAFE_POS to craft furnace.");
            return null;
        }

        try {
            await bot.pathfinder.goto(
                new goals.GoalBlock(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z)
            );
            const furnaceRecipe = bot.recipesFor(mcData.itemsByName.furnace.id, null, 1)[0];
            if (!furnaceRecipe) {
                console.log("No furnace recipe found (version mismatch?).");
                return null;
            }
            await bot.craft(furnaceRecipe, 1, craftingTable);
            console.log("Crafted a furnace. Please place it manually near SAFE_POS once.");
            return null; // we don't auto-place. You place it once; then bot will reuse it.
        } catch (e) {
            console.log("Error while crafting furnace:", e.message);
            return null;
        }
    }

    async function cookFoodIfPossible() {
        const rawItems = bot.inventory.items().filter(i =>
            i.name === "beef" ||
            i.name === "porkchop" ||
            i.name === "mutton" ||
            i.name === "chicken" ||
            i.name === "rabbit"
        );
        if (rawItems.length === 0) return;

        const furnaceBlock = await ensureFurnaceNear();
        if (!furnaceBlock) return;

        let fuel = bot.inventory.items().find(i =>
            i.name === "coal" || i.name === "charcoal" || i.name === "oak_log" || i.name.includes("planks")
        );
        if (!fuel) {
            console.log("No fuel available for furnace.");
            return;
        }

        try {
            await bot.pathfinder.goto(
                new goals.GoalBlock(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z)
            );

            const furnace = await bot.openFurnace(furnaceBlock);

            // Load fuel
            if (!furnace.fuelItem()) {
                await furnace.putFuel(fuel.type, null, 1);
                fuel = null;
            }

            // Cook first raw item
            const raw = rawItems[0];
            if (!furnace.inputItem()) {
                await furnace.putInput(raw.type, null, 1);
            }

            console.log("Cooking food in furnace...");

            // Wait up to ~20 seconds for result
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
        // Simple: try craft iron chestplate or leather chestplate if enough materials
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

            // Equip chestplate
            const armorItem = bot.inventory.items().find(i => i.name === recipeItem.name);
            if (armorItem) {
                await bot.equip(armorItem, "torso");
                console.log("Equipped armor:", armorItem.name);
            }
        } catch (e) {
            console.log("Error crafting armor:", e.message);
        }
    }

    async function survivalTick() {
        // Don't interrupt travel to owner
        if (currentMode === "travel") return;

        eatIfHungry();
        // If still low food, hunt & cook
        if (bot.food !== undefined && bot.food < 16) {
            huntNearestAnimal();
            await cookFoodIfPossible();
        }

        // Try craft armor if materials are available
        await craftArmorIfPossible();
    }

    // ===== Events =====
    // === Ride with owner in boat ===
    let tryingToMountBoat = false;

    async function sitWithOwnerInBoat() {
        const owner = bot.players[OWNER_NAME]?.entity;
        if (!owner) return;

        const boatId = owner.vehicle;
        if (!boatId) return; // Owner is not in a boat

        const boat = bot.entities[boatId];
        if (!boat) return;

        // If bot is already in the boat, do nothing
        if (bot.vehicle && bot.vehicle.id === boat.id) return;

        if (tryingToMountBoat) return;
        tryingToMountBoat = true;

        try {
            console.log("Owner is in boat → bot trying to enter...");
            bot.clearControlStates(); // stop walking/sprinting/jumping

            // Go close to the boat
            const { GoalNear } = goals;
            await bot.pathfinder.goto(new GoalNear(boat.position.x, boat.position.y, boat.position.z, 1.3));

            // Wait until boat hitbox is stable
            await new Promise(r => setTimeout(r, 300));

            if (!bot.vehicle) {
                bot.mount(boat);
                console.log("Bot entered boat.");
            }
        } catch (err) {
            console.log("Boat mount failed:", err.message);
        }

        tryingToMountBoat = false;
    }

    // Leave boat if owner leaves
    function leaveBoatIfOwnerLeft() {
        const owner = bot.players[OWNER_NAME]?.entity;
        if (!bot.vehicle) return;

        const ownerInBoat = owner?.vehicle;
        if (!ownerInBoat) {
            console.log("Owner left boat → bot leaving boat.");
            bot.dismount();
        }
    }


    bot.on("spawn", () => {
        mcData = require("minecraft-data")(bot.version);
        movements = new Movements(bot, mcData);
        movements.allowSprinting = true;

        console.log("Bot spawned in world.");

        modeCheckInterval = setInterval(() => {
            if (isTravelingToOwner) return;
            if (isOwnerOnline()) setModePartner();
            else setModeWander();
        }, 5000);

        startHumanLook();
        startWanderLoop();

        survivalInterval = setInterval(() => {
            survivalTick().catch(() => { });
        }, 15000); // every 15 seconds
    });

    bot.on("physicsTick", () => {
        if (currentMode === "partner") {
            const ownerEntity = bot.players[OWNER_NAME]?.entity;
            if (!ownerEntity) return;

            let nearest = null;
            let nearestDist = Infinity;

            for (const id in bot.entities) {
                const e = bot.entities[id];
                if (!isHostileMob(e) || !e.position) continue;
                const d = Math.min(
                    e.position.distanceTo(ownerEntity.position),
                    e.position.distanceTo(bot.entity.position)
                );
                if (d < 8 && d < nearestDist) {
                    nearest = e;
                    nearestDist = d;
                }
            }

            if (nearest) {
                attackMob(nearest);
            }
        }

        checkIfArrivedToOwner();
        sitWithOwnerInBoat();
        leaveBoatIfOwnerLeft();
        eatIfHungry();
        huntNearestAnimal();

    });

    // Chat commands
    bot.on("chat", (username, message) => {
        console.log("Chat from:", username);
        console.log("Message:", message);

        if (username !== OWNER_NAME) return;

        if (message.toLowerCase() === "come") {
            console.log("Come command received — waiting for owner entity to load...");
            let tries = 0;

            const waitInterval = setInterval(() => {
                const ownerEntity = bot.players[OWNER_NAME]?.entity;
                tries++;

                if (ownerEntity) {
                    clearInterval(waitInterval);
                    console.log("Owner entity detected — starting travel!");
                    startTravelToOwner();
                } else if (tries > 40) {
                    clearInterval(waitInterval);
                    console.log("Owner still not detected — travel cancelled.");
                }
            }, 500);
        }
    });

    bot.on("death", () => console.log("Bot died → respawning & continuing."));
    bot.on("kicked", reason => console.log("Bot kicked:", reason));
    bot.on("error", err => console.log("Bot error:", err));

    bot.on("end", () => {
        console.log("Bot disconnected → reconnecting in 30s.");
        clearInterval(modeCheckInterval);
        clearInterval(wanderInterval);
        clearInterval(humanLookInterval);
        clearInterval(survivalInterval);
        setTimeout(startBot, 30000); // slower retry to avoid Aternos rate limit
    });
}

startBot();
