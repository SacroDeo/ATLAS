// src/utils/telegram/messageChunks.js
// Safe message chunk splitting for Telegram's 4096 character limit
// Preserves structure, code blocks, URLs, and markdown safety

const TELEGRAM_MAX_LENGTH = 4096;
const SAFE_MARGIN = 50;
const MAX_CHUNKS = 20; // Hard cap — prevents infinite loop on degenerate input

const PROTECTED_PATTERNS = [
  { pattern: /```[\s\S]*?```/g, type: 'codeblock' },
  { pattern: /`[^`\n]+`/g, type: 'inlinecode' },
  { pattern: /https?:\/\/[^\s<>"{}|\\^`[\]]+/g, type: 'url' },
  { pattern: /\*\*[^*]+\*\*/g, type: 'bold' },
  { pattern: /__[^_]+__/g, type: 'italic' },
];

function findProtectedSegments(text) {
  const segments = [];

  for (const { pattern, type } of PROTECTED_PATTERNS) {
    // Reset lastIndex — patterns are module-level with /g flag
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      segments.push({
        start: match.index,
        end: match.index + match[0].length,
        type,
      });
    }
  }

  segments.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && seg.start < last.end) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}

/**
 * Returns a safe split index in [1, maxLength].
 * GUARANTEED to return a positive integer — no undefined, no 0.
 */
function splitAtSafeBoundary(text, maxLength) {
  const protectedSegments = findProtectedSegments(text);

  const isInProtected = (pos) =>
    protectedSegments.some((seg) => pos > seg.start && pos < seg.end);

  // Walk backwards from maxLength looking for a clean boundary
  const scanStart = Math.min(maxLength, text.length);
  for (let i = scanStart; i > Math.max(scanStart - 200, 1); i--) {
    if (isInProtected(i)) continue;
    const char = text[i - 1];
    if (char === '\n' || char === ' ' || char === '.' || char === '!' || char === '?') {
      return i;
    }
  }

  // Fallback: last space
  const lastSpace = text.lastIndexOf(' ', maxLength);
  if (lastSpace > maxLength - 100 && lastSpace > 0) {
    return lastSpace;
  }

  // Hard fallback: just cut — guaranteed positive
  return Math.min(maxLength, text.length);
}

/**
 * Split message into Telegram-safe chunks.
 * Hard cap at MAX_CHUNKS to prevent runaway loops.
 */
function splitMessage(text, options = {}) {
  if (!text || typeof text !== 'string') return [];

  const maxLength = options.maxLength || TELEGRAM_MAX_LENGTH;
  const preserveParagraphs = options.preserveParagraphs !== false;
  const effectiveMax = maxLength - SAFE_MARGIN;

  if (text.length <= effectiveMax) return [text];

  const chunks = [];
  let remaining = text;
  let iterations = 0;

  while (remaining.length > effectiveMax && iterations < MAX_CHUNKS) {
    iterations++;
    let splitIndex;

    if (preserveParagraphs) {
      const paraBreak = remaining.lastIndexOf('\n\n', effectiveMax);
      if (paraBreak > effectiveMax - 200 && paraBreak > 0) {
        splitIndex = paraBreak + 2;
      } else {
        const sentenceBreak = remaining.lastIndexOf('. ', effectiveMax);
        if (sentenceBreak > effectiveMax - 100 && sentenceBreak > 0) {
          splitIndex = sentenceBreak + 2;
        } else {
          splitIndex = splitAtSafeBoundary(remaining, effectiveMax);
        }
      }
    } else {
      splitIndex = splitAtSafeBoundary(remaining, effectiveMax);
    }

    // Paranoia guard: splitIndex must advance remaining forward
    if (!splitIndex || splitIndex <= 0 || splitIndex >= remaining.length) {
      splitIndex = Math.min(effectiveMax, remaining.length);
    }

    let chunk = remaining.slice(0, splitIndex).trim();

    // Fix dangling inline code
    const backtickCount = (chunk.match(/`/g) || []).length;
    if (backtickCount % 2 !== 0) {
      const lastBacktick = chunk.lastIndexOf('`');
      if (lastBacktick > 0) chunk = chunk.slice(0, lastBacktick).trim();
    }

    if (chunk.length > 0) chunks.push(chunk);

    remaining = remaining.slice(splitIndex).trim();
  }

  // Push whatever remains (handles last chunk + MAX_CHUNKS overflow)
  if (remaining.length > 0) {
    chunks.push(remaining.slice(0, effectiveMax).trim());
  }

  return chunks;
}

function prepareMessageChunks(text, options = {}) {
  const chunks = splitMessage(text, options);
  return {
    chunks,
    isChunked: chunks.length > 1,
    originalLength: text.length,
    chunkCount: chunks.length,
  };
}

module.exports = {
  splitMessage,
  prepareMessageChunks,
  TELEGRAM_MAX_LENGTH,
  findProtectedSegments,
};