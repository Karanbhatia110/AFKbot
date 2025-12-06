const mineflayer = require("mineflayer");

function startBot() {
    const bot = mineflayer.createBot({
        host: "__HAVEN__.aternos.me",     // example: example.aternos.me
        port: 33034,            // example: 12345 (default Java = 25565)
        username: "AFKBot",         // offline-mode username
        // For online-mode (premium account), use instead:
        // username: "your_microsoft_email",
        // password: "your_microsoft_password",
    });

    bot.on("spawn", () => {
        console.log("Bot joined the server and is now AFK.");

        // Anti-AFK movement (optional) — walks slightly every 2 minutes
        setInterval(() => {
            bot.setControlState("forward", true);
            setTimeout(() => bot.setControlState("forward", false), 1000);
        }, 2 * 60 * 1000);
    });

    bot.on("end", () => {
        console.log("Bot got disconnected → reconnecting in 10 sec...");
        setTimeout(startBot, 10_000);
    });

    bot.on("kicked", (reason) => console.log("Kicked:", reason));
    bot.on("error", (err) => console.log("Error:", err));
}

startBot();
