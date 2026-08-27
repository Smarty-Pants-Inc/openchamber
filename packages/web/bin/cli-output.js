/**
 * CLI output formatting adapter.
 *
 * Wraps @clack/prompts for structured, beautiful terminal output.
 * Custom formatters (icons, redaction) live here to isolate the
 * formatting dependency from the rest of the CLI.
 */

import {
  intro as clackIntro,
  outro as clackOutro,
  log as clackLog,
  box as clackBox,
  confirm as clackConfirm,
  select as clackSelect,
  text as clackText,
  password as clackPassword,
  spinner,
  progress,
  cancel as clackCancel,
  isCancel,
} from '@clack/prompts';
import { brandText } from '../brand.generated.js';

const intro = (message, ...args) => clackIntro(brandText(message), ...args);
const outro = (message, ...args) => clackOutro(brandText(message), ...args);
const cancel = (message, ...args) => clackCancel(brandText(message), ...args);
const log = Object.fromEntries(['success', 'warn', 'error', 'info', 'step', 'message'].map((method) => [
  method,
  (message, ...args) => clackLog[method](brandText(message), ...args),
]));
const brandPrompt = (options) => typeof options?.message === 'string'
  ? { ...options, message: brandText(options.message) }
  : options;
const box = (message, title, ...args) => clackBox(brandText(message), typeof title === 'string' ? brandText(title) : title, ...args);
const confirm = (options, ...args) => clackConfirm(brandPrompt(options), ...args);
const select = (options, ...args) => clackSelect(brandPrompt(options), ...args);
const text = (options, ...args) => clackText(brandPrompt(options), ...args);
const password = (options, ...args) => clackPassword(brandPrompt(options), ...args);

// ── Provider icons ──────────────────────────────────────────────

const TUNNEL_PROVIDER_ICON = {
  cloudflare: '☁',
};

function formatProviderWithIcon(provider) {
  if (typeof provider !== 'string' || provider.trim().length === 0) {
    return 'unknown';
  }
  const normalized = provider.trim().toLowerCase();
  const icon = TUNNEL_PROVIDER_ICON[normalized];
  return icon ? `${icon} ${normalized}` : normalized;
}

// ── Status-aware log dispatch ───────────────────────────────────

/**
 * Print a status-tagged message using clack log primitives.
 *
 * @param {'success'|'warning'|'error'|'info'|'neutral'} status
 * @param {string} message  Primary line
 * @param {string} [detail] Optional dim secondary line appended after newline
 */
function logStatus(status, message, detail) {
  const full = detail ? `${message}\n${detail}` : message;
  switch (status) {
    case 'success':
      log.success(full);
      break;
    case 'warning':
      log.warn(full);
      break;
    case 'error':
      log.error(full);
      break;
    case 'info':
    case 'neutral':
    default:
      log.info(full);
      break;
  }
}

// ── TTY detection ───────────────────────────────────────────────

/**
 * Whether both stdout and stdin are interactive TTYs.
 * Prompts must be disabled when stdin is piped (e.g. --token-stdin).
 */
const isTTY = Boolean(process.stdout?.isTTY) && Boolean(process.stdin?.isTTY);

function isJsonMode(options) {
  return Boolean(options?.json);
}

function isQuietMode(options) {
  return Boolean(options?.quiet);
}

function shouldRenderHumanOutput(options) {
  return !isJsonMode(options) && !isQuietMode(options);
}

function canPrompt(options) {
  return shouldRenderHumanOutput(options) && isTTY;
}

function createSpinner(options) {
  if (!canPrompt(options)) return null;
  const result = spinner();
  for (const method of ['start', 'stop', 'message', 'error']) {
    const original = result[method].bind(result);
    result[method] = (message, ...args) => original(brandText(message), ...args);
  }
  return result;
}

async function createProgress(options, config) {
  if (!canPrompt(options)) return null;
  const result = await progress(config);
  for (const method of ['start', 'stop', 'message']) {
    const original = result[method].bind(result);
    result[method] = (message, ...args) => original(brandText(message), ...args);
  }
  return result;
}

function printJson(payload) {
  const base = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...payload }
    : { data: payload };

  const messages = Array.isArray(base.messages)
    ? base.messages.map((entry) => typeof entry?.message === 'string' ? { ...entry, message: brandText(entry.message) } : entry)
    : undefined;
  const hasWarning = Boolean(messages?.some((entry) => entry?.level === 'warning'));
  const hasError = Boolean(messages?.some((entry) => entry?.level === 'error'));
  const normalizedStatus = base.status === 'ok' || base.status === 'warning' || base.status === 'error'
    ? base.status
    : (hasError ? 'error' : (hasWarning ? 'warning' : 'ok'));
  if (messages) base.messages = messages;

  const output = {
    status: normalizedStatus,
    ...base,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

export {
  intro,
  outro,
  log,
  box,
  confirm,
  select,
  text,
  password,
  cancel,
  isCancel,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  canPrompt,
  createSpinner,
  createProgress,
  printJson,
  formatProviderWithIcon,
  logStatus,
};
