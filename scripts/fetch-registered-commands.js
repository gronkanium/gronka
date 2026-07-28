import { REST, Routes } from 'discord.js';
import { mkdir, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';

dotenv.config();

const prefixArg = process.argv[2]?.toUpperCase();
const usePrefix = prefixArg && ['TEST', 'PROD'].includes(prefixArg);

const envPrefix = usePrefix ? `${prefixArg}_` : '';
const DISCORD_TOKEN = process.env[`${envPrefix}DISCORD_TOKEN`];
const CLIENT_ID = process.env[`${envPrefix}CLIENT_ID`];

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error(
    `missing ${envPrefix}DISCORD_TOKEN or ${envPrefix}CLIENT_ID in environment` +
      (usePrefix ? '' : ' — pass PROD or TEST to read the prefixed vars')
  );
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

const commands = await rest.get(Routes.applicationCommands(CLIENT_ID));

const stripped = commands
  .filter(command => command.type === 1)
  .map(({ name, description, options }) => ({
    name,
    description,
    ...(options ? { options } : {}),
  }));

const outPath = 'temp/registered-commands.json';
await mkdir('temp', { recursive: true });
await writeFile(outPath, JSON.stringify(stripped, null, 2));

console.log(`fetched ${commands.length} registered command(s) -> ${outPath}`);
