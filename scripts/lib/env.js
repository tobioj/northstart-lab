import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Read a KEY=value file into a plain object (does not touch process.env). */
export function readEnvFile(path) {
  return parseEnv(readFileSync(path, 'utf8'));
}

/** Pick only NORTHSTAR_* variables from an env object. */
export function northstarOnly(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('NORTHSTAR_')));
}
