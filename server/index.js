import { config } from "./config.js";
import { createApp } from "./app.js";

if (!config.hasApiKey) {
  console.warn(
    "\n⚠️  ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.\n",
  );
}

const app = createApp();

app.listen(config.port, () => {
  console.log(
    `\n🎙️  Voice Doc Assistant running at http://localhost:${config.port}\n`,
  );
});
