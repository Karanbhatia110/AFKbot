const express = require("express");
const mineflayer = require("mineflayer");

const app = express();
const PORT = process.env.PORT || 3000;

// Fake web server so Render doesn't shut down
app.get("/", (req, res) => res.send("AFK bot running"));
app.listen(PORT, () => console.log(`Web server on port ${PORT}`));

// Start AFK bot
function startBot() {
  const bot = mineflayer.createBot({
    host: "__HAVEN__.aternos.me",
    port: 33034,
    username: "AFKBot",
  });

  bot.on("spawn", () =>
    console.log("AFK bot joined and is staying active...")
  );

  // Anti-AFK
  setInterval(() => {
    bot.setControlState("jump", true);
    setTimeout(() => bot.setControlState("jump", false), 500);
  }, 2 * 60 * 1000);

  bot.on("end", () => {
    console.log("Bot disconnected → reconnecting in 10s");
    setTimeout(startBot, 10000);
  });

  bot.on("kicked", (reason) => console.log("Kicked:", reason));
  bot.on("error", (err) => console.log("Error:", err));
}

startBot();


